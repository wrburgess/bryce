// network-guard.ts — a fail-closed, dependency-free network-egress guard for the
// default Vitest suite (issue #25).
//
// The suite asserts "tests must never hit the network" (vitest.config.ts) — this
// module ENFORCES it. It installs interceptors on the two in-process egress
// surfaces every provider dials out through:
//
//   • fetch surface  — `globalThis.fetch` (MLB, NCAA, Postmark all default to it).
//   • socket surface — `net.connect`/`net.createConnection`, `net.Socket.prototype.connect`,
//                      and `tls.connect` (nodemailer's raw SMTP socket, and undici's
//                      real connections when `fetch` follows a redirect internally).
//
// Loopback (in-process HTTP servers / MCP transports) is allowed; every non-loopback
// attempt is BOTH thrown as a `NetworkBlockedError` AND recorded as a redacted
// `{ surface, host, port }` record. The recorded buffer is what defeats provider
// fail-open catch blocks (`postmark.ts` lookup, `MlbClient.findPerson`) that would
// otherwise swallow the thrown error: the teardown assertion fails the owning test
// even when the throw was absorbed.
//
// SCOPE (issue #25 MF2): this covers IN-PROCESS `fetch` + TCP/TLS socket egress only.
// Child processes (they do not inherit Vitest `setupFiles`), UDP/`dgram`, and DNS
// resolution are out of scope — DNS is blocked implicitly because the guard throws
// at `connect` before Node dials, and no provider issues a data-carrying request
// without a connect.
//
// IMPLEMENTATION NOTE: Node core `net`/`tls` exports are mutable at runtime (unlike
// read-only ESM namespace bindings), so the interceptors are patched in place on the
// real module objects (obtained via `createRequire`). Install is idempotent via a
// process-global `Symbol.for("bryce.network-guard")` marker, so reused Vitest workers
// (which re-evaluate this module per test file) never stack wrappers — the originals
// and the attempts buffer live on the marker, shared across every re-evaluation.

import { createRequire } from "node:module";
import type net from "node:net";
import type tls from "node:tls";

const nodeRequire = createRequire(import.meta.url);
const netModule = nodeRequire("node:net") as typeof net;
const tlsModule = nodeRequire("node:tls") as typeof tls;

/** Thrown when a test reaches for a non-loopback destination on either surface. */
export class NetworkBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkBlockedError";
  }
}

/**
 * The ONLY thing retained about a blocked attempt. Deliberately redacted: never a
 * full URL, query string, request body, headers, socket/TLS options, certificate,
 * or key — so a teardown failure message can never leak the Postmark server token
 * or any other credential (rules/security.md).
 */
export interface NetworkAttempt {
  surface: "fetch" | "socket";
  host: string | null;
  port: number | null;
}

type OriginalFetch = typeof globalThis.fetch;
type FetchInput = Parameters<OriginalFetch>[0];
type SocketConnect = typeof net.connect;
type TlsConnect = typeof tls.connect;
type ProtoConnect = typeof net.Socket.prototype.connect;

interface GuardState {
  attempts: NetworkAttempt[];
  originalFetch: OriginalFetch;
  originalNetConnect: SocketConnect;
  originalNetCreateConnection: SocketConnect;
  originalSocketConnect: ProtoConnect;
  originalTlsConnect: TlsConnect;
}

const MARKER = Symbol.for("bryce.network-guard");

type GlobalWithMarker = { [key: symbol]: unknown };

function readMarker(): GuardState | undefined {
  return (globalThis as unknown as GlobalWithMarker)[MARKER] as GuardState | undefined;
}

function writeMarker(state: GuardState): void {
  (globalThis as unknown as GlobalWithMarker)[MARKER] = state;
}

function state(): GuardState {
  const s = readMarker();
  if (s === undefined) {
    throw new Error("network guard is not installed — call installNetworkGuard() first");
  }
  return s;
}

/** In-place assignment that ignores a `readonly` declaration on a core module member. */
function patch<T, K extends keyof T>(obj: T, key: K, value: T[K]): void {
  (obj as { [P in K]: T[K] })[key] = value;
}

/**
 * Loopback (or absent/unix) destinations are always allowed so in-process servers
 * and MCP transports keep working. Covers `undefined`/`""`, `localhost`, the whole
 * `127.0.0.0/8` block, IPv6 `::1` (bracketed or not), the IPv4-mapped IPv6 loopback
 * `::ffff:127.*`, and `0.0.0.0` (which dials localhost on connect). Case-insensitive.
 */
export function isLoopback(host: string | undefined | null): boolean {
  if (host === undefined || host === null || host === "") return true;
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost") return true;
  if (h === "::1") return true;
  if (h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true;
  if (h.startsWith("::ffff:") && /^127\./.test(h.slice("::ffff:".length))) return true;
  return false;
}

/** Strip IPv6 brackets and lowercase, for the redacted record. */
function normalizeHost(host: string): string {
  const h = host.toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

function record(attempt: NetworkAttempt): void {
  state().attempts.push(attempt);
}

/** Peek at the recorded attempts without draining them. */
export function attempts(): NetworkAttempt[] {
  return [...state().attempts];
}

/** Drain and return the recorded attempts — canaries call this to consume their expected attempts. */
export function takeAttempts(): NetworkAttempt[] {
  return state().attempts.splice(0);
}

/** Clear the recorded attempts in place (preserving the buffer the interceptors hold). */
export function resetAttempts(): void {
  state().attempts.length = 0;
}

/**
 * Throw if any unapproved attempt is buffered, listing the redacted records. The
 * teardown backstop: it fails the owning test even when the thrown `NetworkBlockedError`
 * was swallowed by a provider's fail-open catch block.
 */
export function assertNoUnapprovedAttempts(): void {
  const buffered = state().attempts;
  if (buffered.length === 0) return;
  const lines = buffered.map((a) => `  - ${a.surface} ${a.host ?? "?"}:${a.port ?? "?"}`).join("\n");
  throw new NetworkBlockedError(
    `Unapproved network egress attempt(s) during this test:\n${lines}\n` +
      "Inject a fake transport, or move the case to the *.live.test.ts tier (npm run test:live).",
  );
}

// --- fetch surface -----------------------------------------------------------

/** Normalize a fetch target (`string | URL | Request`) to a URL, or null when unparseable. */
function fetchTargetUrl(input: FetchInput): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url);
    const maybe = input as { url?: unknown; href?: unknown };
    if (typeof maybe.url === "string") return new URL(maybe.url);
    if (typeof maybe.href === "string") return new URL(maybe.href);
  } catch {
    return null;
  }
  return null;
}

function makeGuardedFetch(original: OriginalFetch): OriginalFetch {
  return async function guardedFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
    const url = fetchTargetUrl(input);
    // Non-network schemes (data:, blob:, file:) and anything unparseable pass
    // through to the native fetch — the guard only blocks http(s) egress.
    if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return original(input, init);
    }
    const host = normalizeHost(url.hostname);
    if (isLoopback(host)) {
      return original(input, init);
    }
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    record({ surface: "fetch", host, port });
    throw new NetworkBlockedError(`Blocked fetch egress to ${host}:${port}`);
  };
}

// --- socket surface ----------------------------------------------------------

/** Extract the destination from any `connect`/`createConnection`/`tls.connect` overload. */
function connectTarget(args: unknown[]): { host: string | undefined; port: number | null; path: string | undefined } {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const opts = first as { host?: unknown; port?: unknown; path?: unknown };
    const host = typeof opts.host === "string" ? opts.host : undefined;
    const path = typeof opts.path === "string" ? opts.path : undefined;
    const port =
      typeof opts.port === "number" ? opts.port : typeof opts.port === "string" ? Number(opts.port) : null;
    return { host, port, path };
  }
  if (typeof first === "string") {
    // A numeric string is a port (net.connect("443", host)); anything else is a
    // unix-socket / pipe PATH (net.connect("/tmp/x.sock")) — allowed, no host.
    if (first !== "" && !Number.isNaN(Number(first))) {
      const host = typeof args[1] === "string" ? args[1] : undefined;
      return { host, port: Number(first), path: undefined };
    }
    return { host: undefined, port: null, path: first };
  }
  if (typeof first === "number") {
    const host = typeof args[1] === "string" ? args[1] : undefined;
    return { host, port: first, path: undefined };
  }
  return { host: undefined, port: null, path: undefined };
}

/** Throws synchronously for a non-loopback socket target; returns for allowed ones. */
function guardSocketArgs(args: unknown[]): void {
  const { host, port, path } = connectTarget(args);
  if (path !== undefined) return; // unix socket / pipe — no host, allowed
  if (isLoopback(host)) return; // loopback or absent host — allowed
  const normHost = normalizeHost(host as string);
  record({ surface: "socket", host: normHost, port });
  throw new NetworkBlockedError(`Blocked socket egress to ${normHost}:${port ?? "?"}`);
}

function makeGuardedConnect<F>(original: F): F {
  const originalFn = original as unknown as (...a: unknown[]) => unknown;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    guardSocketArgs(args);
    return originalFn.apply(this, args);
  };
  return wrapper as unknown as F;
}

/**
 * Install the guard on both surfaces. Idempotent: a second call in the same worker
 * (module re-evaluation across test files) is a no-op, so wrappers never stack.
 */
export function installNetworkGuard(): void {
  if (readMarker() !== undefined) return;

  const originalFetch = globalThis.fetch;
  const originalNetConnect = netModule.connect;
  const originalNetCreateConnection = netModule.createConnection;
  const originalSocketConnect = netModule.Socket.prototype.connect;
  const originalTlsConnect = tlsModule.connect;

  writeMarker({
    attempts: [],
    originalFetch,
    originalNetConnect,
    originalNetCreateConnection,
    originalSocketConnect,
    originalTlsConnect,
  });

  globalThis.fetch = makeGuardedFetch(originalFetch);
  patch(netModule, "connect", makeGuardedConnect(originalNetConnect));
  patch(netModule, "createConnection", makeGuardedConnect(originalNetCreateConnection));
  patch(netModule.Socket.prototype, "connect", makeGuardedConnect(originalSocketConnect));
  patch(tlsModule, "connect", makeGuardedConnect(originalTlsConnect));
}
