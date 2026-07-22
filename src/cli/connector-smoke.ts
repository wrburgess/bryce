import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadDotEnv } from "../env.js";
import { isMain } from "./main.js";

/**
 * Connector smoke diagnostic (issue #37): drives the REAL MCP SDK client over
 * Streamable HTTP against a running Bryce `/mcp`, proving a connector can
 * initialize, discover the eleven tools, read health/preview, and that an
 * unauthenticated request still fails closed. Env-only config, no secret ever
 * echoed. An opt-in `--mutate` exercises the write path against a designated
 * already-inactive staging sentinel only.
 *
 *   npm run connector:smoke
 *   npm run connector:smoke -- --mutate   # STAGING ONLY — writes to the target DB
 *
 * The runner is injectable (env, an output sink, a fetch impl, and an MCP
 * client factory) behind a thin `isMain` entry, so importing this module never
 * executes the smoke and every path is testable in-process (test/connector-smoke.test.ts).
 */

/** The eleven tools the server advertises (mirrors test/mcp.test.ts ALL_TOOLS). */
export const ALL_TOOLS = [
  "watchlist_list",
  "watchlist_add",
  "watchlist_add_ncaa",
  "watchlist_deactivate",
  "player_search",
  "stat_lines",
  "digest_preview",
  "send_digest",
  "run_refresh",
  "sql_query",
  "status",
] as const;

export const DEFAULT_MCP_URL = "http://localhost:3000/mcp";
const REDACTED = "[REDACTED]";
export const DEFAULT_TIMEOUT_MS = 15000;
const SMOKE_CLIENT_NAME = "bryce-connector-smoke";
const SMOKE_CLIENT_VERSION = "0.1.0";

/** Exit codes: 0 pass, 1 a check failed, 2 a config/setup error (no stack, no secret). */
export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_CONFIG = 2;

/** A config/setup problem reported cleanly — never a stack trace, never a secret. */
export class SmokeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeConfigError";
  }
}

/** An authenticated request tried to do something unsafe (e.g. follow a redirect). */
export class SmokeSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeSecurityError";
  }
}

/** Environment the runner reads (a plain env bag; `process.env` satisfies it). */
export type SmokeEnv = Record<string, string | undefined>;

/** A fetch compatible with the MCP SDK's FetchLike — real `Response` in, out. */
export type SmokeFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface SmokeIo {
  write: (line: string) => void;
  writeError: (line: string) => void;
}

/** The minimal MCP client surface the smoke drives — the SDK Client satisfies it. */
export interface SmokeToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

export interface SmokeMcpClient {
  listTools: () => Promise<{ tools: Array<{ name: string }> }>;
  callTool: (request: { name: string; arguments?: Record<string, unknown> }) => Promise<SmokeToolResult>;
  close: () => Promise<void>;
}

export interface McpConnectContext {
  url: string;
  headers: Record<string, string>;
}

/** Builds and connects an MCP client to `url` with `headers` (bearer + optional CF). */
export type McpConnector = (ctx: McpConnectContext) => Promise<SmokeMcpClient>;

export interface SmokeDeps {
  env: SmokeEnv;
  argv: string[];
  io: SmokeIo;
  /** Raw fetch for the no-bearer 401 probe; hardened in production. */
  fetchImpl: SmokeFetch;
  connectMcp: McpConnector;
}

export interface SmokeConfig {
  mcpUrl: string;
  apiToken: string;
  cfAccessClientId: string | null;
  cfAccessClientSecret: string | null;
  /** The raw SMOKE_PERSON_ID (trimmed), validated only on the --mutate path. */
  smokePersonIdRaw: string | null;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Trim to a real value or null (a whitespace-only string is "absent"). */
const clean = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Collapse a trailing slash and an accidental doubled `/mcp` — the two config
 * fat-fingers we normalize. We do NOT append `/mcp` when it is absent: that is
 * the operator's intent, not a typo, and forcing it would mask a real mistake.
 */
export function normalizeMcpUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.replace(/(?:\/mcp)+$/i, "/mcp");
}

/**
 * Fail closed on an unsafe endpoint: reject a malformed URL, a non-http(s)
 * scheme, and — the load-bearing rule — plaintext http to any non-loopback
 * host, so a bearer token can never ride an unencrypted hop off the machine.
 */
export function assertSafeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SmokeConfigError(`MCP_URL is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SmokeConfigError(`MCP_URL must use http or https, got '${url.protocol}'`);
  }
  if (url.protocol === "https:") return url;
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!loopback) {
    throw new SmokeConfigError(
      `refusing plaintext http for non-loopback host '${host}'; use https ` +
        `(http is allowed only for localhost/127.0.0.1/::1)`,
    );
  }
  return url;
}

/**
 * Read the whole config from env. Missing API_TOKEN, a partial CF pair, or an
 * unsafe URL each throw a SmokeConfigError (clean message, no stack, no secret).
 */
export function parseConfig(env: SmokeEnv): SmokeConfig {
  const mcpUrl = normalizeMcpUrl(clean(env.MCP_URL) ?? DEFAULT_MCP_URL);
  assertSafeUrl(mcpUrl);

  const apiToken = clean(env.API_TOKEN);
  if (apiToken === null) {
    throw new SmokeConfigError("API_TOKEN is required; set it in the environment (it is never echoed)");
  }

  // Both-or-neither: a lone CF header would silently drop half a service-token,
  // and a blank value (whitespace) counts as absent via clean().
  const cfId = clean(env.CF_ACCESS_CLIENT_ID);
  const cfSecret = clean(env.CF_ACCESS_CLIENT_SECRET);
  if ((cfId === null) !== (cfSecret === null)) {
    throw new SmokeConfigError(
      "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be provided together (both or neither)",
    );
  }

  return {
    mcpUrl,
    apiToken,
    cfAccessClientId: cfId,
    cfAccessClientSecret: cfSecret,
    smokePersonIdRaw: clean(env.SMOKE_PERSON_ID),
  };
}

/** The Cloudflare Access service-token headers when both are set, else `{}`. */
export function cfHeaders(config: SmokeConfig): Record<string, string> {
  if (config.cfAccessClientId !== null && config.cfAccessClientSecret !== null) {
    return {
      "CF-Access-Client-Id": config.cfAccessClientId,
      "CF-Access-Client-Secret": config.cfAccessClientSecret,
    };
  }
  return {};
}

/** The outgoing auth headers: the bearer, plus CF Access service headers if set. */
export function authHeaders(config: SmokeConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiToken}`, ...cfHeaders(config) };
}

/**
 * A text redactor over the three secret values. ALL runner output flows through
 * it, so a token can never reach stdout/stderr even inside an unexpected error.
 */
export function makeSanitizer(secrets: Array<string | null>): (text: string) => string {
  const values = secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  return (text: string) => {
    let out = text;
    for (const secret of values) {
      out = out.split(secret).join(REDACTED);
    }
    return out;
  };
}

/**
 * Escape every non-ASCII character to a lowercase `\uXXXX` sequence so a bundled
 * script's stdout/stderr stays pure ASCII (rules/scripting.md): a Host App or CI
 * runner on a non-UTF-8 locale raises `invalid byte sequence` the instant it greps
 * output carrying a raw multi-byte char (e.g. a server-supplied error or an IDN
 * URL path). ASCII bytes — control chars included — pass through untouched.
 */
export function toAscii(text: string): string {
  // \x00 is intentional: the range is the ASCII byte set (control chars included) we KEEP;
  // only code points above it are escaped.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x00-\x7F]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Wrap a base fetch so an authenticated request never follows a redirect (which
 * would forward Authorization/CF headers cross-origin) and never hangs: manual
 * redirect handling + a bounded per-request AbortController timeout.
 */
export function makeSafeFetch(baseFetch: SmokeFetch, timeoutMs = DEFAULT_TIMEOUT_MS): SmokeFetch {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Additive, never a replacement: honor any caller-supplied signal (e.g. the
    // no-bearer probe's full-read bound) alongside this fetch's time-to-headers timeout.
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      const res = await baseFetch(url, { ...init, redirect: "manual", signal });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status <= 399)) {
        const status = res.status === 0 ? "opaqueredirect" : String(res.status);
        throw new SmokeSecurityError(
          `refusing to follow a redirect (${status}) on an authenticated request`,
        );
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  };
}

const toolErrorText = (res: SmokeToolResult): string =>
  (res.content ?? [])
    .map((c) => c.text ?? "")
    .join(" ")
    .trim() || "tool returned isError with no message";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** initialize is implicit in connect(); this asserts the EXACT eleven tool set. */
async function checkToolList(client: SmokeMcpClient): Promise<CheckResult> {
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const expected: readonly string[] = ALL_TOOLS;
  const missing = expected.filter((n) => !names.has(n));
  const unexpected = [...names].filter((n) => !expected.includes(n));
  if (missing.length === 0 && unexpected.length === 0) {
    return { name: "tools/list", ok: true, detail: `all ${ALL_TOOLS.length} tools present` };
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) parts.push(`unexpected: ${unexpected.join(", ")}`);
  return { name: "tools/list", ok: false, detail: parts.join("; ") };
}

async function checkStatus(client: SmokeMcpClient): Promise<CheckResult> {
  const res = await client.callTool({ name: "status", arguments: {} });
  if (res.isError) return { name: "status", ok: false, detail: toolErrorText(res) };
  const sc = asRecord(res.structuredContent);
  const healthy =
    sc !== undefined &&
    sc.ok === true &&
    typeof sc.players === "number" &&
    typeof sc.statLines === "number" &&
    "lastDelivery" in sc;
  return healthy
    ? { name: "status", ok: true, detail: `ok players=${sc.players} statLines=${sc.statLines}` }
    : { name: "status", ok: false, detail: "health shape missing ok/players/statLines/lastDelivery" };
}

async function checkDigestPreview(client: SmokeMcpClient): Promise<CheckResult> {
  const res = await client.callTool({ name: "digest_preview", arguments: {} });
  if (res.isError) return { name: "digest_preview", ok: false, detail: toolErrorText(res) };
  const sc = asRecord(res.structuredContent);
  const ok = sc !== undefined && "window" in sc && typeof sc.statLineCount === "number";
  return ok
    ? { name: "digest_preview", ok: true, detail: "read-only preview returned (sends nothing, writes nothing)" }
    : { name: "digest_preview", ok: false, detail: "preview did not return the expected shape" };
}

/** A request with no bearer must 401 with the fixed body, and never echo the token. */
export async function checkNoBearer401(config: SmokeConfig, fetchImpl: SmokeFetch): Promise<CheckResult> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  // Unlike the SDK's long-lived SSE stream — bounded only to time-to-headers, since a hard
  // total bound would sever a legitimate MCP session — this probe is a one-shot request, so
  // its own controller bounds the FULL read (headers AND `res.text()`). A stalled body then
  // aborts within DEFAULT_TIMEOUT_MS instead of hanging. The probe carries the CF service-token
  // headers (so Cloudflare admits it in Service-Auth mode and Bryce is what returns the 401) but
  // deliberately sends NO Authorization.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(config.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...cfHeaders(config),
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const bodyMatches = text.replace(/\s+/g, "") === '{"error":"unauthorized"}';
    const tokenAbsent = !text.includes(config.apiToken);
    if (res.status === 401 && bodyMatches && tokenAbsent) {
      return { name: "no-bearer-401", ok: true, detail: "401 {\"error\":\"unauthorized\"}, token absent" };
    }
    const problems: string[] = [];
    if (res.status !== 401) problems.push(`status=${res.status} (want 401)`);
    if (!bodyMatches) problems.push("body is not the fixed unauthorized payload");
    if (!tokenAbsent) problems.push("token appeared in the response");
    return { name: "no-bearer-401", ok: false, detail: problems.join("; ") };
  } catch (err) {
    return { name: "no-bearer-401", ok: false, detail: `request failed: ${describeError(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The opt-in write path (STAGING ONLY). Operates solely on a designated,
 * already-inactive SMOKE_PERSON_ID sentinel: it refuses a sentinel that is
 * absent from the watch list or currently active, so it can never deactivate a
 * live player. Deactivating an already-inactive sentinel is a documented,
 * idempotent no-op that still returns `active:false`, which is what we assert.
 * `send_digest` is never called.
 */
async function checkMutate(client: SmokeMcpClient, personId: number): Promise<CheckResult[]> {
  const listRes = await client.callTool({ name: "watchlist_list", arguments: { active: "all" } });
  if (listRes.isError) {
    return [{ name: "mutate/lookup", ok: false, detail: toolErrorText(listRes) }];
  }
  const players = (asRecord(listRes.structuredContent)?.players ?? []) as Array<Record<string, unknown>>;
  const sentinel = players.find((p) => p.externalId === personId);
  if (sentinel === undefined) {
    return [
      {
        name: "mutate/guard",
        ok: false,
        detail: `SMOKE_PERSON_ID=${personId} is not on the watch list; refusing (the sentinel must already exist)`,
      },
    ];
  }
  if (sentinel.active === true) {
    return [
      {
        name: "mutate/guard",
        ok: false,
        detail: `SMOKE_PERSON_ID=${personId} is currently ACTIVE; refusing to deactivate a live player`,
      },
    ];
  }

  const results: CheckResult[] = [
    {
      name: "mutate/guard",
      ok: true,
      detail: `sentinel ${personId} is already inactive (idempotent target)`,
    },
  ];
  const deRes = await client.callTool({ name: "watchlist_deactivate", arguments: { personId } });
  if (deRes.isError) {
    results.push({ name: "mutate/deactivate", ok: false, detail: toolErrorText(deRes) });
    return results;
  }
  const player = asRecord(asRecord(deRes.structuredContent)?.player);
  const ok = player?.active === false;
  results.push(
    ok
      ? {
          name: "mutate/deactivate",
          ok: true,
          detail: "watchlist_deactivate returned active:false (persistent, idempotent no-op on the sentinel)",
        }
      : {
          name: "mutate/deactivate",
          ok: false,
          detail: `expected active:false, got active:${JSON.stringify(player?.active)}`,
        },
  );
  return results;
}

/** SMOKE_PERSON_ID must be a positive integer to be a usable sentinel. */
function parseSmokePersonId(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : null;
}

/**
 * The injectable runner. Returns a process exit code and never throws for an
 * expected outcome; all output is sanitized. Reads only from its injected deps.
 */
export async function runSmoke(deps: SmokeDeps): Promise<number> {
  const { env, argv, fetchImpl, connectMcp } = deps;
  const sanitize = makeSanitizer([
    clean(env.API_TOKEN),
    clean(env.CF_ACCESS_CLIENT_ID),
    clean(env.CF_ACCESS_CLIENT_SECRET),
  ]);
  // Redact secrets first, then ASCII-normalize — so no secret ever reaches an
  // output sink and the sink only ever sees pure-ASCII bytes.
  const io: SmokeIo = {
    write: (line) => deps.io.write(toAscii(sanitize(line))),
    writeError: (line) => deps.io.writeError(toAscii(sanitize(line))),
  };

  let config: SmokeConfig;
  try {
    config = parseConfig(env);
  } catch (err) {
    io.writeError(`config error: ${err instanceof SmokeConfigError ? err.message : describeError(err)}`);
    return EXIT_CONFIG;
  }

  const mutate = argv.includes("--mutate");
  let sentinelPersonId: number | null = null;
  if (mutate) {
    sentinelPersonId = parseSmokePersonId(config.smokePersonIdRaw);
    if (sentinelPersonId === null) {
      io.writeError(
        "config error: --mutate requires SMOKE_PERSON_ID set to a positive-integer sentinel personId",
      );
      return EXIT_CONFIG;
    }
  }

  io.write(`bryce connector smoke: url=${config.mcpUrl} mode=${mutate ? "mutate" : "read-only"}`);
  if (config.cfAccessClientId !== null) io.write("cloudflare access service headers: present");
  if (mutate) {
    io.write(
      "WARNING: --mutate writes to the target DB via watchlist_deactivate; STAGING ONLY, never production.",
    );
  }

  const results: CheckResult[] = [];
  let client: SmokeMcpClient | null = null;
  try {
    client = await connectMcp({ url: config.mcpUrl, headers: authHeaders(config) });
    results.push(await checkToolList(client));
    results.push(await checkStatus(client));
    results.push(await checkDigestPreview(client));
    results.push(await checkNoBearer401(config, fetchImpl));
    if (mutate && sentinelPersonId !== null) {
      results.push(...(await checkMutate(client, sentinelPersonId)));
    }
  } catch (err) {
    results.push({ name: "connect", ok: false, detail: `unexpected error: ${describeError(err)}` });
  } finally {
    if (client !== null) {
      try {
        await client.close();
      } catch (err) {
        io.writeError(`warning: MCP client close failed: ${describeError(err)}`);
      }
    }
  }

  for (const r of results) {
    io.write(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` - ${r.detail}` : ""}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  io.write(`summary: ${results.length - failed}/${results.length} checks passed`);
  return failed === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}

/** Adapt the SDK Client to the SmokeMcpClient surface the runner drives. */
export function adaptClient(client: Client): SmokeMcpClient {
  return {
    listTools: async () => {
      const result = await client.listTools();
      return { tools: result.tools.map((t) => ({ name: t.name })) };
    },
    callTool: async (request) => (await client.callTool(request)) as SmokeToolResult,
    close: () => client.close(),
  };
}

/** Production connector: a real SDK client over Streamable HTTP with the hardened fetch. */
export function createRealConnector(fetchImpl: SmokeFetch): McpConnector {
  return async (ctx) => {
    const client = new Client({ name: SMOKE_CLIENT_NAME, version: SMOKE_CLIENT_VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(ctx.url), {
      fetch: fetchImpl,
      requestInit: { headers: ctx.headers },
    });
    await client.connect(transport);
    return adaptClient(client);
  };
}

export async function main(): Promise<number> {
  loadDotEnv();
  const io: SmokeIo = {
    write: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => process.stderr.write(`${line}\n`),
  };
  const safeFetch = makeSafeFetch((url, init) => fetch(url, init));
  return runSmoke({
    env: process.env,
    argv: process.argv.slice(2),
    io,
    fetchImpl: safeFetch,
    connectMcp: createRealConnector(safeFetch),
  });
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      // Route even the top-level failure through the same secret redactor as
      // runSmoke, so no configured secret value can ever reach stderr.
      const sanitize = makeSanitizer([
        clean(process.env.API_TOKEN),
        clean(process.env.CF_ACCESS_CLIENT_ID),
        clean(process.env.CF_ACCESS_CLIENT_SECRET),
      ]);
      const message = err instanceof Error ? err.message : String(err);
      // Same order as runSmoke: redact secrets, then ASCII-normalize.
      process.stderr.write(`${toAscii(sanitize(`error: ${message}`))}\n`);
      process.exit(1);
    });
}
