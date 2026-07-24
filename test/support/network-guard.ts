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
// CUSTOM DNS LOOKUP (fail closed by construction): a caller-supplied `options.lookup`
// could resolve an allowed NAME (`localhost`, an omitted host, …) to a public IP that Node
// then dials directly. The guard cannot verify an arbitrary resolver without cloning the
// caller's options to interpose a re-validating wrapper — a clone that proved impossible to
// get right across every option shape (frozen, prototype-backed, own-enumerable spreads,
// Proxy get-traps). So the guard REFUSES the resolver: a connect to a NAME carrying a custom
// `lookup` is BLOCKED and recorded by name, never cloned or mutated. Only a loopback IP
// LITERAL — which Node never routes through DNS — keeps its custom lookup, as dead code.
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

/**
 * Throws synchronously for a blocked socket target; returns for allowed ones.
 *
 * Fail closed by construction on custom DNS resolvers. The guard cannot verify what an
 * arbitrary `options.lookup` will hand back without cloning the caller's options to slip in
 * a re-validating wrapper — and that clone proved impossible to get right across every option
 * shape (frozen objects, prototype-backed options, own-enumerable `{ ...opts }` spreads, Proxy
 * get-traps). So the guard REFUSES the resolver instead: any connect to an allowed NAME that
 * also carries a custom `lookup` is BLOCKED and recorded by NAME — never cloned, wrapped, or
 * mutated. The sole exception is a genuine loopback IP LITERAL, which Node never routes through
 * DNS (a custom `lookup` on a literal is dead code), so it stays allowed. A connect with no
 * custom lookup keeps the original loopback-allow / non-loopback-block behavior exactly.
 */
function guardSocketArgs(args: unknown[], fromTls = false): void {
  const { host, port, path } = connectTarget(args);
  // A unix-socket / pipe PATH means Node connects to the pipe and performs NO TCP egress — allowed.
  // But Node takes the pipe branch only for a TRUTHY path (`if (options.path && ...)`); a present-but
  // -EMPTY `path: ""` is FALSY, so Node falls THROUGH and DIALS host/port. Treat an empty path as
  // ABSENT (the same falsy-value class as the socket exemption, R6-P1b) so it can never wave a real
  // host dial through. A NON-EMPTY path — numeric string or not — is a genuine pipe to Node (verified),
  // so it stays allowed and never reaches the host checks below.
  if (path !== undefined && path !== "") return;
  // An EXISTING socket is being reused (`tls.connect({ socket })`): Node opens NO new connection and
  // IGNORES host/port/lookup, so there is no egress or DNS to verify — the underlying socket was
  // already subject to the guard when it first connected. This exemption is TLS-ONLY (R6-P1a): only
  // `tls.connect` honors `options.socket`. `net.connect`/`net.createConnection`/`Socket.prototype.connect`
  // IGNORE a `socket` property and STILL dial host/port, so a stray `socket` must NEVER exempt them —
  // consulting it there would let `net.connect({ host, port, socket: {} })` bypass every host check and
  // perform unrecorded non-loopback egress. The `fromTls` flag is set only by the tls.connect wrapper,
  // so the exemption cannot leak into the net.* paths. Allowed BEFORE the name/custom-lookup block, or a
  // valid TLS-over-existing-socket call with a stray `lookup` would be wrongly blocked (R5-P2).
  if (fromTls && hasExistingSocket(args)) return;
  // A TCP connect that OMITS the host (undefined/empty but carries a port) defaults to
  // `localhost` in Node. Resolve the omission to the loopback NAME `localhost` up front so the
  // custom-lookup refusal below covers the implicit-localhost case too (Delta-1); otherwise a
  // custom lookup on an omitted-host connect could resolve the implicit localhost to a public
  // IP that Node dials unrecorded.
  let effectiveHost = host;
  if ((host === undefined || host === "") && port !== null) {
    effectiveHost = "localhost";
  }
  // A custom `lookup` on anything but a loopback IP LITERAL is REFUSED: the guard can neither
  // verify nor safely intercept what an arbitrary resolver returns (that is the cloning trap we
  // deleted), so it fails closed and records the attempt by the NAME the caller supplied — we
  // block BEFORE any resolution, so there is no resolved address to record. An IP literal is
  // exempt because Node short-circuits DNS for it, so the lookup never runs and cannot smuggle
  // anything. This blocks an allowed name (e.g. `localhost`) it previously waved through, which
  // is the intended fail-closed inversion.
  if (hasCustomLookup(args) && !isLoopbackIpLiteral(effectiveHost)) {
    // Record the NAME the caller supplied — the name Node would route through DNS — lowercased but
    // with any brackets KEPT (R5-P1). A bracketed host like `[::1]` is a NAME to Node, not the
    // literal `::1`, so recording it verbatim faithfully names what was blocked rather than
    // bracket-stripping it into the loopback literal it is not.
    const blockedHost = (effectiveHost ?? "localhost").toLowerCase();
    record({ surface: "socket", host: blockedHost, port });
    throw new NetworkBlockedError(
      `Blocked socket egress: refusing an unverifiable custom lookup on ${blockedHost}:${port ?? "?"}`,
    );
  }
  if (isLoopback(effectiveHost)) {
    return; // loopback name or IP literal, no custom lookup — allowed, unrecorded
  }
  const normHost = normalizeHost(effectiveHost as string);
  record({ surface: "socket", host: normHost, port });
  throw new NetworkBlockedError(`Blocked socket egress to ${normHost}:${port ?? "?"}`);
}

/**
 * True when `args[0]` is an options object carrying a custom `lookup` function. A plain
 * property read that honors the prototype chain (matching how Node itself reads options) —
 * never a write, so a frozen or prototype-backed options object is safe to inspect.
 */
function hasCustomLookup(args: unknown[]): boolean {
  const first = args[0];
  if (typeof first !== "object" || first === null) return false;
  const opts = first as { lookup?: unknown };
  return typeof opts.lookup === "function";
}

/**
 * True when `args[0]` is an options object supplying a TRUTHY existing `socket` to wrap — the
 * `tls.connect({ socket })` reuse form, where Node opens no new connection and ignores host/lookup.
 * A present-but-FALSY `socket` (`false`, `null`, `undefined`, `0`, `""`) counts as ABSENT (R6-P1b):
 * Node's `tls.connect` decides with `if (!options.socket)`, so a falsy socket makes it CREATE and
 * connect a NEW socket — unrecorded egress if we exempted it. Only a truthy socket suppresses the
 * dial. A plain, prototype-honoring read (matching how Node reads options), never a write, so a
 * frozen or prototype-backed options object is safe to inspect.
 */
function hasExistingSocket(args: unknown[]): boolean {
  const first = args[0];
  if (typeof first !== "object" || first === null) return false;
  const opts = first as { socket?: unknown };
  return Boolean(opts.socket);
}

/**
 * True only for a genuine loopback IP LITERAL that Node itself recognizes as one — classified
 * against the RAW host, with NO bracket-stripping, EXACTLY as Node does (R5-P1). Node short-circuits
 * DNS only for a real literal, so a custom `lookup` on one is dead code and stays allowed. A
 * bracketed host is a NAME to Node, not a literal (`net.isIP("[::1]") === 0`): Node routes it through
 * the custom resolver, so it must NOT be exempt here — stripping brackets first would wrongly wave
 * `[::1]` (or any bracketed IP) through and let a custom lookup dial a public address unrecorded.
 * Every NAME (including `localhost`, the omitted→localhost case, and any bracketed literal) is
 * therefore re-resolvable and refused when it carries a custom lookup. `isLoopback` still normalizes
 * internally for the loopback comparison; only `net.isIP` must see the raw host to match Node.
 */
function isLoopbackIpLiteral(host: string | undefined): boolean {
  if (host === undefined) return false;
  return netModule.isIP(host) !== 0 && isLoopback(host);
}

/**
 * `fromTls` is set ONLY by the tls.connect wrapper. It gates the socket-reuse exemption so it can
 * never leak into `net.connect`/`net.createConnection`/`Socket.prototype.connect`, which ignore
 * `options.socket` and still dial host/port (R6-P1a).
 */
function makeGuardedConnect<F>(original: F, fromTls = false): F {
  const originalFn = original as unknown as (...a: unknown[]) => unknown;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    guardSocketArgs(args, fromTls);
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
  // Only the tls.connect wrapper carries `fromTls`, so the socket-reuse exemption is TLS-only (R6-P1a).
  patch(tlsModule, "connect", makeGuardedConnect(originalTlsConnect, true));
}
