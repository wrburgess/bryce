import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateOperationalTemplates } from "../../scripts/check-operational-templates.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNING_GUIDE = join(ROOT, "docs/guides/running-bryce.md");
function copyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bryce-ops-"));
  cpSync(join(ROOT, "ops"), join(root, "ops"), { recursive: true });
  writeFileSync(join(root, "package.json"), readFileSync(join(ROOT, "package.json")));
  return root;
}

describe("operational templates", () => {
  it("validates the canonical portable source templates", () => {
    expect(validateOperationalTemplates(ROOT)).toEqual([]);
    for (const name of ["backup", "refresh", "digest"]) {
      const template = readFileSync(join(ROOT, `ops/templates/com.sk.${name}.plist`), "utf8");
      expect(template).toContain('mkdir -p "BRYCE_ROOT/logs"');
      expect(template).toContain(`&gt;&gt; "BRYCE_ROOT/logs/${name}.log"`);
      expect(template).toContain("&amp;&amp;");
      expect(template).toContain("2&gt;&amp;1");
    }
    // #146: the scheduled sweep opts into quiet mode, and the `--` separator is
    // the whole contract — without it npm eats the flag and the job silently
    // runs verbose, writing a per-player stream into an unrotated log.
    const refresh = readFileSync(join(ROOT, "ops/templates/com.sk.refresh.plist"), "utf8");
    expect(refresh).toContain("npm run refresh -- --quiet");
  });

  it("rejects a scheduled invocation that drops the npm argument separator", () => {
    const root = copyRoot();
    try {
      const refresh = join(root, "ops/templates/com.sk.refresh.plist");
      // The exact silent failure mode: the flag is still there, but npm keeps it.
      // replaceAll, not replace: the same invocation appears in the explanatory
      // comment above ProgramArguments, and a first-match edit would rewrite the
      // COMMENT and leave the real command line intact — a case that passes
      // whether or not the gate works.
      writeFileSync(refresh, readFileSync(refresh, "utf8").replaceAll("npm run refresh -- --quiet", "npm run refresh --quiet"));
      expect(validateOperationalTemplates(root)).toContain(
        "com.sk.refresh.plist: ProgramArguments must provision logs and run npm script refresh",
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("documents the constrained path contract used by the shell-backed templates", () => {
    const guide = readFileSync(RUNNING_GUIDE, "utf8");
    expect(guide).toContain("ASCII letters, digits, spaces");
    expect(guide).toContain("dollar sign, backtick, backslash, XML");
    expect(guide).toContain("move or symlink the repository");
  });

  it("reports template contract drift with stable diagnostics", () => {
    const root = copyRoot();
    try {
      const refresh = join(root, "ops/templates/com.sk.refresh.plist");
      writeFileSync(refresh, readFileSync(refresh, "utf8").replace("npm run refresh", "npm run missing").replace("<integer>30</integer>", "<integer>0</integer>").replace("</plist>", ""));
      writeFileSync(join(root, "ops/templates/litestream.yml"), "dbs:\n  - path: BAD_DIR/bryce.db\n    AWS_SECRET_ACCESS_KEY: leaked\n");
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
      delete pkg.scripts.digest;
      writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
      const issues = validateOperationalTemplates(root).join("\n");
      expect(issues).toContain("com.sk.refresh.plist: invalid plist hierarchy");
      expect(issues).toContain("com.sk.digest.plist: package.json lacks npm script digest");
      expect(issues).toContain("litestream.yml: unknown placeholder BAD_DIR");
      expect(issues).toContain("litestream.yml: secret-like assignment is not allowed");
      expect(issues).toContain("litestream.yml: invalid YAML hierarchy or replica mapping");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an unquoted root path in a shell command", () => {
    const root = copyRoot();
    try {
      const digest = join(root, "ops/templates/com.sk.digest.plist");
      writeFileSync(digest, readFileSync(digest, "utf8").replace('"BRYCE_ROOT/logs"', "BRYCE_ROOT/logs"));
      expect(validateOperationalTemplates(root)).toContain(
        "com.sk.digest.plist: ProgramArguments must provision logs and run npm script digest",
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects nested-but-wrong plist fields and misplaced Litestream mappings", () => {
    const root = copyRoot();
    try {
      const backup = join(root, "ops/templates/com.sk.backup.plist");
      writeFileSync(backup, readFileSync(backup, "utf8").replace("<key>Label</key><string>com.sk.backup</string>", "<key>Label</key><dict><key>Name</key><integer>3</integer><key>Other</key><integer>0</integer></dict>"));
      writeFileSync(join(root, "ops/templates/litestream.yml"), [
        "dbs:",
        "  - path: BRYCE_DATA_DIR/bryce.db",
        "    replicas:",
        "      - type: s3",
        "        path: bryce.db",
        "        bucket: R2_BUCKET",
        "        endpoint: https://R2_ENDPOINT",
      ].join("\n"));
      const issues = validateOperationalTemplates(root).join("\n");
      expect(issues).toContain("com.sk.backup.plist: Label must be com.sk.backup");
      expect(issues).toContain("litestream.yml: invalid YAML hierarchy or replica mapping");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects raw shell ampersands in XML text", () => {
    const root = copyRoot();
    try {
      const refresh = join(root, "ops/templates/com.sk.refresh.plist");
      writeFileSync(refresh, readFileSync(refresh, "utf8").replace("&amp;&amp;", "&&"));
      expect(validateOperationalTemplates(root)).toContain("com.sk.refresh.plist: invalid plist hierarchy");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
