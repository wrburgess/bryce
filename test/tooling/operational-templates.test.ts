import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateOperationalTemplates } from "../../scripts/check-operational-templates.js";
import { TICK_PERIOD_MS } from "../../src/jobs/tick.js";

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
    for (const name of ["backup", "tick"]) {
      const template = readFileSync(join(ROOT, `ops/templates/com.sk.${name}.plist`), "utf8");
      expect(template).toContain('mkdir -p "BRYCE_ROOT/logs"');
      expect(template).toContain(`&gt;&gt; "BRYCE_ROOT/logs/${name}.log"`);
      expect(template).toContain("&amp;&amp;");
      expect(template).toContain("2&gt;&amp;1");
    }
    // #146, inherited by the tick at #193: the scheduled job opts into quiet
    // mode, and the `--` separator is the whole contract — without it npm eats
    // the flag and the job silently runs verbose, writing a per-stage stream
    // into an unrotated log ~96 times a day.
    const tick = readFileSync(join(ROOT, "ops/templates/com.sk.tick.plist"), "utf8");
    expect(tick).toContain("npm run tick -- --quiet");
    // The 15-minute cadence, pinned as a literal (#193, ADR 0062 decision 3).
    expect(tick).toContain("<key>StartInterval</key><integer>900</integer>");
    // The KEY form, not the bare word — the explanatory comment above the dict
    // says why an interval was chosen over a calendar schedule, and a substring
    // check on the word alone would fail on the prose rather than on a real
    // second schedule.
    expect(tick).not.toContain("<key>StartCalendarInterval</key>");
  });

  it("keeps the retired fixed-schedule templates ABSENT (#193)", () => {
    // Deleting them is not enough on its own: a stale copy re-added by a bad
    // merge is still copyable into ~/Library/LaunchAgents and would put the host
    // back on the fixed schedule alongside the tick. Absence is a CHECKED
    // property, not the current state of the tree.
    for (const retired of ["com.sk.refresh.plist", "com.sk.digest.plist"]) {
      expect(existsSync(join(ROOT, "ops/templates", retired)), retired).toBe(false);
    }
    expect(validateOperationalTemplates(ROOT)).toEqual([]);

    // GUARD-BREAK: re-add one and the gate must go red, naming it. Without this
    // the assertion above passes whether or not the checker enforces anything.
    const root = copyRoot();
    try {
      writeFileSync(
        join(root, "ops/templates/com.sk.refresh.plist"),
        readFileSync(join(ROOT, "ops/templates/com.sk.tick.plist"), "utf8"),
      );
      expect(validateOperationalTemplates(root)).toContain(
        "com.sk.refresh.plist: retired template must be absent (#193 replaced it with com.sk.tick.plist)",
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a scheduled invocation that drops the npm argument separator", () => {
    const root = copyRoot();
    try {
      const tick = join(root, "ops/templates/com.sk.tick.plist");
      // The exact silent failure mode: the flag is still there, but npm keeps it.
      // replaceAll, not replace: the same invocation appears in the explanatory
      // comment above ProgramArguments, and a first-match edit would rewrite the
      // COMMENT and leave the real command line intact — a case that passes
      // whether or not the gate works.
      writeFileSync(tick, readFileSync(tick, "utf8").replaceAll("npm run tick -- --quiet", "npm run tick --quiet"));
      expect(validateOperationalTemplates(root)).toContain(
        "com.sk.tick.plist: ProgramArguments must provision logs and run npm script tick",
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a drifted or mistyped tick interval (#193)", () => {
    const root = copyRoot();
    try {
      const tick = join(root, "ops/templates/com.sk.tick.plist");
      const source = readFileSync(tick, "utf8");

      // A drifted value.
      writeFileSync(tick, source.replace("<integer>900</integer>", "<integer>3600</integer>"));
      expect(validateOperationalTemplates(root)).toContain(
        "com.sk.tick.plist: schedule must be StartInterval 900",
      );

      // The TYPE matters as much as the value: launchd reads
      // `<string>900</string>` as a type error and never schedules the job at
      // all — an agent that silently never runs, which no value check catches.
      writeFileSync(tick, source.replace("<integer>900</integer>", "<string>900</string>"));
      expect(validateOperationalTemplates(root)).toContain(
        "com.sk.tick.plist: schedule must be StartInterval 900",
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a plist interval that has drifted from TICK_PERIOD_MS (PR #203)", () => {
    // `TICK_PERIOD_MS` sizes `REFRESH_DUE_TOLERANCE_MS` (half a period) and is
    // sourced BY COMMENT to this plist — two places holding one idea, with
    // nothing asserting they agree. Edit the interval to 30 minutes and the
    // scheduler keeps a tolerance sized for 15: the sweep is judged due up to
    // 7.5 minutes early against a cadence that now fires half as often, silently
    // and forever. This is the assertion that makes that edit loud.
    //
    // The shipped pair AGREES, asserted against the real template rather than
    // against a re-typed 900_000 here — a literal in this file would be a third
    // authoring of the number the gate exists to keep single.
    expect(validateOperationalTemplates(ROOT)).toEqual([]);

    const root = copyRoot();
    try {
      const tick = join(root, "ops/templates/com.sk.tick.plist");
      writeFileSync(tick, readFileSync(tick, "utf8").replace("<integer>900</integer>", "<integer>1800</integer>"));
      // The message names BOTH sources, because an operator reading a CI failure
      // has to know which two things to reconcile. Composed from the imported
      // constant rather than a re-typed literal: a copy here would be the third
      // authoring of the very number this gate exists to keep single.
      expect(validateOperationalTemplates(root)).toContain(
        `com.sk.tick.plist: StartInterval 1800s (1800000ms) disagrees with TICK_PERIOD_MS = ${TICK_PERIOD_MS}ms in src/jobs/tick.ts` +
          " — the cadence is authored in the plist and TICK_PERIOD_MS is sized from it, so both must change together",
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("documents the constrained path contract used by the shell-backed templates", () => {
    const guide = readFileSync(RUNNING_GUIDE, "utf8");
    expect(guide).toContain("ASCII letters, digits, spaces");
    expect(guide).toContain("dollar sign, backtick, backslash, XML");
    expect(guide).toContain("move or symlink the repository");
  });

  it("documents the tick schedule and the upgrade-from-fixed-agents runbook (#193)", () => {
    // A gate nobody can act on is not a migration. The runbook has to name both
    // retired agents, the unload, and the load — the operator's whole path off
    // the fixed schedule — because nothing in the repository can perform it.
    const guide = readFileSync(RUNNING_GUIDE, "utf8");
    expect(guide).toContain("backup at 03:00");
    expect(guide).toContain("tick every 15 minutes");
    expect(guide).toContain("Upgrading from the fixed schedule");
    expect(guide).toContain("launchctl unload ~/Library/LaunchAgents/com.sk.refresh.plist");
    expect(guide).toContain("launchctl unload ~/Library/LaunchAgents/com.sk.digest.plist");
    expect(guide).toContain("launchctl load ~/Library/LaunchAgents/com.sk.tick.plist");
    // The restore runbook's unload list must also cover the tick, or a restore
    // runs against a database a scheduled job is still writing.
    expect(guide).toContain("launchctl unload ~/Library/LaunchAgents/com.sk.tick.plist");
  });

  it("keeps the npm script the plist invokes (#193)", () => {
    // rules/testing.md: never test a gate's logic without pinning what invokes
    // it. The plist's whole command is `npm run tick`, so a renamed or deleted
    // script is a scheduled agent that fails four times an hour, silently.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.tick).toBe("tsx src/cli/tick.ts");
  });

  it("reports template contract drift with stable diagnostics", () => {
    const root = copyRoot();
    try {
      const tick = join(root, "ops/templates/com.sk.tick.plist");
      writeFileSync(tick, readFileSync(tick, "utf8").replace("npm run tick", "npm run missing").replace("</plist>", ""));
      writeFileSync(join(root, "ops/templates/litestream.yml"), "dbs:\n  - path: BAD_DIR/bryce.db\n    AWS_SECRET_ACCESS_KEY: leaked\n");
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
      delete pkg.scripts["db:backup"];
      writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
      const issues = validateOperationalTemplates(root).join("\n");
      expect(issues).toContain("com.sk.tick.plist: invalid plist hierarchy");
      expect(issues).toContain("com.sk.backup.plist: package.json lacks npm script db:backup");
      expect(issues).toContain("litestream.yml: unknown placeholder BAD_DIR");
      expect(issues).toContain("litestream.yml: secret-like assignment is not allowed");
      expect(issues).toContain("litestream.yml: invalid YAML hierarchy or replica mapping");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an unquoted root path in a shell command", () => {
    const root = copyRoot();
    try {
      const backup = join(root, "ops/templates/com.sk.backup.plist");
      writeFileSync(backup, readFileSync(backup, "utf8").replace('"BRYCE_ROOT/logs"', "BRYCE_ROOT/logs"));
      expect(validateOperationalTemplates(root)).toContain(
        "com.sk.backup.plist: ProgramArguments must provision logs and run npm script db:backup",
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
      const tick = join(root, "ops/templates/com.sk.tick.plist");
      writeFileSync(tick, readFileSync(tick, "utf8").replace("&amp;&amp;", "&&"));
      expect(validateOperationalTemplates(root)).toContain("com.sk.tick.plist: invalid plist hierarchy");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
