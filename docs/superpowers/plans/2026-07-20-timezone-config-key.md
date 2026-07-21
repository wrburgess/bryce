# Timezone Config Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ambient `TZ` environment variables from silently overriding the configured host timezone, by renaming the config key to `BRYCE_TZ`.

**Architecture:** `src/env.ts` loads `.env` via Node's `process.loadEnvFile`, which never overrides a variable already present in the real environment — deliberate, and correct for secrets. `TZ` is a reserved POSIX variable that terminals and tooling set on their own, so `.env`'s `TZ=America/Chicago` loses to an ambient `TZ=UTC` and `hostDate` silently returns the UTC date. The precedence rule is right; the key name is the defect. Rename it to an app-scoped key nothing else sets.

**Tech Stack:** TypeScript, Zod (env validation), Vitest, better-sqlite3, drizzle-orm.

## Global Constraints

- Node's `--env-file` / `loadEnvFile` precedence stays as-is: **real environment variables always win**. This plan changes the key, not the rule.
- **No `TZ` fallback.** Reading `TZ` when `BRYCE_TZ` is absent would reintroduce the exact bug.
- Config is validated at the boundary with Zod and fails closed (`rules/security.md`).
- Quality gate before done: `npm run typecheck`, `npm run lint`, `npm test`, `ruby scripts/parity_check.rb`.
- Attribution trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Background: the observed failure

On 2026-07-20 at 19:27 CDT, `npm run digest -- --force` wrote a `digest_deliveries` row with
`date_covered = 2026-07-21` — the UTC date. The shell had `TZ=UTC` exported. Because no row existed
for `2026-07-21`, the run took a **fresh claim** rather than a replay, and `settleSent` recorded it
as `sent`. The next day's real digest would find that slot already `sent` and refuse with
`already-sent-today` — a silently missing digest, the exact failure ADR 0034 exists to prevent.

Task 3 repairs that row.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/config.ts` | Zod env schema and `Config` shape | Rename `TZ` key to `BRYCE_TZ`; warn when `TZ` is set but `BRYCE_TZ` is not |
| `.env.example` | Documented env template | Rename key, expand the comment |
| `docs/guides/getting-started.md` | Setup guide env table | Rename key |
| `docs/guides/running-bryce.md` | Operations env table | Rename key |
| `test/env.test.ts` | Config boundary tests | Add a regression describe block |

`src/domain/season.ts` is **not** touched. `hostDate` is already correct — it passes an explicit
`timeZone` to `Intl.DateTimeFormat` and is covered by `test/season.test.ts:67-68`. The bug never
reached it; it was fed the wrong `tz` string.

---

### Task 1: Rename the config key to `BRYCE_TZ`

**Files:**
- Modify: `src/config.ts:11` (schema key), `src/config.ts:88` (Config mapping)
- Test: `test/env.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Config.tz` keeps its name and type (`string`). Only the *environment key* changes, so no
  call site outside `loadConfig` is affected.

- [ ] **Step 1: Write the failing test**

Append to `test/env.test.ts`:

```typescript
describe("BRYCE_TZ config (ambient TZ must never win)", () => {
  const base = { MAILER_PROVIDER: "console" };

  it("reads the host timezone from BRYCE_TZ", () => {
    expect(loadConfig({ ...base, BRYCE_TZ: "America/New_York" }).tz).toBe("America/New_York");
  });

  it("defaults to America/Chicago when BRYCE_TZ is absent", () => {
    expect(loadConfig(base).tz).toBe("America/Chicago");
  });

  it("ignores TZ entirely — an ambient TZ=UTC must not become the host timezone", () => {
    // The 2026-07-20 production bug: a terminal exporting TZ=UTC defeated
    // .env's TZ=America/Chicago, and every host date shifted after 19:00 CDT.
    expect(loadConfig({ ...base, TZ: "UTC" }).tz).toBe("America/Chicago");
    expect(loadConfig({ ...base, TZ: "UTC", BRYCE_TZ: "America/Chicago" }).tz).toBe(
      "America/Chicago",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/env.test.ts -t "ambient TZ"`
Expected: FAIL — the third assertion returns `"UTC"`, because `TZ` is still the schema key.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts:11`, replace the `TZ` schema line:

```typescript
    /**
     * Host timezone for "today" — digest windows and season boundaries.
     *
     * Deliberately NOT named `TZ`. `TZ` is a reserved POSIX variable that
     * terminals, editors and CI set on their own, and `loadDotEnv` never
     * overrides a real environment variable (src/env.ts) — so a `.env` saying
     * `TZ=America/Chicago` silently loses to an ambient `TZ=UTC` and every host
     * date shifts. Observed in production 2026-07-20: an evening run recorded a
     * delivery for tomorrow's date. An app-scoped key nothing else sets is the
     * fix; the "real env wins" rule is correct and unchanged.
     */
    BRYCE_TZ: z.string().trim().min(1).default("America/Chicago"),
```

In `src/config.ts:88`, replace the mapping line:

```typescript
    tz: parsed.BRYCE_TZ,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/env.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. `Config.tz` is unchanged, so no consumer needs editing.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/env.test.ts
git commit -m "$(cat <<'EOF'
Rename the host timezone key to BRYCE_TZ

TZ is a reserved POSIX variable that ambient tooling sets, and
loadDotEnv never overrides a real environment variable — so .env's
TZ=America/Chicago silently lost to a shell exporting TZ=UTC and every
host date shifted after 19:00 CDT.

The precedence rule is right for secrets and is unchanged. The key name
was the defect. No TZ fallback: reading it when BRYCE_TZ is absent would
reintroduce the bug.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Warn when a stale `TZ` is set and `BRYCE_TZ` is not

**Files:**
- Modify: `src/config.ts` (inside `loadConfig`)
- Test: `test/env.test.ts`

**Interfaces:**
- Consumes: `BRYCE_TZ` from Task 1.
- Produces: no signature change. `loadConfig(env, warn?)` gains an optional second parameter
  `warn: (message: string) => void`, defaulting to a stderr write, so the test can capture it.

**Why:** an existing `.env` still says `TZ=America/Chicago`. After Task 1 that line is inert and the
default silently applies. Someone whose real timezone is not `America/Chicago` would get wrong
windows with no signal. A one-line warning turns a silent misconfiguration into a visible one.

- [ ] **Step 1: Write the failing test**

Append to the `describe("BRYCE_TZ config ...")` block in `test/env.test.ts`:

```typescript
  it("warns when TZ is set but BRYCE_TZ is not, so a stale .env is visible", () => {
    const warnings: string[] = [];
    loadConfig({ ...base, TZ: "America/Denver" }, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("BRYCE_TZ");
    expect(warnings[0]).toContain("America/Denver");
  });

  it("does not warn once BRYCE_TZ is set", () => {
    const warnings: string[] = [];
    loadConfig({ ...base, TZ: "America/Denver", BRYCE_TZ: "America/Denver" }, (m) =>
      warnings.push(m),
    );
    expect(warnings).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/env.test.ts -t "stale .env"`
Expected: FAIL — `loadConfig` takes one parameter, so the callback is ignored and `warnings` is empty.

- [ ] **Step 3: Write minimal implementation**

Replace the `loadConfig` signature and opening lines in `src/config.ts`:

```typescript
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): Config {
  const parsed = EnvSchema.parse(env);

  // A .env written before the rename still says TZ=..., which is now inert.
  // Silence there would mean wrong windows with no signal, so say so once.
  if (env.BRYCE_TZ === undefined && typeof env.TZ === "string" && env.TZ.trim().length > 0) {
    warn(
      `config: TZ=${env.TZ.trim()} is ignored — set BRYCE_TZ instead ` +
        `(using ${parsed.BRYCE_TZ}). TZ is a reserved variable ambient tooling sets.`,
    );
  }

  return {
```

The rest of the `return` object is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/env.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. Watch for suites that call `loadConfig` with a real `process.env` — the warning goes
to stderr and must not fail anything.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/env.test.ts
git commit -m "$(cat <<'EOF'
Warn when a stale TZ is set without BRYCE_TZ

A .env written before the rename still carries TZ=..., now inert. Without
a warning that reads as working config while the default quietly applies,
which is wrong windows with no signal.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Update the env template and guides, and repair the stray delivery row

**Files:**
- Modify: `.env.example:7-8`
- Modify: `docs/guides/getting-started.md:97`
- Modify: `docs/guides/running-bryce.md:59`

**Interfaces:**
- Consumes: `BRYCE_TZ` from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update `.env.example`**

Replace lines 7-8:

```
# Host timezone used for "today" (digest windows, season boundaries).
# Deliberately not named TZ: that is a reserved variable terminals and CI set
# on their own, and a real environment variable always beats this file.
BRYCE_TZ=America/Chicago
```

- [ ] **Step 2: Update `docs/guides/getting-started.md:97`**

Replace the table row:

```
| `BRYCE_TZ` | Your timezone — defines "today" for digests and season boundaries | `America/Chicago` |
```

- [ ] **Step 3: Update `docs/guides/running-bryce.md:59`**

Replace the table row:

```
| `BRYCE_TZ` | no | `America/Chicago` | Host timezone for "today" (digest windows, season math) |
```

- [ ] **Step 4: Verify no `TZ=` key remains**

Run: `grep -rn "^TZ=\|\`TZ\`" .env.example docs/guides src`
Expected: no matches. Occurrences of `BRYCE_TZ` are fine; the standalone key must be gone.

- [ ] **Step 5: Run the quality gate**

Run: `npm run typecheck && npm run lint && npm test && ruby scripts/parity_check.rb`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add .env.example docs/guides/getting-started.md docs/guides/running-bryce.md
git commit -m "$(cat <<'EOF'
Document BRYCE_TZ in the env template and guides

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Update the live `.env` — operator action**

This file is untracked and machine-local, so no commit covers it.

```bash
# In the real checkout, not a worktree:
#   change   TZ=America/Chicago
#   to       BRYCE_TZ=America/Chicago
```

Verify:

```bash
npx tsx -e 'import("./src/env.js").then(async (e) => {
  e.loadDotEnv();
  const { loadConfig } = await import("./src/config.js");
  const { hostDate } = await import("./src/domain/season.js");
  const c = loadConfig();
  console.log("tz:", c.tz, "hostDate:", hostDate(new Date(), c.tz));
})'
```

Expected: `tz: America/Chicago` and a `hostDate` matching the local calendar date, **including when
run after 19:00 CDT**. That is the case that was broken.

- [ ] **Step 8: Delete the stray delivery row — operator action, destructive**

The `2026-07-21` digest row was written by the bug. Left in place, the real July 21 digest is refused
as `already-sent-today` and never sends.

**Confirm the row is the bad one before deleting.** It must have `stat_line_count = 0`,
`player_count = 0`, and a `created_at` on `2026-07-21T00:27:55.595Z` (19:27 CDT on July 20):

```bash
sqlite3 data/bryce.db \
  "select id, kind, date_covered, status, created_at, stat_line_count, player_count
   from digest_deliveries where date_covered = '2026-07-21';"
```

Only if that matches:

```bash
sqlite3 data/bryce.db \
  "delete from digest_deliveries where date_covered = '2026-07-21' and kind = 'digest';"
```

No `stat_lines` row references it — every line carries `digest_delivery_id = 1` — so the delete is
safe and leaves no dangling reference. Confirm:

```bash
sqlite3 data/bryce.db "select digest_delivery_id, count(*) from stat_lines group by 1;"
```

Expected: a single row, `1|1047`.

---

## Self-Review

**Spec coverage.** This plan implements the "Ordering" section of
`docs/superpowers/specs/2026-07-20-windowed-digest-design.md` — step 1 of 6 ("Fix the timezone
configuration key; delete the stray delivery row"). Steps 2-6 belong to the two follow-on plans and
are deliberately absent here.

**Placeholder scan.** No TBDs. Every code step carries the literal code; every command carries its
expected output.

**Type consistency.** `Config.tz` is unchanged in name and type, so no consumer outside `loadConfig`
is touched. `loadConfig`'s new second parameter is optional and defaults to a stderr write, so every
existing call site — `src/cli/*.ts`, `src/server.ts` — compiles unchanged.

**Known risk.** Task 3 Step 7 is manual and machine-local. If the live `.env` is not updated, config
falls back to the `America/Chicago` default, which happens to be correct for this host — so the
system works and the warning from Task 2 is the only signal. That is intentional: fail visible, not
silent.
