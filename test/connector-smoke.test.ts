import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedDb } from "../src/db/client.js";
import { digestDeliveries, players } from "../src/db/schema.js";
import type { AppDeps } from "../src/server.js";
import { createApp } from "../src/server.js";
import type { McpConnector, SmokeEnv, SmokeFetch, SmokeIo } from "../src/cli/connector-smoke.js";
import {
  DEFAULT_TIMEOUT_MS,
  EXIT_CHECK_FAILED,
  EXIT_CONFIG,
  adaptClient,
  assertSafeUrl,
  authHeaders,
  cfHeaders,
  checkNoBearer401,
  makeSafeFetch,
  makeSanitizer,
  normalizeMcpUrl,
  parseConfig,
  runSmoke,
  SmokeConfigError,
  SmokeSecurityError,
  toAscii,
} from "../src/cli/connector-smoke.js";
import {
  CapturingMailer,
  InjectedFault,
  MID_SEASON,
  TEST_API_TOKEN,
  TEST_TZ,
  fakeClock,
  insertCalendars2026,
  insertPlayer,
  insertStatLine,
  testAppDeps,
  testDb,
} from "./factories.js";

type App = ReturnType<typeof createApp>;

/**
 * The connector smoke driven in-process, exactly like test/mcp.test.ts boots
 * the app and drives the REAL MCP SDK client over Streamable HTTP — here the
 * runner's env / fetch / output / client factory are injected so every branch
 * (auth, rotation, CF headers, secret redaction, the --mutate write path, URL
 * guarding) is asserted on OBSERVABLE effects, plus one real-subprocess test at
 * the CLI boundary.
 */

/** A record of the headers one outgoing request actually carried. */
function headersToRecord(init: RequestInit["headers"]): Record<string, string> {
  const record: Record<string, string> = {};
  if (init === undefined) return record;
  if (init instanceof Headers) {
    init.forEach((value, key) => (record[key.toLowerCase()] = value));
  } else if (Array.isArray(init)) {
    for (const pair of init) {
      const key = pair[0];
      const value = pair[1];
      if (key !== undefined && value !== undefined) record[key.toLowerCase()] = value;
    }
  } else {
    for (const [key, value] of Object.entries(init)) record[key.toLowerCase()] = String(value);
  }
  return record;
}

/** A connector that wires the real SDK client straight into the in-process app. */
function makeConnector(app: App, sink?: Array<Record<string, string>>): McpConnector {
  return async (ctx) => {
    const client = new Client({ name: "bryce-smoke-test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(ctx.url), {
      fetch: async (url, init) => {
        if (sink !== undefined) sink.push(headersToRecord(init?.headers));
        return app.request(url.toString(), init);
      },
      requestInit: { headers: ctx.headers },
    });
    await client.connect(transport);
    return adaptClient(client);
  };
}

/** The no-bearer probe's fetch: straight into the app, no hardening needed in-process. */
function appFetch(app: App): SmokeFetch {
  return async (url, init) => app.request(url.toString(), init);
}

interface Harness {
  deps: Parameters<typeof runSmoke>[0];
  out: string[];
  err: string[];
}

describe("connector smoke", () => {
  let opened: OpenedDb;
  let mailer: CapturingMailer;
  let appDeps: AppDeps;

  beforeEach(async () => {
    opened = testDb();
    mailer = new CapturingMailer();
    await insertCalendars2026(opened.db);
    appDeps = testAppDeps(opened, { mailer, now: fakeClock(MID_SEASON).now, tz: TEST_TZ });
  });

  afterEach(() => {
    opened.close();
  });

  const makeApp = (token: string = TEST_API_TOKEN): App => createApp({ ...appDeps, apiToken: token });

  const baseEnv = (overrides: SmokeEnv = {}): SmokeEnv => ({
    MCP_URL: "http://localhost:3000/mcp",
    API_TOKEN: TEST_API_TOKEN,
    ...overrides,
  });

  const harness = (
    app: App,
    env: SmokeEnv,
    argv: string[] = [],
    connector?: McpConnector,
  ): Harness => {
    const out: string[] = [];
    const err: string[] = [];
    const io: SmokeIo = { write: (l) => out.push(l), writeError: (l) => err.push(l) };
    return {
      deps: {
        env,
        argv,
        io,
        fetchImpl: appFetch(app),
        connectMcp: connector ?? makeConnector(app),
      },
      out,
      err,
    };
  };

  // --- Pure helpers ---------------------------------------------------------

  describe("normalizeMcpUrl", () => {
    it("drops a trailing slash", () => {
      expect(normalizeMcpUrl("http://localhost:3000/mcp/")).toBe("http://localhost:3000/mcp");
    });
    it("collapses an accidental doubled /mcp", () => {
      expect(normalizeMcpUrl("http://localhost:3000/mcp/mcp")).toBe("http://localhost:3000/mcp");
      expect(normalizeMcpUrl("http://localhost:3000/mcp/mcp/")).toBe("http://localhost:3000/mcp");
    });
    it("leaves a clean url unchanged", () => {
      expect(normalizeMcpUrl("https://bryce.example.com/mcp")).toBe("https://bryce.example.com/mcp");
    });
  });

  describe("assertSafeUrl", () => {
    it("allows https for any host and http for loopback only", () => {
      expect(assertSafeUrl("https://bryce.example.com/mcp").protocol).toBe("https:");
      expect(assertSafeUrl("http://localhost:3000/mcp").hostname).toBe("localhost");
      expect(assertSafeUrl("http://127.0.0.1:3000/mcp").hostname).toBe("127.0.0.1");
    });
    it("refuses plaintext http for a non-loopback host", () => {
      expect(() => assertSafeUrl("http://bryce.example.com/mcp")).toThrow(SmokeConfigError);
    });
    it("rejects a malformed url and a non-http scheme", () => {
      expect(() => assertSafeUrl("not-a-valid-url")).toThrow(SmokeConfigError);
      expect(() => assertSafeUrl("ftp://host/mcp")).toThrow(SmokeConfigError);
    });
  });

  describe("parseConfig", () => {
    it("requires API_TOKEN", () => {
      expect(() => parseConfig({ MCP_URL: "http://localhost:3000/mcp" })).toThrow(SmokeConfigError);
    });
    it("rejects a partial or blank CF Access pair, but accepts both-absent", () => {
      expect(() => parseConfig(baseEnv({ CF_ACCESS_CLIENT_ID: "id-only" }))).toThrow(SmokeConfigError);
      expect(() => parseConfig(baseEnv({ CF_ACCESS_CLIENT_SECRET: "secret-only" }))).toThrow(
        SmokeConfigError,
      );
      // A blank counts as absent, so a blank id with a real secret is still a partial pair.
      expect(() =>
        parseConfig(baseEnv({ CF_ACCESS_CLIENT_ID: "   ", CF_ACCESS_CLIENT_SECRET: "real" })),
      ).toThrow(SmokeConfigError);
      const both = parseConfig(baseEnv({ CF_ACCESS_CLIENT_ID: "   ", CF_ACCESS_CLIENT_SECRET: "   " }));
      expect(both.cfAccessClientId).toBeNull();
      expect(authHeaders(both)["CF-Access-Client-Id"]).toBeUndefined();
    });
    it("normalizes the URL and carries the token into the auth header", () => {
      const cfg = parseConfig(baseEnv({ MCP_URL: "http://localhost:3000/mcp/mcp/" }));
      expect(cfg.mcpUrl).toBe("http://localhost:3000/mcp");
      expect(authHeaders(cfg).Authorization).toBe(`Bearer ${TEST_API_TOKEN}`);
    });
  });

  describe("makeSanitizer", () => {
    it("redacts every secret value and ignores blanks", () => {
      const sanitize = makeSanitizer(["s3cr3t", null, "", "abc123"]);
      expect(sanitize("token=s3cr3t id=abc123 ok")).toBe("token=[REDACTED] id=[REDACTED] ok");
    });
  });

  describe("makeSafeFetch", () => {
    it("refuses to follow a redirect on an authenticated request", async () => {
      const redirecting: SmokeFetch = () => Promise.resolve(Response.redirect("https://evil.example/", 302));
      await expect(makeSafeFetch(redirecting)("https://x.example/mcp", { method: "POST" })).rejects.toBeInstanceOf(
        SmokeSecurityError,
      );
    });
    it("passes a normal response through and sets manual redirect + an abort signal", async () => {
      let seen: RequestInit | undefined;
      const base: SmokeFetch = (_url, init) => {
        seen = init;
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      };
      const res = await makeSafeFetch(base)("https://x.example/mcp", { method: "POST" });
      expect(res.status).toBe(200);
      expect(seen?.redirect).toBe("manual");
      expect(seen?.signal).toBeInstanceOf(AbortSignal);
      expect(seen?.method).toBe("POST");
    });
    it("preserves the caller's abort signal alongside its own timeout (never overrides it)", async () => {
      const caller = new AbortController();
      let seen: RequestInit | undefined;
      const base: SmokeFetch = (_url, init) => {
        seen = init;
        return Promise.resolve(new Response("{}", { status: 200 }));
      };
      await makeSafeFetch(base)("https://x.example/mcp", { method: "POST", signal: caller.signal });
      // The signal handed to the base fetch is a combined one: aborting the caller aborts it too.
      expect(seen?.signal).toBeInstanceOf(AbortSignal);
      expect(seen?.signal?.aborted).toBe(false);
      caller.abort();
      expect(seen?.signal?.aborted).toBe(true);
    });
  });

  describe("cfHeaders", () => {
    it("returns both CF Access headers when the pair is set, and {} otherwise", () => {
      const withCf = parseConfig(
        baseEnv({ CF_ACCESS_CLIENT_ID: "cf-id-abc123", CF_ACCESS_CLIENT_SECRET: "cf-secret-xyz789" }),
      );
      expect(cfHeaders(withCf)).toEqual({
        "CF-Access-Client-Id": "cf-id-abc123",
        "CF-Access-Client-Secret": "cf-secret-xyz789",
      });
      expect(cfHeaders(parseConfig(baseEnv()))).toEqual({});
    });
    it("is the CF source authHeaders reuses", () => {
      const withCf = parseConfig(
        baseEnv({ CF_ACCESS_CLIENT_ID: "cf-id-abc123", CF_ACCESS_CLIENT_SECRET: "cf-secret-xyz789" }),
      );
      expect(authHeaders(withCf)).toEqual({
        Authorization: `Bearer ${TEST_API_TOKEN}`,
        ...cfHeaders(withCf),
      });
    });
  });

  describe("checkNoBearer401", () => {
    // A no-op Response the probe can read: a real 401 with the fixed unauthorized body.
    const unauthorized = () => Promise.resolve(new Response('{"error":"unauthorized"}', { status: 401 }));

    it("carries both CF service-token headers but NEVER Authorization when CF is configured", async () => {
      const config = parseConfig(
        baseEnv({ CF_ACCESS_CLIENT_ID: "cf-id-abc123", CF_ACCESS_CLIENT_SECRET: "cf-secret-xyz789" }),
      );
      let seen: Record<string, string> = {};
      const recording: SmokeFetch = (_url, init) => {
        seen = headersToRecord(init?.headers);
        return unauthorized();
      };
      const result = await checkNoBearer401(config, recording);
      expect(result.ok).toBe(true);
      expect(seen["cf-access-client-id"]).toBe("cf-id-abc123");
      expect(seen["cf-access-client-secret"]).toBe("cf-secret-xyz789");
      expect(seen.authorization).toBeUndefined();
    });

    it("sends neither CF header (and no Authorization) when CF is not configured", async () => {
      const config = parseConfig(baseEnv());
      let seen: Record<string, string> = {};
      const recording: SmokeFetch = (_url, init) => {
        seen = headersToRecord(init?.headers);
        return unauthorized();
      };
      await checkNoBearer401(config, recording);
      expect(seen["cf-access-client-id"]).toBeUndefined();
      expect(seen["cf-access-client-secret"]).toBeUndefined();
      expect(seen.authorization).toBeUndefined();
    });

    it("bounds a stalled body read: aborts within the timeout and fails instead of hanging", async () => {
      vi.useFakeTimers();
      try {
        const config = parseConfig(baseEnv());
        // A Response whose .text() resolves ONLY if its signal aborts — otherwise it hangs forever.
        const stalled: SmokeFetch = (_url, init) => {
          const signal = init?.signal;
          const res = {
            status: 401,
            text: () =>
              new Promise<string>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new Error("aborted")));
              }),
          } as unknown as Response;
          return Promise.resolve(res);
        };
        const pending = checkNoBearer401(config, stalled);
        // Let the probe settle on `await res.text()` (fetch resolved, abort listener attached)
        // before the fake clock moves, so the timeout is what unblocks it.
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
        const result = await pending;
        expect(result.name).toBe("no-bearer-401");
        expect(result.ok).toBe(false);
        expect(result.detail).toContain("request failed");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("toAscii", () => {
    it("escapes non-ASCII to lowercase, zero-padded \\uXXXX and leaves ASCII untouched", () => {
      expect(toAscii("café")).toBe("caf\\u00e9");
      expect(toAscii("plain ASCII 123 !@#")).toBe("plain ASCII 123 !@#");
      // A control char is ASCII and must pass through unchanged.
      expect(toAscii("a\tb\n")).toBe("a\tb\n");
      // Every emitted escape is exactly four lowercase hex digits.
      expect(toAscii("→")).toMatch(/^\\u[0-9a-f]{4}$/);
    });
  });

  // --- Read-only happy path -------------------------------------------------

  it("happy path: exact 14 tools, healthy status, read-only preview, no-bearer 401 — no mail, no write", async () => {
    const player = await insertPlayer(opened.db, { fullName: "Maximo Acosta" });
    await insertStatLine(opened.db, { playerId: player.id, gameDate: "2026-07-18" });
    const { deps, out, err } = harness(makeApp(), baseEnv());

    expect(await runSmoke(deps)).toBe(0);
    expect(out).toContain("PASS tools/list - all 14 tools present");
    expect(out.some((l) => l.startsWith("PASS status"))).toBe(true);
    expect(out.some((l) => l.startsWith("PASS digest_preview"))).toBe(true);
    expect(out.some((l) => l.startsWith("PASS no-bearer-401"))).toBe(true);
    expect(out).toContain("summary: 4/4 checks passed");

    // digest_preview implied no mail send and no delivery-row write.
    expect(mailer.sent).toHaveLength(0);
    expect(await opened.db.select().from(digestDeliveries)).toHaveLength(0);

    // The token never appears on stdout OR stderr.
    expect([...out, ...err].join("\n")).not.toContain(TEST_API_TOKEN);
    expect(err).toEqual([]);
  });

  // --- Auth negatives + rotation -------------------------------------------

  it("a wrong bearer fails to connect (401) and returns non-zero", async () => {
    const { deps, out } = harness(makeApp(TEST_API_TOKEN), baseEnv({ API_TOKEN: "totally-wrong-token" }));
    expect(await runSmoke(deps)).toBe(EXIT_CHECK_FAILED);
    expect(out.some((l) => l.startsWith("FAIL connect"))).toBe(true);
  });

  it("rotation: the old token fails after the app is rebuilt with a new one; the new token works", async () => {
    const oldToken = TEST_API_TOKEN;
    const newToken = "rotated-token-0987654321";

    // Old token against the old app: passes.
    expect(await runSmoke(harness(makeApp(oldToken), baseEnv({ API_TOKEN: oldToken })).deps)).toBe(0);

    // The app is reconstructed with a new token; the old token now cannot connect.
    const appNew = makeApp(newToken);
    const stale = harness(appNew, baseEnv({ API_TOKEN: oldToken }));
    expect(await runSmoke(stale.deps)).toBe(EXIT_CHECK_FAILED);
    expect(stale.out.some((l) => l.startsWith("FAIL connect"))).toBe(true);

    // The new token against the new app: green again.
    expect(await runSmoke(harness(appNew, baseEnv({ API_TOKEN: newToken })).deps)).toBe(0);
  });

  // --- CF Access header propagation ----------------------------------------

  it("propagates CF Access service headers on outgoing requests when both are set", async () => {
    const cfId = "cf-id-abc123";
    const cfSecret = "cf-secret-xyz789";
    const sink: Array<Record<string, string>> = [];
    const app = makeApp();
    const { deps } = harness(
      app,
      baseEnv({ CF_ACCESS_CLIENT_ID: cfId, CF_ACCESS_CLIENT_SECRET: cfSecret }),
      [],
      makeConnector(app, sink),
    );

    expect(await runSmoke(deps)).toBe(0);
    const withCf = sink.find((h) => "cf-access-client-id" in h);
    expect(withCf?.["cf-access-client-id"]).toBe(cfId);
    expect(withCf?.["cf-access-client-secret"]).toBe(cfSecret);
    expect(withCf?.authorization).toBe(`Bearer ${TEST_API_TOKEN}`);
  });

  it("returns a config exit code when only one CF Access header is set", async () => {
    const { deps, err } = harness(makeApp(), baseEnv({ CF_ACCESS_CLIENT_ID: "id-only" }));
    expect(await runSmoke(deps)).toBe(EXIT_CONFIG);
    expect(err.some((l) => l.startsWith("config error"))).toBe(true);
  });

  // --- Secret-leak on a forced failure -------------------------------------

  it("never leaks any secret value on stdout or stderr, even when an error carries it", async () => {
    const token = TEST_API_TOKEN;
    const cfId = "cf-id-abc123";
    const cfSecret = "cf-secret-xyz789";
    // A connector whose failure literally embeds all three secrets — the sanitizer must catch them.
    const leaky: McpConnector = () =>
      Promise.reject(new Error(`boom token=${token} id=${cfId} secret=${cfSecret}`));
    const { deps, out, err } = harness(
      makeApp(token),
      baseEnv({ API_TOKEN: token, CF_ACCESS_CLIENT_ID: cfId, CF_ACCESS_CLIENT_SECRET: cfSecret }),
      [],
      leaky,
    );

    expect(await runSmoke(deps)).toBe(EXIT_CHECK_FAILED);
    const all = [...out, ...err].join("\n");
    for (const secret of [token, cfId, cfSecret]) {
      expect(all).not.toContain(secret);
    }
    // The failure is still surfaced (redacted), never silently swallowed.
    expect(all).toContain("[REDACTED]");
    expect(out.some((l) => l.startsWith("FAIL connect"))).toBe(true);
  });

  it("ASCII-normalizes runtime output: a non-ASCII tool error never puts a raw multi-byte char on stdout/stderr", async () => {
    // A connector whose failure carries non-ASCII bytes (a server-supplied error / IDN path).
    const nonAscii: McpConnector = () => Promise.reject(new Error("boom café résumé →"));
    const { deps, out, err } = harness(makeApp(), baseEnv(), [], nonAscii);

    expect(await runSmoke(deps)).toBe(EXIT_CHECK_FAILED);
    const all = [...out, ...err].join("\n");
    // Not a single character with code point > 127 reached either stream.
    expect([...all].every((c) => c.charCodeAt(0) <= 127)).toBe(true);
    // The failure is still surfaced, just escaped (the accented chars become \\uXXXX), never swallowed.
    expect(out.some((l) => l.startsWith("FAIL connect") && l.includes("\\u00e9"))).toBe(true);
  });

  // --- The --mutate write path ---------------------------------------------

  it("--mutate deactivates an already-inactive sentinel and asserts active:false", async () => {
    const sentinel = await insertPlayer(opened.db, {
      externalId: 555000,
      fullName: "Sentinel Sam",
      active: false,
    });
    const { deps, out } = harness(makeApp(), baseEnv({ SMOKE_PERSON_ID: "555000" }), ["--mutate"]);

    expect(await runSmoke(deps)).toBe(0);
    expect(out.some((l) => l.includes("WARNING: --mutate writes to the target DB"))).toBe(true);
    expect(out.some((l) => l.startsWith("PASS mutate/deactivate"))).toBe(true);
    // Still inactive — a persistent, idempotent no-op that corrupts nothing.
    const row = (await opened.db.select().from(players)).find((p) => p.id === sentinel.id);
    expect(row?.active).toBe(false);
  });

  it("--mutate is idempotent: a re-run on the already-inactive sentinel stays green", async () => {
    await insertPlayer(opened.db, { externalId: 555222, fullName: "Sentinel Three", active: false });
    const env = baseEnv({ SMOKE_PERSON_ID: "555222" });
    expect(await runSmoke(harness(makeApp(), env, ["--mutate"]).deps)).toBe(0);
    const second = harness(makeApp(), env, ["--mutate"]);
    expect(await runSmoke(second.deps)).toBe(0);
    expect(second.out.some((l) => l.startsWith("PASS mutate/deactivate"))).toBe(true);
  });

  it("--mutate refuses a currently-active sentinel", async () => {
    await insertPlayer(opened.db, { externalId: 555333, fullName: "Active Sentinel", active: true });
    const { deps, out } = harness(makeApp(), baseEnv({ SMOKE_PERSON_ID: "555333" }), ["--mutate"]);
    expect(await runSmoke(deps)).toBe(EXIT_CHECK_FAILED);
    expect(out.some((l) => l.startsWith("FAIL mutate/guard") && l.includes("ACTIVE"))).toBe(true);
    // The active player was not touched.
    expect((await opened.db.select().from(players))[0]?.active).toBe(true);
  });

  it("--mutate refuses a sentinel that is not on the watch list", async () => {
    const { deps, out } = harness(makeApp(), baseEnv({ SMOKE_PERSON_ID: "999888" }), ["--mutate"]);
    expect(await runSmoke(deps)).toBe(EXIT_CHECK_FAILED);
    expect(out.some((l) => l.startsWith("FAIL mutate/guard") && l.includes("not on the watch list"))).toBe(
      true,
    );
  });

  it("--mutate without SMOKE_PERSON_ID (or a blank one) is a config error", async () => {
    const missing = harness(makeApp(), baseEnv(), ["--mutate"]);
    expect(await runSmoke(missing.deps)).toBe(EXIT_CONFIG);
    expect(missing.err.some((l) => l.includes("SMOKE_PERSON_ID"))).toBe(true);

    const blank = harness(makeApp(), baseEnv({ SMOKE_PERSON_ID: "   " }), ["--mutate"]);
    expect(await runSmoke(blank.deps)).toBe(EXIT_CONFIG);
  });

  it("--mutate never calls send_digest, and a fault before deactivate leaves a defined state", async () => {
    const sentinel = await insertPlayer(opened.db, {
      externalId: 555111,
      fullName: "Sentinel Two",
      active: false,
    });
    const app = makeApp();
    const calls: string[] = [];
    // A connector that records every tool name and blows up ON watchlist_deactivate.
    const faulting: McpConnector = async (ctx) => {
      const base = await makeConnector(app)(ctx);
      return {
        listTools: () => base.listTools(),
        callTool: (req) => {
          calls.push(req.name);
          if (req.name === "watchlist_deactivate") {
            return Promise.reject(new InjectedFault("mutate/deactivate"));
          }
          return base.callTool(req);
        },
        close: () => base.close(),
      };
    };
    const { deps } = harness(app, baseEnv({ SMOKE_PERSON_ID: "555111" }), ["--mutate"], faulting);

    expect(await runSmoke(deps)).toBe(EXIT_CHECK_FAILED);
    expect(calls).toContain("watchlist_deactivate");
    expect(calls).not.toContain("send_digest");
    // The sentinel is unchanged (still inactive): no partial corruption.
    const row = (await opened.db.select().from(players)).find((p) => p.id === sentinel.id);
    expect(row?.active).toBe(false);
  });

  // --- URL guarding at the runner boundary ---------------------------------

  it("runSmoke refuses a non-loopback http URL as a config error", async () => {
    const { deps, err } = harness(makeApp(), baseEnv({ MCP_URL: "http://bryce.example.com/mcp" }));
    expect(await runSmoke(deps)).toBe(EXIT_CONFIG);
    expect(err.some((l) => l.includes("non-loopback"))).toBe(true);
  });

  it("runSmoke rejects a malformed MCP_URL as a config error", async () => {
    const { deps, err } = harness(makeApp(), baseEnv({ MCP_URL: "not-a-valid-url" }));
    expect(await runSmoke(deps)).toBe(EXIT_CONFIG);
    expect(err.some((l) => l.startsWith("config error"))).toBe(true);
  });

  it("runSmoke returns a clean config exit code (no crash) when API_TOKEN is missing", async () => {
    const env = baseEnv();
    delete env.API_TOKEN;
    const { deps, out, err } = harness(makeApp(), env);
    expect(await runSmoke(deps)).toBe(EXIT_CONFIG);
    expect(err.some((l) => l.startsWith("config error") && l.includes("API_TOKEN"))).toBe(true);
    expect(out).toEqual([]);
  });

  // --- Real subprocess at the CLI boundary ---------------------------------

  describe("real CLI subprocess", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = join(repoRoot, "src", "cli", "connector-smoke.ts");
    const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");

    // Run from a scratch cwd so no repo .env is ever loaded into the process.
    const runCli = (args: string[], env: NodeJS.ProcessEnv) => {
      const cwd = mkdtempSync(join(tmpdir(), "bryce-smoke-"));
      try {
        return spawnSync(tsxBin, [cliPath, ...args], { encoding: "utf8", env, cwd });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    };

    it("exits non-zero with a clean config message and no stack trace when API_TOKEN is missing", () => {
      const env: NodeJS.ProcessEnv = { ...process.env, MCP_URL: "http://localhost:3000/mcp" };
      delete env.API_TOKEN;
      const result = runCli([], env);
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toContain("config error");
      expect(combined).toContain("API_TOKEN");
      // A clean bail, not a thrown stack trace.
      expect(combined).not.toMatch(/\n\s+at /);
    }, 30000);

    it("parses --mutate and requires SMOKE_PERSON_ID before connecting, never echoing the token", () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MCP_URL: "http://localhost:3000/mcp",
        API_TOKEN: "subprocess-token-123",
      };
      delete env.SMOKE_PERSON_ID;
      const result = runCli(["--mutate"], env);
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toContain("SMOKE_PERSON_ID");
      expect(combined).not.toContain("subprocess-token-123");
      expect(combined).not.toMatch(/\n\s+at /);
    }, 30000);
  });
});
