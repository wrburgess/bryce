import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const networkEnabled = (process.env.BRYCE_TEST_ALLOW_NETWORK ?? "") === "1";

if (!networkEnabled) {
  const blocked = (path: string, target?: string): never => {
    throw blockedError(path, target);
  };

  const blockedHttpRequest = ((...args: unknown[]) =>
    blocked("http.request", describeHttpTarget(args[0]))) as typeof http.request;
  const blockedHttpGet = ((...args: unknown[]) =>
    blocked("http.get", describeHttpTarget(args[0]))) as typeof http.get;
  const blockedHttpsRequest = ((...args: unknown[]) =>
    blocked("https.request", describeHttpTarget(args[0]))) as typeof https.request;
  const blockedHttpsGet = ((...args: unknown[]) =>
    blocked("https.get", describeHttpTarget(args[0]))) as typeof https.get;
  const blockedDnsLookup = ((...args: unknown[]) =>
    blocked("dns.lookup", String(args[0] ?? "unknown-host"))) as unknown as typeof dns.lookup;
  const blockedDnsResolve = ((...args: unknown[]) =>
    blocked("dns.resolve", String(args[0] ?? "unknown-host"))) as unknown as typeof dns.resolve;
  const blockedDnsResolve4 = ((...args: unknown[]) =>
    blocked("dns.resolve4", String(args[0] ?? "unknown-host"))) as unknown as typeof dns.resolve4;
  const blockedDnsResolve6 = ((...args: unknown[]) =>
    blocked("dns.resolve6", String(args[0] ?? "unknown-host"))) as unknown as typeof dns.resolve6;
  const blockedNetConnect = ((...args: unknown[]) =>
    blocked("net.connect", describeSocketTarget(args[0], args[1]))) as typeof net.connect;
  const blockedNetCreateConnection = ((...args: unknown[]) =>
    blocked("net.createConnection", describeSocketTarget(args[0], args[1]))) as typeof net.createConnection;
  const blockedTlsConnect = ((...args: unknown[]) =>
    blocked("tls.connect", describeSocketTarget(args[0], args[1]))) as typeof tls.connect;

  globalThis.fetch = (input, _init) =>
    Promise.reject(blockedError("fetch", describeFetchTarget(input)));

  http.request = blockedHttpRequest;
  http.get = blockedHttpGet;
  https.request = blockedHttpsRequest;
  https.get = blockedHttpsGet;
  dns.lookup = blockedDnsLookup;
  dns.resolve = blockedDnsResolve;
  dns.resolve4 = blockedDnsResolve4;
  dns.resolve6 = blockedDnsResolve6;
  dns.promises.lookup = ((hostname: string) =>
    Promise.reject(blockedError("dns.promises.lookup", hostname))) as typeof dns.promises.lookup;
  dns.promises.resolve = ((hostname: string) =>
    Promise.reject(blockedError("dns.promises.resolve", hostname))) as typeof dns.promises.resolve;
  dns.promises.resolve4 = ((hostname: string) =>
    Promise.reject(blockedError("dns.promises.resolve4", hostname))) as typeof dns.promises.resolve4;
  dns.promises.resolve6 = ((hostname: string) =>
    Promise.reject(blockedError("dns.promises.resolve6", hostname))) as typeof dns.promises.resolve6;
  net.connect = blockedNetConnect;
  net.createConnection = blockedNetCreateConnection;
  tls.connect = blockedTlsConnect;
  net.Socket.prototype.connect = ((...args: unknown[]) =>
    blocked("net.Socket.connect", describeSocketTarget(args[0], args[1]))) as unknown as typeof net.Socket.prototype.connect;
}

function blockedError(path: string, target?: string): Error {
  return new Error(
    `Network egress is disabled in tests (${path}${target === undefined ? "" : ` -> ${target}`}). ` +
      "Use BRYCE_TEST_ALLOW_NETWORK=1 for explicitly scoped contract smoke tests.",
  );
}

function describeFetchTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input) {
    const value = (input as { url?: unknown }).url;
    if (typeof value === "string") return value;
  }
  return "unknown-target";
}

function describeHttpTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null) {
    const options = input as { protocol?: unknown; host?: unknown; hostname?: unknown; path?: unknown };
    const protocol = typeof options.protocol === "string" ? options.protocol : "http:";
    const host =
      typeof options.host === "string"
        ? options.host
        : typeof options.hostname === "string"
          ? options.hostname
          : "unknown-host";
    const path = typeof options.path === "string" ? options.path : "";
    return `${protocol}//${host}${path}`;
  }
  return "unknown-target";
}

function describeSocketTarget(first: unknown, second: unknown): string {
  if (typeof first === "number") {
    const host = typeof second === "string" ? second : "unknown-host";
    return `${host}:${first}`;
  }
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null) {
    const options = first as { port?: unknown; host?: unknown; path?: unknown };
    if (typeof options.path === "string") return options.path;
    const port = typeof options.port === "number" ? options.port : "unknown-port";
    const host = typeof options.host === "string" ? options.host : "unknown-host";
    return `${host}:${port}`;
  }
  return "unknown-target";
}
