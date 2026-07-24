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
  // Only a GENUINE 127/8 IPv4 literal (dotted quad) is loopback — never a hostname
  // that merely *starts with* "127." A name like "127.attacker.com" is a valid DNS
  // record that can resolve to a public address, so a textual-prefix match would let
  // it slip past the guard. `net.isIP === 4` confirms a real dotted-quad literal.
  if (netModule.isIP(h) === 4 && h.startsWith("127.")) return true;
  // IPv4-mapped IPv6 loopback (`::ffff:127.x`): the mapped tail must itself be a real
  // 127/8 IPv4 literal, not just a "127."-prefixed string (`::ffff:127.attacker.com`).
  if (h.startsWith("::ffff:")) {
    const tail = h.slice("::ffff:".length);
    if (netModule.isIP(tail) === 4 && tail.startsWith("127.")) return true;
  }
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
  // A TCP connect that OMITS the host (undefined/empty but carries a port) defaults to
  // `localhost` in Node — and Node still runs any custom `lookup` against that implicit
  // name. Resolve the omission to the loopback NAME `localhost` *before* the lookup check
  // so the hardening below applies; otherwise a custom lookup on an omitted-host connect
  // could resolve the implicit localhost to a public IP that Node dials unrecorded (Delta-1).
  let effectiveHost = host;
  if ((host === undefined || host === "") && port !== null) {
    effectiveHost = "localhost";
  }
  if (isLoopback(effectiveHost)) {
    // Allowed because the host is loopback/absent. But an allowed *name* (not an IP
    // literal) still goes through DNS: a caller-supplied `options.lookup` could resolve
    // it to a non-loopback address that Node then dials directly, never re-entering this
    // wrapper. Harden any such lookup so every resolved address is re-validated.
    hardenCustomLookup(args, effectiveHost, port);
    return;
  }
  const normHost = normalizeHost(effectiveHost as string);
  record({ surface: "socket", host: normHost, port });
  throw new NetworkBlockedError(`Blocked socket egress to ${normHost}:${port ?? "?"}`);
}

type LookupCallback = (err: Error | null, address?: unknown, family?: number) => void;
type LookupFn = (hostname: string, options: unknown, callback: LookupCallback) => void;

/** Custom `lookup` fns we've already wrapped, so a re-entrant connect never stacks wrappers. */
const guardedLookups = new WeakSet<object>();

/**
 * Close the "resolve-an-allowed-name-to-a-public-IP" bypass (issue #25). When a connect
 * is allowed only because the host is an allowed NAME (not an IP literal) and the caller
 * supplied a custom DNS `lookup`, hand the original connect a DERIVED copy of the options
 * whose `lookup` is a wrapper that re-validates EVERY resolved address through `isLoopback`
 * (never mutating the caller's own object — it may be frozen). A non-loopback result is
 * recorded as a redacted `socket` attempt (the resolved IP — never the name, MF7) and the
 * connection is failed closed, instead of Node silently dialing the smuggled address.
 * IP literals never trigger DNS, and a connect without a custom lookup is left untouched.
 */
function hardenCustomLookup(args: unknown[], host: string | undefined, port: number | null): void {
  if (host === undefined || netModule.isIP(host) !== 0) return; // IP literal → no DNS lookup
  const first = args[0];
  if (typeof first !== "object" || first === null) return;
  const opts = first as { lookup?: unknown };
  if (typeof opts.lookup !== "function") return;
  const originalLookup = opts.lookup as LookupFn;
  if (guardedLookups.has(originalLookup)) return; // already hardened — don't re-wrap
  const guardedLookup: LookupFn = function (hostname, lookupOptions, callback): void {
    originalLookup(hostname, lookupOptions, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }
      // Node uses two callback shapes: (err, address, family) and — when the resolver
      // is asked with `{ all: true }` (Node's default connect path) — (err, [{ address,
      // family }, ...]). Validate whichever came back; a single leak fails the connect.
      const resolved: unknown[] = Array.isArray(address) ? address : [address];
      for (const entry of resolved) {
        let addr: string | undefined;
        if (typeof entry === "string") addr = entry;
        else if (typeof entry === "object" && entry !== null) {
          const value = (entry as { address?: unknown }).address;
          addr = typeof value === "string" ? value : undefined;
        }
        if (addr !== undefined && !isLoopback(addr)) {
          const normAddr = normalizeHost(addr);
          record({ surface: "socket", host: normAddr, port });
          callback(new NetworkBlockedError(`Blocked socket egress to ${normAddr}:${port ?? "?"}`));
          return;
        }
      }
      callback(err, address, family);
    });
  };
  guardedLookups.add(guardedLookup);
  // Hand the original connect a DERIVED options object that overrides only `lookup`, without
  // mutating the caller's own object. The three downstream Node APIs read options TWO different
  // ways, so the copy must satisfy BOTH:
  //   • `net.connect` reads the target via PROPERTY ACCESS (`options.host`) — the prototype chain
  //     is honored, so a prototype-backed `opts` (`Object.create({ host, port, lookup })`) must
  //     keep resolving through inheritance (D3).
  //   • `tls.connect` and the `net.Socket` constructor copy options with an OWN-ENUMERABLE spread
  //     (`{ ...opts }`) — anything behind a prototype is LOST: host/port/certs make tls throw
  //     `ERR_MISSING_ARGS`, and `signal`/`keepAlive` are silently dropped (D4).
  // `getOwnPropertyDescriptors(opts)` copies every OWN property (enumerable AND non-enumerable)
  // WITH its descriptor, and `getPrototypeOf(opts)` preserves the chain, so `wrapped` exposes the
  // caller's own props as its OWN props (surviving the spread) AND still inherits the rest
  // (surviving property access). A shallow spread `{ ...opts }` dropped inherited/non-enumerable
  // fields (D3); `Object.create(opts)` parked the caller's own props behind the prototype where the
  // spread could not see them (D4) — this descriptor+prototype copy ends both failure modes.
  // Overriding `descriptors.lookup` BEFORE `Object.create` replaces that entry in the descriptor
  // map, so even a FROZEN `opts` (whose own `lookup` descriptor is non-writable/non-configurable)
  // is handled without ever writing to the caller's object (Delta-2).
  const descriptors = Object.getOwnPropertyDescriptors(opts);
  descriptors.lookup = { value: guardedLookup, writable: true, enumerable: true, configurable: true };
  const wrapped = Object.create(Object.getPrototypeOf(opts), descriptors) as typeof opts;
  args[0] = wrapped;
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
