import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_DIR = join("ops", "templates");
const ALLOWED_TOKENS = new Set(["BRYCE_ROOT", "BRYCE_DATA_DIR", "R2_BUCKET", "R2_ENDPOINT"]);
const SECRET_ASSIGNMENT = /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|POSTMARK_SERVER_TOKEN|API_TOKEN|SMTP_PASS)\s*[:=]/;

interface PlistSpec { file: string; label: string; command: string; log: string; hour: number; minute: number }
const PLISTS: readonly PlistSpec[] = [
  { file: "com.sk.backup.plist", label: "com.sk.backup", command: "db:backup", log: "backup", hour: 3, minute: 0 },
  { file: "com.sk.refresh.plist", label: "com.sk.refresh", command: "refresh", log: "refresh", hour: 3, minute: 30 },
  { file: "com.sk.digest.plist", label: "com.sk.digest", command: "digest", log: "digest", hour: 5, minute: 0 },
];

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
    const expected = `mkdir -p "BRYCE_ROOT/logs" && npm run ${spec.command} >> "BRYCE_ROOT/logs/${spec.log}.log" 2>&1`;
    const args = dict.get("ProgramArguments");
    if (args?.tag !== "array" || args.children?.join("\0") !== ["/bin/zsh", "-lc", expected].join("\0")) issues.push(`${spec.file}: ProgramArguments must provision logs and run npm script ${spec.command}`);
    const calendar = dict.get("StartCalendarInterval")?.children;
    if (calendar?.join("\0") !== ["Hour", String(spec.hour), "Minute", String(spec.minute)].join("\0")) issues.push(`${spec.file}: schedule must be ${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`);
    if (scripts[spec.command] === undefined) issues.push(`${spec.file}: package.json lacks npm script ${spec.command}`);
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
