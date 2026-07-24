import type { AddressInfo } from "node:net";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MlbClient } from "../src/mlb/client.js";
import { NcaaClient } from "../src/ncaa/client.js";
import { PostmarkMailer } from "../src/mailer/postmark.js";
import { SmtpMailer } from "../src/mailer/smtp.js";
import type { MailMessage } from "../src/mailer/types.js";
import {
  NetworkBlockedError,
  attempts,
  isLoopback,
  resetAttempts,
  takeAttempts,
} from "./support/network-guard.js";

/**
 * The guard is installed process-wide by test/support/network-setup.ts. These
 * canaries INTENTIONALLY trip it, so each one DRAINS its expected attempts with
 * takeAttempts() and asserts on the drained records — leaving the global afterEach
 * a clean buffer. A stray record is a real leak and fails its owning test.
 */

/** A non-loopback, non-routable destination (RFC-5737 TEST-NET-1) — never dials out. */
const TEST_NET_HOST = "192.0.2.1";

const message: MailMessage = {
  to: "hc@example.com",
  from: "bryce@example.com",
  subject: "guard canary",
  html: "<p>x</p>",
  text: "x\n",
};

/** Start an in-process loopback HTTP server; returns its base URL and a closer. */
async function startLoopbackServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  host = "127.0.0.1",
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const authority = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${authority}:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// A defensive drain: nothing here should leak into the next test even on failure.
afterEach(() => {
  resetAttempts();
});

describe("isLoopback normalization", () => {
  it("treats every loopback form as loopback", () => {
    for (const host of [
      undefined,
      "",
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.5.6.7",
      "0.0.0.0",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopback(host), String(host)).toBe(true);
    }
  });

  it("treats real remote hosts as non-loopback", () => {
    for (const host of ["api.example.com", "192.0.2.1", "8.8.8.8", "::ffff:8.8.8.8", "2606:4700::1"]) {
      expect(isLoopback(host), host).toBe(false);
    }
  });

  it("does NOT treat a 127.-prefixed hostname as loopback (only a real IPv4 literal is)", () => {
    // A valid DNS name that merely starts with "127." can resolve to a public address;
    // only a genuine dotted-quad in 127/8 (or its IPv4-mapped IPv6 form) is loopback.
    for (const host of [
      "127.attacker.com",
      "127.0.0.1.attacker.com",
      "127notaloopback",
      "::ffff:127.attacker.com",
    ]) {
      expect(isLoopback(host), host).toBe(false);
    }
  });
});

describe("guard mechanics", () => {
  it("blocks a direct non-loopback net.connect, throwing and recording a redacted attempt", () => {
    expect(() => net.connect({ host: "api.example.com", port: 443 })).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "api.example.com", port: 443 }]);
  });

  it("allows an in-process loopback server over fetch with no recorded attempt", async () => {
    const server = await startLoopbackServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    try {
      const res = await fetch(server.url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      // Loopback must never be recorded — in-process servers/MCP transports depend on it.
      expect(attempts()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("allows an in-process ::1 loopback server, or skips when IPv6 loopback is unavailable", async (ctx) => {
    let server: { url: string; close: () => Promise<void> };
    try {
      server = await startLoopbackServer((_req, res) => res.end("ok6"), "::1");
    } catch {
      // No IPv6 loopback in this environment — an explicit skip, not an opaque failure.
      ctx.skip();
      return;
    }
    try {
      const res = await fetch(server.url);
      expect(res.status).toBe(200);
      expect(attempts()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("assertNoUnapprovedAttempts backstops a swallowed throw independently of it", async () => {
    const { assertNoUnapprovedAttempts } = await import("./support/network-guard.js");
    // Empty buffer passes.
    expect(() => assertNoUnapprovedAttempts()).not.toThrow();
    // A recorded attempt (here: a swallowed direct connect) trips the teardown backstop.
    try {
      net.connect({ host: "api.example.com", port: 80 });
    } catch {
      // swallowed on purpose — the buffer, not the throw, is what catches the leak
    }
    expect(() => assertNoUnapprovedAttempts()).toThrow(NetworkBlockedError);
    resetAttempts();
    expect(() => assertNoUnapprovedAttempts()).not.toThrow();
  });
});

describe("per-entry-point overloads", () => {
  it("blocks net.connect in options form and port/host form", () => {
    expect(() => net.connect({ host: "api.example.com", port: 443 })).toThrow(NetworkBlockedError);
    expect(() => net.connect(443, "api.example.com")).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toEqual([
      { surface: "socket", host: "api.example.com", port: 443 },
      { surface: "socket", host: "api.example.com", port: 443 },
    ]);
  });

  it("blocks net.createConnection (options and port/host)", () => {
    expect(() => net.createConnection({ host: "api.example.com", port: 8443 })).toThrow(
      NetworkBlockedError,
    );
    expect(() => net.createConnection(8443, "api.example.com")).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toHaveLength(2);
  });

  it("blocks net.Socket.prototype.connect directly", () => {
    const socket = new net.Socket();
    try {
      expect(() => socket.connect({ host: "api.example.com", port: 993 })).toThrow(
        NetworkBlockedError,
      );
    } finally {
      socket.destroy();
    }
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "api.example.com", port: 993 }]);
  });

  it("blocks tls.connect in options form and port/host form", () => {
    expect(() => tls.connect({ host: "api.example.com", port: 443 })).toThrow(NetworkBlockedError);
    expect(() => tls.connect(443, "api.example.com")).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toHaveLength(2);
  });

  it("allows a unix-socket/path connect (no host) without recording", () => {
    const socket = net.connect("/tmp/bryce-network-guard-does-not-exist.sock");
    // The path form has no host, so the guard passes it through; the async
    // ENOENT/ECONNREFUSED that follows is swallowed and the socket torn down.
    socket.on("error", () => undefined);
    socket.destroy();
    expect(takeAttempts()).toEqual([]);
  });

  it("normalizes a bracketed IPv6 loopback host to loopback (allowed, not recorded)", () => {
    // A bracketed loopback must be treated as loopback, so no throw and no record.
    const socket = net.connect({ host: "[::1]", port: 65535 });
    socket.on("error", () => undefined);
    socket.destroy();
    expect(takeAttempts()).toEqual([]);
  });

  it("blocks fetch given a string, a URL, and a Request", async () => {
    await expect(fetch("https://api.example.com/a")).rejects.toBeInstanceOf(NetworkBlockedError);
    await expect(fetch(new URL("https://api.example.com/b"))).rejects.toBeInstanceOf(
      NetworkBlockedError,
    );
    await expect(fetch(new Request("https://api.example.com/c"))).rejects.toBeInstanceOf(
      NetworkBlockedError,
    );
    expect(takeAttempts()).toEqual([
      { surface: "fetch", host: "api.example.com", port: 443 },
      { surface: "fetch", host: "api.example.com", port: 443 },
      { surface: "fetch", host: "api.example.com", port: 443 },
    ]);
  });

  it("passes a non-network scheme (data:) through natively", async () => {
    const res = await fetch("data:text/plain,hello");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(attempts()).toEqual([]);
  });
});

describe("loopback allow-list is IP-literal-exact, not a textual 127. prefix (P1)", () => {
  it("blocks a 127.-prefixed HOSTNAME on the fetch surface (throws + records)", async () => {
    // "127.attacker.com" is a real DNS name that can resolve to a public address —
    // the guard must not mistake its textual prefix for the loopback block.
    await expect(fetch("https://127.attacker.com/")).rejects.toBeInstanceOf(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "fetch", host: "127.attacker.com", port: 443 }]);
  });

  it("blocks a 127.-prefixed HOSTNAME on the socket surface (throws + records)", () => {
    expect(() => net.connect({ host: "127.attacker.com", port: 443 })).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "127.attacker.com", port: 443 }]);
  });

  it("still allows a genuine 127/8 IPv4 literal, unrecorded", () => {
    // A real dotted-quad in 127/8 is loopback: no throw, no record.
    const socket = net.connect({ host: "127.0.0.1", port: 65535 });
    socket.on("error", () => undefined);
    socket.destroy();
    expect(takeAttempts()).toEqual([]);
  });

  it("allows ::ffff:127.0.0.1 but blocks ::ffff:8.8.8.8 on the socket surface", () => {
    const ok = net.connect({ host: "::ffff:127.0.0.1", port: 65535 });
    ok.on("error", () => undefined);
    ok.destroy();
    expect(takeAttempts()).toEqual([]);
    expect(() => net.connect({ host: "::ffff:8.8.8.8", port: 443 })).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "::ffff:8.8.8.8", port: 443 }]);
  });
});

describe("a custom DNS lookup on an allowed name is REFUSED — fail closed by construction", () => {
  /**
   * A fake resolver that maps any name to `addr`. Under the fail-closed rule the guard blocks
   * a NAME carrying a custom lookup BEFORE any resolution runs, so what this returns is
   * irrelevant for a name — the point is that a custom `lookup` is present at all. It still
   * honors Node's `all`-option contract for the one case Node actually runs it: a loopback IP
   * LITERAL, which Node never re-resolves anyway.
   */
  function fixedLookup(addr: string): net.LookupFunction {
    const family = net.isIP(addr) || 4;
    return (_hostname, options, cb) => {
      if (options && (options as { all?: boolean }).all) cb(null, [{ address: addr, family }]);
      else cb(null, addr, family);
    };
  }

  /** Connect and resolve once the socket settles: the error on failure, or null on connect. */
  function settle(options: net.NetConnectOpts): Promise<Error | null> {
    return new Promise<Error | null>((resolve) => {
      const socket = net.connect(options);
      socket.on("error", (err) => {
        socket.destroy();
        resolve(err);
      });
      socket.on("connect", () => {
        socket.destroy();
        resolve(null);
      });
    });
  }

  // --- The fail-closed inversion: a custom lookup on an allowed NAME is now BLOCKED, recorded
  // by the NAME the caller supplied (we block before resolution — there is no resolved address),
  // regardless of what the resolver would have returned. The block is a SYNCHRONOUS throw from
  // `connect`, so these assert `toThrow` directly. ---

  it("blocks + records a custom lookup on the allowed name `localhost` — recorded by name, exactly once", () => {
    // Formerly ALLOWED (the resolver returned 127.0.0.1); now refused by construction. The
    // single-element record also proves the `net.connect` → `Socket.prototype.connect` double
    // dispatch does not double-count: the outer wrapper throws before the inner one runs.
    expect(() =>
      net.connect({ host: "localhost", port: 443, lookup: fixedLookup("127.0.0.1") }),
    ).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "localhost", port: 443 }]);
  });

  it("records the NAME, not the resolved IP, when a custom lookup on `localhost` points at a public IP", () => {
    // Formerly recorded the RESOLVED 8.8.8.8; now blocked before resolution, so the record is
    // the NAME the caller supplied. Still blocked either way.
    expect(() =>
      net.connect({ host: "localhost", port: 443, lookup: fixedLookup("8.8.8.8") }),
    ).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "localhost", port: 443 }]);
  });

  it("Delta-1: blocks + records a custom lookup on an OMITTED host (defaults to the name localhost)", () => {
    // `net.connect({ port, lookup })` omits the host; Node would dial `localhost` and run the
    // custom lookup against it. Refused, recorded as the implicit name `localhost`. The resolver
    // shape (scalar vs `{all:true}` array) no longer matters — we never call it.
    const scalarLookup: net.LookupFunction = (_hostname, _options, cb) => cb(null, "8.8.8.8", 4);
    expect(() => net.connect({ port: 443, lookup: scalarLookup })).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "localhost", port: 443 }]);
  });

  it("Delta-2: cleanly BLOCKS a FROZEN options object with a custom lookup — NO TypeError, caller untouched", () => {
    // The fail-closed path only READS `lookup` to detect it, then throws; it never writes to the
    // caller's object. So a frozen options object is blocked cleanly (a NetworkBlockedError, not
    // a TypeError from an in-place assignment) and its own lookup is left exactly as supplied.
    const callerLookup = fixedLookup("127.0.0.1");
    const frozenOptions = Object.freeze({ host: "localhost", port: 443, lookup: callerLookup });
    let threw: unknown;
    try {
      net.connect(frozenOptions);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(NetworkBlockedError); // fail-closed, NOT a TypeError
    expect(frozenOptions.lookup).toBe(callerLookup); // caller's object never mutated
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "localhost", port: 443 }]);
  });

  it("D3: blocks + records a PROTOTYPE-BACKED options object carrying a custom lookup (read through the chain)", () => {
    // host/port/lookup live on the PROTOTYPE, not as own-enumerable keys; the guard reads them
    // through the chain (as Node does), detects the custom lookup, and refuses — recorded by the
    // inherited name. No cloning, so no ERR_MISSING_ARGS / spread-fidelity concerns remain.
    const protoBacked = Object.create({
      host: "localhost",
      port: 443,
      lookup: fixedLookup("8.8.8.8"),
    }) as net.NetConnectOpts;
    expect(() => net.connect(protoBacked)).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "localhost", port: 443 }]);
  });

  it("blocks + records a custom lookup on an allowed name over tls.connect (recorded by name)", () => {
    // The TLS surface fails closed identically: a custom lookup on `localhost` is refused before
    // the handshake, recorded by the NAME. (The resolver would have pointed at a public IP.)
    const publicIpLookup: net.LookupFunction = (_hostname, _options, cb) => cb(null, "8.8.8.8", 4);
    expect(() => tls.connect({ host: "localhost", port: 443, lookup: publicIpLookup })).toThrow(
      NetworkBlockedError,
    );
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "localhost", port: 443 }]);
  });

  it("blocks + records a custom lookup on a non-loopback NAME (recorded by name, before resolution)", () => {
    // A non-loopback name was already blocked; with a custom lookup it is still blocked, and the
    // record is the name — the refusal fires before any resolution regardless of loopback status.
    expect(() =>
      net.connect({ host: "api.example.com", port: 443, lookup: fixedLookup("127.0.0.1") }),
    ).toThrow(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "socket", host: "api.example.com", port: 443 }]);
  });

  // --- Positive controls: the IP-LITERAL exemption and plain (no-custom-lookup) loopback connects
  // still SUCCEED against an in-process server and record nothing. ---

  it("still ALLOWS a custom lookup on a loopback IP LITERAL (127.0.0.1) — Node never runs it, so it connects", async () => {
    // An IP literal is exempt: Node short-circuits DNS, the resolver is dead code, and the connect
    // dials the literal directly. Even a resolver that "would" return a public IP is irrelevant.
    const server = await startLoopbackServer((_req, res) => res.end("ok"));
    const port = Number(new URL(server.url).port);
    try {
      const settled = await settle({ host: "127.0.0.1", port, lookup: fixedLookup("8.8.8.8") });
      expect(settled).toBeNull(); // connected to the in-process server
      expect(takeAttempts()).toEqual([]); // literal is loopback, nothing recorded
    } finally {
      await server.close();
    }
  });

  it("still ALLOWS a plain net.connect to a loopback server with NO custom lookup (connects, records nothing)", async () => {
    // The core positive path with no resolver in play: a genuine TCP connect to the in-process
    // loopback server settles `connect` and records nothing.
    const server = await startLoopbackServer((_req, res) => res.end("ok"));
    const port = Number(new URL(server.url).port);
    try {
      const settled = await settle({ host: "127.0.0.1", port });
      expect(settled).toBeNull();
      expect(takeAttempts()).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("redirect canary — proves the socket patch catches undici's real connections", () => {
  it("blocks a loopback-initiated fetch that redirects to a non-loopback host", async () => {
    // The initial request is loopback (passes the fetch wrapper); undici follows
    // the 302 INTERNALLY (the wrapper never sees the second hop), so only the
    // net/tls socket patch can catch the connect to 192.0.2.1. This is what proves
    // the socket surface backstops undici — the fetch wrapper alone cannot.
    const server = await startLoopbackServer((_req, res) => {
      res.writeHead(302, { Location: `http://${TEST_NET_HOST}/` });
      res.end();
    });
    try {
      await expect(fetch(server.url)).rejects.toThrow();
      const drained = takeAttempts();
      expect(drained).toContainEqual({ surface: "socket", host: TEST_NET_HOST, port: 80 });
      // The loopback initial hop is NOT recorded — only the blocked redirect is.
      expect(drained.every((a) => a.host === TEST_NET_HOST)).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("provider canaries — default clients must fail closed", () => {
  it("MLB: a default MlbClient rejects (NetworkBlockedError propagates) and records a fetch attempt", async () => {
    // findPerson swallows ONLY MlbApiError 404 (src/mlb/client.ts:82-91); a
    // NetworkBlockedError propagates, so the call rejects.
    const client = new MlbClient();
    await expect(client.findPerson(123)).rejects.toBeInstanceOf(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "fetch", host: "statsapi.mlb.com", port: 443 }]);
  });

  it("NCAA: a default NcaaClient rejects and records a fetch attempt", async () => {
    const client = new NcaaClient();
    await expect(client.getGameLogPage(12345, "2024", "batting")).rejects.toBeInstanceOf(
      NetworkBlockedError,
    );
    expect(takeAttempts()).toEqual([{ surface: "fetch", host: "stats.ncaa.org", port: 443 }]);
  });

  it("Postmark send: a default mailer rejects and records a fetch attempt", async () => {
    const mailer = new PostmarkMailer("pm-token");
    await expect(mailer.send(message)).rejects.toBeInstanceOf(NetworkBlockedError);
    expect(takeAttempts()).toEqual([{ surface: "fetch", host: "api.postmarkapp.com", port: 443 }]);
  });

  it("Postmark lookup (fail-open): returns unavailable YET records the blocked attempt", async () => {
    // The load-bearing canary: findAccepted swallows every error into an
    // `unavailable` outcome. The thrown NetworkBlockedError is absorbed — but the
    // recorded attempt still proves the leak, which is exactly what the teardown
    // backstop relies on.
    const mailer = new PostmarkMailer("pm-token");
    const result = await mailer.findAccepted("bryce:digest:2026-07-19", null);
    expect(result.outcome).toBe("unavailable");
    expect(takeAttempts()).toEqual([{ surface: "fetch", host: "api.postmarkapp.com", port: 443 }]);
  });

  it("SMTP: a default nodemailer transport rejects and records a raw-socket attempt", async () => {
    // A non-loopback IP literal (not a hostname): nodemailer pre-resolves
    // hostnames via DNS BEFORE net.connect (failing with EDNS before the socket
    // is ever opened), but short-circuits DNS for an IP (net.isIP), so this
    // hermetically exercises the raw-socket path the guard exists to catch.
    const mailer = new SmtpMailer({ host: TEST_NET_HOST, port: 587, user: "u", pass: "p" });
    await expect(mailer.send(message)).rejects.toThrow();
    expect(takeAttempts()).toEqual([{ surface: "socket", host: TEST_NET_HOST, port: 587 }]);
  });
});

describe("redacted record shape (MF7)", () => {
  it("retains exactly { surface, host, port } — no URL, body, headers, or options", async () => {
    // The Postmark token rides on the request body/headers; proving the record
    // carries only surface/host/port proves it can never leak into a failure message.
    await expect(new PostmarkMailer("secret-token").send(message)).rejects.toBeInstanceOf(
      NetworkBlockedError,
    );
    const drained = takeAttempts();
    expect(drained).toHaveLength(1);
    const attempt = drained[0];
    expect(Object.keys(attempt ?? {}).sort()).toEqual(["host", "port", "surface"]);
    expect(attempt).toEqual({ surface: "fetch", host: "api.postmarkapp.com", port: 443 });
  });
});
