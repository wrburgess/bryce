import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The REAL constant, not a copy of its value: this gate exists to prove the
// schedule is authored once, and re-typing the number here would be the second
// authoring it is meant to forbid (`rules/backend.md` — never re-decide a
// dependency's question with a proxy signal).
import { TICK_PERIOD_MS } from "../src/jobs/tick.js";

const TEMPLATE_DIR = join("ops", "templates");
const ALLOWED_TOKENS = new Set(["BRYCE_ROOT", "BRYCE_DATA_DIR", "R2_BUCKET", "R2_ENDPOINT"]);
const SECRET_ASSIGNMENT = /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|POSTMARK_SERVER_TOKEN|API_TOKEN|SMTP_PASS)\s*[:=]/;

/**
 * WHEN a scheduled job runs — a wall-clock time, or a repeating interval (#193).
 *
 * A union rather than optional fields, because the two are mutually exclusive in
 * launchd: `StartCalendarInterval` and `StartInterval` are different keys, and a
 * plist carrying both is a configuration nobody meant to write. Modelling them
 * as a union means the validator cannot accidentally accept a template that
 * declares one and is checked against the other.
 */
type PlistSchedule =
  | { hour: number; minute: number }
  | {
      intervalSeconds: number;
      /**
       * A code constant SIZED FROM this interval, which must not drift from it
       * (PR #203 Reviewer, Medium). Carrying the runtime value here — rather than
       * a second literal — is what makes the pair checkable at all.
       */
      sizedConstant?: { name: string; source: string; ms: number };
    };

interface PlistSpec {
  file: string;
  label: string;
  command: string;
  log: string;
  schedule: PlistSchedule;
  /**
   * Arguments the scheduled job passes THROUGH npm to the CLI, exactly as they
   * must appear. Pinned here rather than left free-form because the `--`
   * separator is the whole contract: without it npm swallows the flag and the
   * job silently runs in the wrong mode, which is the failure this gate exists
   * to catch (#146, and again for the tick at #193).
   */
  args?: string;
}
const PLISTS: readonly PlistSpec[] = [
  { file: "com.sk.backup.plist", label: "com.sk.backup", command: "db:backup", log: "backup", schedule: { hour: 3, minute: 0 } },
  // ONE tick replaces the fixed refresh (03:30) and digest (05:00) agents
  // (#193, ADR 0062 decision 3). Their templates are asserted ABSENT below.
  {
    file: "com.sk.tick.plist", label: "com.sk.tick", command: "tick", log: "tick", args: "-- --quiet",
    schedule: {
      intervalSeconds: 900,
      sizedConstant: { name: "TICK_PERIOD_MS", source: "src/jobs/tick.ts", ms: TICK_PERIOD_MS },
    },
  },
];

/**
 * Templates that must NOT exist (#193). Deleting a retired agent's template is
 * not enough on its own: a stale copy re-added by a bad merge, or restored from
 * a branch, would still be copyable into `~/Library/LaunchAgents` and would put
 * the host back on the fixed schedule alongside the tick. Naming them here makes
 * their absence a checked property rather than the current state of the tree.
 */
const RETIRED_PLISTS: readonly string[] = ["com.sk.refresh.plist", "com.sk.digest.plist"];

function tokens(text: string): string[] {
  return [...text.matchAll(/\b(?:BRYCE_ROOT|BRYCE_DATA_DIR|R2_BUCKET|R2_ENDPOINT|[A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[0]!);
}

/** Decode the XML entities permitted in our template text nodes. */
function decodeXml(value: string): string | undefined {
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return undefined;
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => (
    { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity]!
  ));
}

/** Parse the limited plist vocabulary we ship, including nesting rather than marker substrings. */
function plistDict(text: string): Map<string, { tag: string; value: string } & { children?: string[] }> | undefined {
  if (!/^\s*<\?xml\b[\s\S]*?<plist\b[^>]*>\s*<dict>/i.test(text) || !/\s*<\/dict>\s*<\/plist>\s*$/i.test(text)) return undefined;
  const root = text.match(/<plist\b[^>]*>\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>/i)?.[1];
  if (root === undefined) return undefined;
  const result = new Map<string, { tag: string; value: string; children?: string[] }>();
  const pair = /<key>([^<]+)<\/key>\s*<(string|integer)>([^<]*)<\/\2>|<key>([^<]+)<\/key>\s*<array>([\s\S]*?)<\/array>|<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  let cursor = 0;
  for (const match of root.matchAll(pair)) {
    if (root.slice(cursor, match.index).trim() !== "") return undefined;
    cursor = (match.index ?? 0) + match[0].length;
    if (match[1] !== undefined) {
      const value = decodeXml(match[3]!);
      if (value === undefined) return undefined;
      result.set(match[1], { tag: match[2]!, value });
    }
    else if (match[4] !== undefined) {
      const children = [...match[5]!.matchAll(/<string>([^<]*)<\/string>/g)].map((child) => decodeXml(child[1]!));
      if (children.some((child) => child === undefined)) return undefined;
      if (children.length !== 3 || match[5]!.replace(/\s*<string>[^<]*<\/string>\s*/g, "") !== "") return undefined;
      result.set(match[4], { tag: "array", value: "", children: children as string[] });
    } else {
      const pairs = [...match[7]!.matchAll(/<key>([^<]+)<\/key>\s*<integer>([^<]+)<\/integer>/g)];
      if (pairs.length !== 2 || match[7]!.replace(/\s*<key>[^<]+<\/key>\s*<integer>[^<]+<\/integer>\s*/g, "") !== "") return undefined;
      result.set(match[6]!, { tag: "dict", value: "", children: pairs.flatMap((child) => [child[1]!, child[2]!]) });
    }
  }
  return root.slice(cursor).trim() === "" ? result : undefined;
}

interface LitestreamConfig { path?: string; replica?: Record<string, string> }
/** Parse the fixed, portable YAML mapping shape rather than accepting scattered marker strings. */
function parseLitestream(text: string): LitestreamConfig | undefined {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const top = /^dbs:\s*$/.test(lines[0] ?? "");
  const db = /^ {2}- path: (\S+)\s*$/.exec(lines[1] ?? "");
  const replicas = /^ {4}replicas:\s*$/.test(lines[2] ?? "");
  const replica = /^ {6}- type: (\S+)\s*$/.exec(lines[3] ?? "");
  if (!top || db === null || !replicas || replica === null || lines.length !== 7) return undefined;
  const values: Record<string, string> = { type: replica[1]! };
  for (const [offset, key] of [[4, "bucket"], [5, "path"], [6, "endpoint"]] as const) {
    const match = new RegExp(`^        ${key}: (\\S+)\\s*$`).exec(lines[offset] ?? "");
    if (match === null) return undefined;
    values[key] = match[1]!;
  }
  return { path: db[1], replica: values };
}

export function validateOperationalTemplates(root: string): string[] {
  const issues: string[] = [];
  const templateDir = join(root, TEMPLATE_DIR);
  const packagePath = join(root, "package.json");
  const scripts = existsSync(packagePath) ? (JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {} : {};
  for (const spec of PLISTS) {
    const path = join(templateDir, spec.file);
    if (!existsSync(path)) { issues.push(`${spec.file}: missing template`); continue; }
    const text = readFileSync(path, "utf8");
    for (const token of tokens(text)) if (!ALLOWED_TOKENS.has(token) && !["UTF", "DOCTYPE", "DTD", "EN", "PUBLIC", "PLIST"].includes(token)) issues.push(`${spec.file}: unknown placeholder ${token}`);
    if (SECRET_ASSIGNMENT.test(text)) issues.push(`${spec.file}: secret-like assignment is not allowed`);
    const dict = plistDict(text);
    if (dict === undefined) { issues.push(`${spec.file}: invalid plist hierarchy`); continue; }
    if (dict.get("Label")?.value !== spec.label) issues.push(`${spec.file}: Label must be ${spec.label}`);
    if (dict.get("WorkingDirectory")?.value !== "BRYCE_ROOT") issues.push(`${spec.file}: WorkingDirectory must be BRYCE_ROOT`);
    const invocation = spec.args === undefined ? `npm run ${spec.command}` : `npm run ${spec.command} ${spec.args}`;
    const expected = `mkdir -p "BRYCE_ROOT/logs" && ${invocation} >> "BRYCE_ROOT/logs/${spec.log}.log" 2>&1`;
    const args = dict.get("ProgramArguments");
    if (args?.tag !== "array" || args.children?.join("\0") !== ["/bin/zsh", "-lc", expected].join("\0")) issues.push(`${spec.file}: ProgramArguments must provision logs and run npm script ${spec.command}`);
    if ("intervalSeconds" in spec.schedule) {
      // `StartInterval` is a plain integer pair, so it comes back through the
      // dict's string|integer branch. The TAG is checked as well as the value:
      // launchd reads `<string>900</string>` as a type error and never schedules
      // the job, which would be a silently-never-runs agent.
      const interval = dict.get("StartInterval");
      if (interval?.tag !== "integer" || interval.value !== String(spec.schedule.intervalSeconds)) {
        issues.push(`${spec.file}: schedule must be StartInterval ${spec.schedule.intervalSeconds}`);
      }
      // A template carrying BOTH keys is ambiguous rather than merely redundant.
      if (dict.has("StartCalendarInterval")) issues.push(`${spec.file}: interval schedule must not also declare StartCalendarInterval`);
      // ONE AUTHORED CADENCE, NOT TWO (PR #203 Reviewer, Medium). `TICK_PERIOD_MS`
      // is sourced BY COMMENT to this interval and sizes `REFRESH_DUE_TOLERANCE_MS`
      // (half a period) in turn — but nothing made the pair agree, so an operator
      // who edits the plist to 30 minutes silently keeps a tolerance sized for 15.
      // That is the one-idea-in-two-places shape this PR already fixed twice.
      //
      // Compared against the TEMPLATE'S OWN parsed value rather than
      // `spec.intervalSeconds`, because the plist is where the schedule is
      // authored: someone changing the cadence edits the plist (and the spec
      // above, to keep this gate green) while the constant stays behind, and only
      // a comparison anchored on the plist catches that.
      const sized = spec.schedule.sizedConstant;
      const authoredSeconds = interval?.tag === "integer" ? Number(interval.value) : Number.NaN;
      if (sized !== undefined && Number.isSafeInteger(authoredSeconds) && authoredSeconds * 1000 !== sized.ms) {
        issues.push(
          `${spec.file}: StartInterval ${authoredSeconds}s (${authoredSeconds * 1000}ms) disagrees with ${sized.name} = ${sized.ms}ms in ${sized.source} — the cadence is authored in the plist and ${sized.name} is sized from it, so both must change together`,
        );
      }
    } else {
      const { hour, minute } = spec.schedule;
      const calendar = dict.get("StartCalendarInterval")?.children;
      if (calendar?.join("\0") !== ["Hour", String(hour), "Minute", String(minute)].join("\0")) issues.push(`${spec.file}: schedule must be ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
      if (dict.has("StartInterval")) issues.push(`${spec.file}: calendar schedule must not also declare StartInterval`);
    }
    if (scripts[spec.command] === undefined) issues.push(`${spec.file}: package.json lacks npm script ${spec.command}`);
  }
  for (const retired of RETIRED_PLISTS) {
    if (existsSync(join(templateDir, retired))) issues.push(`${retired}: retired template must be absent (#193 replaced it with com.sk.tick.plist)`);
  }
  const litestream = join(templateDir, "litestream.yml");
  if (!existsSync(litestream)) issues.push("litestream.yml: missing template");
  else {
    const text = readFileSync(litestream, "utf8");
    for (const token of tokens(text)) if (!ALLOWED_TOKENS.has(token)) issues.push(`litestream.yml: unknown placeholder ${token}`);
    if (SECRET_ASSIGNMENT.test(text)) issues.push("litestream.yml: secret-like assignment is not allowed");
    const config = parseLitestream(text);
    if (config?.path !== "BRYCE_DATA_DIR/bryce.db" || config.replica?.type !== "s3" || config.replica.bucket !== "R2_BUCKET" || config.replica.path !== "bryce.db" || config.replica.endpoint !== "https://R2_ENDPOINT") issues.push("litestream.yml: invalid YAML hierarchy or replica mapping");
  }
  return issues;
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const issues = validateOperationalTemplates(root);
  if (issues.length === 0) process.stdout.write("operational templates: ok\n");
  else { for (const issue of issues) process.stderr.write(`operational templates: ${issue}\n`); process.exitCode = 1; }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
