#!/usr/bin/env bash
#
# Tests for summon_reviewer.rb (the Reviewer summon — issue #39).
#
# Run:  bash scripts/summon_reviewer.test.sh
# Exit: 0 if every case passes, 1 otherwise.
#
# These drive the REAL Ruby script against a FAKE `codex` executable built in a
# temp dir. The whole suite is therefore offline and deterministic — which is
# possible precisely because the script under test never touches the network and
# never calls the lifecycle host (the AC posts the result).
#
# Coverage map (what each block proves):
#   - Happy paths: both modes reach the CLI; in work mode the body file is the
#     CLI's raw bytes byte-for-byte, and in plan mode the plan text really
#     arrives on the CLI's stdin (the fake echoes it back to prove it).
#   - The failure ladder: every non-ok classification is reachable and distinct —
#     not_found, not_authenticated, exit_nonzero, empty_output, insufficient_output,
#     drain_timeout, timeout, self_review — so a caller can branch on the reason,
#     not just on "it failed".
#   - The substance floor: exit 0 with a banner-sized body is refused rather than
#     passed off as a review; the boundary itself (exactly --min-bytes) is accepted.
#   - Ordering guarantees: a failed auth preflight never spawns the review, and a
#     self-review refusal never spawns anything at all.
#   - No orphans: a timeout kills the child's whole process group — proved by a
#     marker a GRANDCHILD writes. The grandchild survives a kill aimed at the direct
#     child alone, so this assertion goes red if the group kill is weakened (a
#     marker written by the direct child would prove nothing: it dies either way).
#   - Liveness: a CLI that never drains stdin cannot hang the summon, and a child
#     exiting in the instant the deadline passes is still reaped, not discarded.
#   - The documented invocation runs: the exact command lines PROJECT.md tells the
#     AC to use are extracted from that file and executed. Both skill bodies read
#     the invocation from PROJECT.md and never hardcode it, so a PROJECT.md command
#     that exits 1 on usage is a broken gate — this suite refuses to let that pass.
#   - ASCII-safe stdout (rules/scripting.md, ADR 0011): a CLI emitting em dashes,
#     smart quotes and CJK cannot put a non-ASCII byte on the script's stdout,
#     on the OK path or the failure path — while the body file keeps the original
#     UTF-8 bytes untouched. The same run classifies identically under LANG=C.
#   - Usage and output-path errors exit 1 with a readable message, never a Ruby
#     backtrace.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/summon_reviewer.rb"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_MD="$REPO_ROOT/PROJECT.md"
LIFECYCLE_MD="$REPO_ROOT/docs/standards/development-lifecycle.md"
ASSESS_MD="$REPO_ROOT/skills/assess/SKILL.md"

command -v ruby >/dev/null 2>&1 || { echo "tests require ruby"; exit 1; }
[ -f "$SCRIPT" ] || { echo "missing script under test: $SCRIPT"; exit 1; }

TMP="$(mktemp -d)"
trap 'chmod -R u+rwx "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
FAKE_N=0

# --- reporting --------------------------------------------------------------
report() {  # report <name> <0-if-ok> [detail]
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" -eq 0 ]; then
    PASS=$((PASS + 1)); printf '  ok   %-58s\n' "$name"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %-58s %s\n' "$name" "$detail"
  fi
}

# Runs the script under test, capturing stdout and stderr SEPARATELY (the
# ASCII-purity assertions are about stdout alone, so they must not be merged).
run_summon() {  # run_summon <cmd...>
  STDOUT_FILE="$TMP/last.stdout"; STDERR_FILE="$TMP/last.stderr"
  "$@" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  RUN_EXIT=$?
  OUT_TEXT="$(cat "$STDOUT_FILE")"
  ERR_TEXT="$(cat "$STDERR_FILE")"
}

# Same, but with a HARD wall-clock bound on the script itself. A hang is a real
# failure mode here (an undrained stdin pipe, a missed deadline), and a hanging
# test reports nothing at all — so the bound turns "hung" into exit 124.
run_summon_bounded() {  # run_summon_bounded <limit-seconds> <cmd...>
  local limit="$1"; shift
  STDOUT_FILE="$TMP/last.stdout"; STDERR_FILE="$TMP/last.stderr"
  "$@" >"$STDOUT_FILE" 2>"$STDERR_FILE" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$((limit * 10))" ]; then
      kill -KILL "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      RUN_EXIT=124
      OUT_TEXT="$(cat "$STDOUT_FILE")"; ERR_TEXT="$(cat "$STDERR_FILE")"
      return
    fi
    sleep 0.1; waited=$((waited + 1))
  done
  wait "$pid"; RUN_EXIT=$?
  OUT_TEXT="$(cat "$STDOUT_FILE")"
  ERR_TEXT="$(cat "$STDERR_FILE")"
}

# expect_bounded <name> <limit-seconds> <want-exit> <want-substring> <cmd...>
expect_bounded() {
  local name="$1" limit="$2" want="$3" needle="$4"; shift 4
  run_summon_bounded "$limit" "$@"
  if [ "$RUN_EXIT" = "124" ]; then
    report "$name" 1 "(hung: no exit within ${limit}s)"
  elif [ "$RUN_EXIT" != "$want" ]; then
    report "$name" 1 "(want exit $want, got $RUN_EXIT)"
  elif ! printf '%s\n%s\n' "$OUT_TEXT" "$ERR_TEXT" | grep -qF -- "$needle"; then
    report "$name" 1 "(output missing \"$needle\")"
  else
    report "$name" 0
  fi
}

# expect_status <name> <want-exit> <want-substring> <cmd...>
# The substring is matched against stdout+stderr, so usage errors (stderr) and
# classifications (stdout) are both assertable through one helper.
expect_status() {
  local name="$1" want="$2" needle="$3"; shift 3
  run_summon "$@"
  if [ "$RUN_EXIT" != "$want" ]; then
    report "$name" 1 "(want exit $want, got $RUN_EXIT)"
  elif ! printf '%s\n%s\n' "$OUT_TEXT" "$ERR_TEXT" | grep -qF -- "$needle"; then
    report "$name" 1 "(output missing \"$needle\")"
  else
    report "$name" 0
  fi
}

# --- the fake codex CLI -----------------------------------------------------
# Builds a throwaway `codex` that logs every invocation and behaves per the named
# behavior. It always answers `login status` fast (except in `login_fail`), so a
# behavior only describes what the *review* subcommand does.
#
# Sets: FAKE_BIN, FAKE_LOG, FAKE_BODY (the bytes it will emit), FAKE_MARKER.
make_fake_codex() {  # make_fake_codex <behavior> [floor-bytes]
  FAKE_N=$((FAKE_N + 1))
  local dir="$TMP/fake$FAKE_N"
  mkdir -p "$dir"
  FAKE_BIN="$dir/codex"
  FAKE_LOG="$dir/invocations.log"
  FAKE_BODY="$dir/body"
  FAKE_MARKER="$dir/child-survived"
  printf '%s' "$1" > "$dir/behavior"
  printf '%s' "${2:-40}" > "$dir/floor"
  # Long enough to clear the default substance floor: the default fake is a
  # *plausible review*, so the happy paths are not quietly riding on a body no
  # real review would be that short.
  cat > "$FAKE_BODY" <<'BODY'
Findings:
1. High - the plan omits a sad-path test for the reaper: nothing covers what happens when the
   upstream feed returns a partial page, which is the failure the issue actually describes.
2. Medium - step 4 says "wire it up" without naming a file, so it cannot be implemented without
   guessing. Name the module and the call site.
Verdict: REVISE.
BODY
  cat > "$FAKE_BIN" <<'FAKE'
#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
behavior="$(cat "$here/behavior")"
printf '%s\n' "$*" >> "$here/invocations.log"
if [ "${1:-}" = "login" ]; then
  if [ "$behavior" = "login_fail" ]; then echo "not logged in" >&2; exit 1; fi
  echo "Logged in"; exit 0
fi
case "$behavior" in
  echo_stdin)   cat ;;
  empty)        : ;;
  whitespace)   printf '   \n\t\n  ' ;;
  # A GRANDCHILD writes the marker, and the direct child only waits on it. A kill
  # aimed at the direct child alone leaves the grandchild running, so the marker
  # still appears; only a kill of the whole process group prevents it. That is the
  # difference the no-orphan assertion has to be able to see.
  slow)         ( sleep 3; : > "$here/child-survived" ) & wait ;;
  # Never reads stdin, so a synchronous stdin write of more than a pipe buffer
  # would block the summon forever instead of timing out.
  ignore_stdin) sleep 30 ;;
  # Exits just PAST the deadline the test gives it: a complete review that arrives
  # in the instant the poll loop crosses its cap.
  just_late)    sleep 1.1; cat "$here/body" ;;
  # Emits a full review, then leaves a grandchild holding stdout open. The child is
  # reaped at once but the read never sees EOF, so the drain hits its cap with a
  # complete review it cannot return.
  holds_pipe)   cat "$here/body"; ( sleep 8 ) & ;;
  banner)       printf '[2026-07-20] OpenAI Codex v0.51.0\n' ;;
  # Exactly $FLOOR bytes, then one byte more than that, as the floor's two sides.
  at_floor)     head -c "$(cat "$here/floor")" /dev/zero | tr '\0' 'x' ;;
  under_floor)  n="$(cat "$here/floor")"; head -c "$((n - 1))" /dev/zero | tr '\0' 'x' ;;
  review_fail)  echo "boom: the review command failed" >&2; exit 3 ;;
  unicode_fail) cat "$here/body" >&2; exit 4 ;;
  signaled)     echo "partial review text"; kill -TERM $$; sleep 5 ;;
  *)            cat "$here/body" ;;
esac
FAKE
  chmod +x "$FAKE_BIN"
}

# True (0) when the file holds zero non-ASCII bytes.
pure_ascii() {  # pure_ascii <file>
  [ "$(LC_ALL=C tr -d '\000-\177' < "$1" | wc -c | tr -d ' ')" = "0" ]
}

# Both streams at once: an argument value echoed back to the user reaches stderr
# as readily as stdout, so an ASCII contract that only covers stdout is half a
# contract (rules/scripting.md, ADR 0011).
pure_ascii_both() {
  pure_ascii "$STDOUT_FILE" && pure_ascii "$STDERR_FILE"
}

# A unicode review body long enough to clear the default substance floor, so the
# encoding assertions test encoding and nothing else.
write_unicode_body() {  # write_unicode_body <file>
  printf 'Findings \xe2\x80\x94 the \xe2\x80\x9cwidget\xe2\x80\x9d reaper. \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\n%s\n%s\n%s\n' \
    'High: the plan does not say what happens when the upstream feed returns a partial page,' \
    'which is the exact failure the issue reports. Medium: step 4 names no file to change.' \
    'Verdict: REVISE.' > "$1"
}

# ---------------------------------------------------------------------------
echo "Happy paths (both modes reach the CLI):"

make_fake_codex ok
OUT="$TMP/work-body.md"
expect_status "work mode -> exit 0, OK status line" 0 "summon_reviewer: OK - work review" \
  ruby "$SCRIPT" --mode work --base main --out "$OUT" --codex-bin "$FAKE_BIN"
cmp -s "$OUT" "$FAKE_BODY"
report "work mode -> body file is the CLI's bytes, byte-for-byte" $?
grep -qF -- "review --base main" "$FAKE_LOG"
report "work mode -> CLI invoked as 'review --base <branch>'" $?

make_fake_codex echo_stdin
PLAN="$TMP/plan.md"
OUT="$TMP/plan-body.md"
printf '## Implementation Plan\n1. Add the widget reaper.\n' > "$PLAN"
expect_status "plan mode -> exit 0, OK status line" 0 "summon_reviewer: OK - plan review" \
  ruby "$SCRIPT" --mode plan --input "$PLAN" --out "$OUT" --codex-bin "$FAKE_BIN"
grep -qF "Add the widget reaper." "$OUT"
report "plan mode -> plan text reached the CLI on stdin" $?
grep -qxF "exec" "$FAKE_LOG"
report "plan mode -> CLI invoked as 'exec'" $?

# ---------------------------------------------------------------------------
echo "Failure ladder (each classification distinct and reachable):"

OUT="$TMP/notfound.md"
expect_status "missing codex binary -> FAILED (not_found)" 1 "FAILED (not_found)" \
  ruby "$SCRIPT" --mode work --out "$OUT" --codex-bin /nonexistent/codex
[ ! -e "$OUT" ]
report "missing codex binary -> no body file created" $?

expect_status "bare name not on PATH -> FAILED (not_found)" 1 "FAILED (not_found)" \
  ruby "$SCRIPT" --mode work --out "$TMP/notfound2.md" --codex-bin definitely-not-a-real-codex

make_fake_codex login_fail
OUT="$TMP/noauth.md"
expect_status "login status fails -> FAILED (not_authenticated)" 1 "FAILED (not_authenticated)" \
  ruby "$SCRIPT" --mode work --out "$OUT" --codex-bin "$FAKE_BIN"
! grep -qE '^(review|exec)' "$FAKE_LOG"
report "login status fails -> review subcommand never spawned" $?

make_fake_codex review_fail
expect_status "review exits non-zero -> FAILED (exit_nonzero)" 1 "FAILED (exit_nonzero)" \
  ruby "$SCRIPT" --mode work --out "$TMP/nonzero.md" --codex-bin "$FAKE_BIN"

# A child killed by a signal reports NO exit code. Classifying that on `exitstatus.zero?` would read
# nil as 0 and pass partial output off as a clean review — so it must classify as a failure.
make_fake_codex signaled
OUT="$TMP/signaled.md"
expect_status "review killed by a signal -> FAILED (exit_nonzero)" 1 "FAILED (exit_nonzero)" \
  ruby "$SCRIPT" --mode work --out "$OUT" --timeout 20 --codex-bin "$FAKE_BIN"
[ ! -e "$OUT" ]
report "review killed by a signal -> partial output is not written" $?

make_fake_codex empty
OUT="$TMP/empty.md"
expect_status "exit 0 with empty stdout -> FAILED (empty_output)" 1 "FAILED (empty_output)" \
  ruby "$SCRIPT" --mode work --out "$OUT" --codex-bin "$FAKE_BIN"
[ ! -e "$OUT" ]
report "empty output -> no body file created" $?

make_fake_codex whitespace
expect_status "exit 0 with whitespace-only stdout -> FAILED (empty_output)" 1 "FAILED (empty_output)" \
  ruby "$SCRIPT" --mode work --out "$TMP/blank.md" --codex-bin "$FAKE_BIN"

make_fake_codex slow
expect_status "child outlives --timeout -> FAILED (timeout)" 1 "FAILED (timeout)" \
  ruby "$SCRIPT" --mode work --out "$TMP/slow.md" --timeout 1 --codex-bin "$FAKE_BIN"
# The fake's GRANDCHILD would touch the marker 3s in. Wait past that: the direct
# child dies under any kill, so only a kill of the whole process group stops the
# grandchild. A surviving marker means an orphan outlived the summon.
sleep 4
[ ! -e "$FAKE_MARKER" ]
report "timeout -> child process group killed, no orphan survives" $?

# A complete review that lands in the instant the poll loop crosses its cap must
# be reaped, not thrown away: the deadline is a cap on waiting, not a guillotine.
make_fake_codex just_late
OUT="$TMP/just-late.md"
expect_bounded "child exits just past the deadline -> reaped, not timed out" 10 0 \
  "summon_reviewer: OK - work review" \
  ruby "$SCRIPT" --mode work --out "$OUT" --timeout 1 --codex-bin "$FAKE_BIN"
cmp -s "$OUT" "$FAKE_BODY"
report "child exits just past the deadline -> its review is kept intact" $?

# The CLI finished and spoke, but a surviving child holds stdout open so the read
# never sees EOF. That is a LOST review, not a silent CLI — reporting it as
# `empty_output` would blame the CLI for the summon's own dropped bytes.
make_fake_codex holds_pipe
OUT="$TMP/held.md"
expect_bounded "stdout held open past the drain cap -> FAILED (drain_timeout)" 30 1 \
  "FAILED (drain_timeout)" \
  ruby "$SCRIPT" --mode work --out "$OUT" --timeout 20 --codex-bin "$FAKE_BIN"
! grep -qF "empty_output" "$STDOUT_FILE"
report "drain timeout -> not misreported as empty_output" $?
[ ! -e "$OUT" ]
report "drain timeout -> no body file created" $?

# A CLI that never drains stdin must not be able to hang the summon. The payload
# is far larger than any pipe buffer (16KB macOS / 64KB Linux), so a synchronous
# write on the main thread blocks BEFORE the deadline is ever being watched.
make_fake_codex ignore_stdin
BIG_PLAN="$TMP/big-plan.md"
head -c 400000 /dev/zero | tr '\0' 'p' > "$BIG_PLAN"
expect_bounded "CLI never reads a 400KB stdin -> FAILED (timeout), no hang" 25 1 \
  "FAILED (timeout)" \
  ruby "$SCRIPT" --mode plan --input "$BIG_PLAN" --out "$TMP/big.md" --timeout 2 \
    --codex-bin "$FAKE_BIN"

# ---------------------------------------------------------------------------
echo "Substance floor (a banner is not a review):"

# The real CLI prints a workdir/model/provider preamble before it says anything,
# and exit 0 with only that is the F9 failure mode: a summon that reports OK
# having received no review at all.
make_fake_codex banner
OUT="$TMP/banner.md"
expect_status "banner-only stdout -> FAILED (insufficient_output)" 1 "FAILED (insufficient_output)" \
  ruby "$SCRIPT" --mode work --out "$OUT" --codex-bin "$FAKE_BIN"
[ ! -e "$OUT" ]
report "banner-only stdout -> no body file created" $?
run_summon ruby "$SCRIPT" --mode work --out "$OUT" --codex-bin "$FAKE_BIN"
! grep -qF "summon_reviewer: OK" "$STDOUT_FILE"
report "banner-only stdout -> never reported as an OK review" $?

# The boundary itself, from both sides. `--min-bytes` is the floor, and a body
# exactly that long is a review (>=), not a near miss.
make_fake_codex at_floor 40
expect_status "body exactly --min-bytes -> accepted" 0 "summon_reviewer: OK - work review, 40 bytes" \
  ruby "$SCRIPT" --mode work --out "$TMP/at-floor.md" --min-bytes 40 --codex-bin "$FAKE_BIN"

make_fake_codex under_floor 40
expect_status "body one byte under --min-bytes -> FAILED (insufficient_output)" 1 \
  "FAILED (insufficient_output)" \
  ruby "$SCRIPT" --mode work --out "$TMP/under-floor.md" --min-bytes 40 --codex-bin "$FAKE_BIN"

make_fake_codex at_floor 41
expect_status "body one byte over --min-bytes -> accepted" 0 "summon_reviewer: OK - work review, 41 bytes" \
  ruby "$SCRIPT" --mode work --out "$TMP/over-floor.md" --min-bytes 40 --codex-bin "$FAKE_BIN"

# The floor is an opinion, not a law: a caller that wants the old behavior can
# turn it off, and a short body then classifies exactly as it used to.
make_fake_codex banner
expect_status "--min-bytes 0 -> the floor is disabled" 0 "summon_reviewer: OK - work review" \
  ruby "$SCRIPT" --mode work --out "$TMP/nofloor.md" --min-bytes 0 --codex-bin "$FAKE_BIN"

echo "Failure ladder, continued:"

make_fake_codex ok
OUT="$TMP/self.md"
expect_status "--ac codex -> FAILED (self_review)" 1 "FAILED (self_review)" \
  ruby "$SCRIPT" --mode work --out "$OUT" --ac codex --codex-bin "$FAKE_BIN"
[ ! -e "$FAKE_LOG" ]
report "--ac codex -> the CLI is never spawned at all" $?
expect_status "--ac CoDeX -> FAILED (self_review), case-insensitive" 1 "FAILED (self_review)" \
  ruby "$SCRIPT" --mode work --out "$OUT" --ac CoDeX --codex-bin "$FAKE_BIN"

# ---------------------------------------------------------------------------
echo "Encoding safety (ASCII-only stdout; body bytes untouched):"

make_fake_codex ok
OUT="$TMP/unicode.md"
write_unicode_body "$FAKE_BODY"
expect_status "unicode review body -> exit 0, OK status line" 0 "summon_reviewer: OK - work review" \
  ruby "$SCRIPT" --mode work --out "$OUT" --codex-bin "$FAKE_BIN"
pure_ascii "$STDOUT_FILE"
report "unicode review body -> script stdout is pure ASCII" $?
cmp -s "$OUT" "$FAKE_BODY"
report "unicode review body -> body file keeps the original UTF-8 bytes" $?

# A real plan is full of em dashes, and the prompt wrapping it is one em dash away from making that
# a hard Encoding::CompatibilityError. Locks in the binary-assembled payload: the plan's bytes must
# reach the CLI intact whatever either side's encoding.
make_fake_codex echo_stdin
PLAN="$TMP/plan-unicode.md"
OUT="$TMP/plan-unicode-body.md"
printf '## Plan \xe2\x80\x94 stage one\n1. Ship the \xe2\x80\x9creaper\xe2\x80\x9d. \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\n' > "$PLAN"
expect_status "unicode plan text -> exit 0, OK status line" 0 "summon_reviewer: OK - plan review" \
  ruby "$SCRIPT" --mode plan --input "$PLAN" --out "$OUT" --codex-bin "$FAKE_BIN"
grep -qF "$(printf 'Ship the \xe2\x80\x9creaper\xe2\x80\x9d')" "$OUT"
report "unicode plan text -> reached the CLI stdin byte-intact" $?
pure_ascii "$STDOUT_FILE"
report "unicode plan text -> script stdout is still pure ASCII" $?

make_fake_codex unicode_fail
printf 'fatal \xe2\x80\x94 sandbox denied \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\n' > "$FAKE_BODY"
expect_status "unicode on the failure path -> FAILED (exit_nonzero)" 1 "FAILED (exit_nonzero)" \
  ruby "$SCRIPT" --mode work --out "$TMP/unicode-fail.md" --codex-bin "$FAKE_BIN"
pure_ascii "$STDOUT_FILE"
report "unicode CLI stderr -> detail lines stay pure ASCII" $?

make_fake_codex ok
OUT="$TMP/clocale.md"
write_unicode_body "$FAKE_BODY"
expect_status "LANG=C LC_ALL=C run -> classification unchanged" 0 "summon_reviewer: OK - work review" \
  env LANG=C LC_ALL=C ruby "$SCRIPT" --mode work --out "$OUT" --codex-bin "$FAKE_BIN"
cmp -s "$OUT" "$FAKE_BODY"
report "LANG=C LC_ALL=C run -> body bytes still untouched" $?

# The ASCII contract covers everything the script SAYS, not just what the CLI
# hands it. An argument value is echoed back on the OK line and in every path
# error, and a path with an em dash in it is ordinary on a Mac — so argument
# values have to go through the same ASCII rendering as CLI-derived strings, on
# stderr as well as stdout.
UNI_DIR="$TMP/$(printf 'out\xe2\x80\x94dir')"
mkdir -p "$UNI_DIR"
make_fake_codex ok
expect_status "non-ASCII --out on the OK path -> exit 0" 0 "summon_reviewer: OK - work review" \
  ruby "$SCRIPT" --mode work --out "$UNI_DIR/review.md" --codex-bin "$FAKE_BIN"
pure_ascii_both
report "non-ASCII --out -> stdout AND stderr stay pure ASCII" $?

expect_status "non-ASCII --out in a missing directory -> write error" 1 "cannot write output" \
  ruby "$SCRIPT" --mode work --out "$TMP/$(printf 'nope\xe2\x80\x94dir')/review.md" \
    --codex-bin "$FAKE_BIN"
pure_ascii_both
report "non-ASCII --out path error -> stdout AND stderr stay pure ASCII" $?

expect_status "non-ASCII --input that does not exist -> usage error" 1 "usage error" \
  ruby "$SCRIPT" --mode plan --input "$TMP/$(printf 'plan\xe2\x80\x94missing.md')" \
    --out "$TMP/uni-input.md" --codex-bin "$FAKE_BIN"
pure_ascii_both
report "non-ASCII --input error -> stdout AND stderr stay pure ASCII" $?

# ---------------------------------------------------------------------------
echo "Usage and output-path errors (readable, never a backtrace):"

make_fake_codex ok
expect_status "missing --mode -> usage error" 1 "usage error" \
  ruby "$SCRIPT" --out "$TMP/nomode.md" --codex-bin "$FAKE_BIN"
expect_status "--mode bogus -> usage error" 1 "usage error" \
  ruby "$SCRIPT" --mode bogus --out "$TMP/bogus.md" --codex-bin "$FAKE_BIN"
expect_status "missing --out -> usage error" 1 "usage error" \
  ruby "$SCRIPT" --mode work --codex-bin "$FAKE_BIN"
expect_status "plan mode without --input -> usage error" 1 "usage error" \
  ruby "$SCRIPT" --mode plan --out "$TMP/noinput.md" --codex-bin "$FAKE_BIN"
expect_status "unknown flag -> usage error" 1 "usage error" \
  ruby "$SCRIPT" --mode work --out "$TMP/x.md" --nonsense

# An unwritable --out must be caught up front with a distinct message. root
# ignores chmod 000, so under root use a parent that is a regular file — an
# unwritable path for every uid.
if [ "$(id -u)" = "0" ]; then
  : > "$TMP/not-a-dir"
  BAD_OUT="$TMP/not-a-dir/review.md"
else
  mkdir -p "$TMP/locked"; chmod 000 "$TMP/locked"
  BAD_OUT="$TMP/locked/review.md"
fi
expect_status "unwritable --out -> distinct write error" 1 "cannot write output" \
  ruby "$SCRIPT" --mode work --out "$BAD_OUT" --codex-bin "$FAKE_BIN"
! grep -qE '\.rb:[0-9]+:in' "$STDERR_FILE"
report "unwritable --out -> no Ruby backtrace" $?
chmod 755 "$TMP/locked" 2>/dev/null

# ---------------------------------------------------------------------------
echo "The documented invocation (PROJECT.md is the only source the skills read):"

# `devise` and `verify` both say to read the summon command from PROJECT.md and
# never hardcode it. So PROJECT.md's command lines ARE the interface: if they are
# missing a required flag they exit 1 on usage and the Reviewer gate silently
# becomes the fallback path forever. These cases lift the literal lines out of
# PROJECT.md, substitute the placeholders, and run them.
doc_invocation() {  # doc_invocation <mode>  -> echoes the documented arg list
  grep -F -- "ruby scripts/summon_reviewer.rb --mode $1 " "$PROJECT_MD" | head -1 |
    sed -e 's/^[[:space:]]*//' -e 's/`//g'
}

if [ ! -f "$PROJECT_MD" ]; then
  report "PROJECT.md is readable" 1 "(missing $PROJECT_MD)"
else
  report "PROJECT.md is readable" 0

  make_fake_codex ok
  DOC_PLAN="$TMP/doc-plan.md"
  DOC_OUT="$TMP/doc-review.md"
  printf '## Plan\n1. Add the widget reaper.\n' > "$DOC_PLAN"

  PLAN_CMD="$(doc_invocation plan)"
  [ -n "$PLAN_CMD" ]
  report "PROJECT.md documents a plan-mode invocation" $?
  # shellcheck disable=SC2086
  PLAN_ARGS="$(printf '%s' "$PLAN_CMD" |
    sed -e "s#^ruby scripts/summon_reviewer.rb##" \
        -e "s#PLAN_FILE#$DOC_PLAN#" -e "s#OUT_FILE#$DOC_OUT#" -e "s#AC_NAME#claude#")"
  expect_status "PROJECT.md's plan-mode command runs (exit 0, not a usage error)" 0 \
    "summon_reviewer: OK - plan review" \
    ruby "$SCRIPT" $PLAN_ARGS --codex-bin "$FAKE_BIN"

  make_fake_codex ok
  DOC_OUT="$TMP/doc-review-work.md"
  WORK_CMD="$(doc_invocation work)"
  [ -n "$WORK_CMD" ]
  report "PROJECT.md documents a work-mode invocation" $?
  # shellcheck disable=SC2086
  WORK_ARGS="$(printf '%s' "$WORK_CMD" |
    sed -e "s#^ruby scripts/summon_reviewer.rb##" \
        -e "s#OUT_FILE#$DOC_OUT#" -e "s#AC_NAME#claude#" -e "s#BRANCH#main#")"
  expect_status "PROJECT.md's work-mode command runs (exit 0, not a usage error)" 0 \
    "summon_reviewer: OK - work review" \
    ruby "$SCRIPT" $WORK_ARGS --codex-bin "$FAKE_BIN"

  # The `--ac` guard only ever fires when the AC is Codex, which is exactly the
  # case an undocumented flag would leave unreachable: default `--ac claude`
  # would let Codex review its own work. So the documented command must carry it.
  printf '%s\n%s\n' "$PLAN_CMD" "$WORK_CMD" | grep -qF -- "--ac "
  report "the documented invocations pass --ac (the self-review guard is reachable)" $?
  printf '%s\n%s\n' "$PLAN_CMD" "$WORK_CMD" | grep -qF -- "--out "
  report "the documented invocations pass --out (it is required)" $?

  # A usage error is not one of the classifications, so a ladder written as "on
  # any of the classifications, fall back" leaves the most likely operator
  # mistake uncovered. The declared trigger has to be the exit status.
  grep -qiF "any non-zero exit" "$PROJECT_MD"
  report "PROJECT.md routes ANY non-zero exit to the fallback Reviewer" $?
  grep -qF "insufficient_output" "$PROJECT_MD"
  report "PROJECT.md documents the insufficient_output classification" $?
  grep -qF "drain_timeout" "$PROJECT_MD"
  report "PROJECT.md documents the drain_timeout classification" $?
fi

# ---------------------------------------------------------------------------
echo "Standard/skill agreement (no gate claims a mechanism that does not exist):"

# The summon has plan and work modes only — there is no assessment mode. A
# standard that tells the AC to summon the Reviewer at Stage 1 therefore
# describes a gate no one can run, and contradicts assess/SKILL.md, which asks
# the HC to route the assessment. Documentation drift is a real defect here:
# these files ARE the instructions the agents execute.
if [ -f "$LIFECYCLE_MD" ] && [ -f "$ASSESS_MD" ]; then
  STAGE1="$(awk '/^### Stage 1: Assess/{f=1} /^### Stage 2:/{f=0} f' "$LIFECYCLE_MD")"
  ! printf '%s\n' "$STAGE1" | grep -qiE 'the AC summons the Reviewer'
  report "Stage 1 does not claim an AC summon the script cannot perform" $?
  printf '%s\n' "$STAGE1" | grep -qiF "Reviewer"
  report "Stage 1 still requires a Reviewer pass on the assessment" $?
  grep -qiF "send this assessment to the Reviewer" "$ASSESS_MD"
  report "assess/SKILL.md still routes the assessment through the HC" $?

  STAGE2="$(awk '/^### Stage 2: Plan/{f=1} /^### Stage 3:/{f=0} f' "$LIFECYCLE_MD")"
  printf '%s\n' "$STAGE2" | grep -qiF "the AC summons the Reviewer"
  report "Stage 2 keeps the AC summon (plan mode exists)" $?
  STAGE4="$(awk '/^### Stage 4: Verify/{f=1} /^### Stage 5:/{f=0} f' "$LIFECYCLE_MD")"
  printf '%s\n' "$STAGE4" | grep -qiF "summoned the Reviewer"
  report "Stage 4 keeps the AC summon (work mode exists)" $?
else
  report "lifecycle standard and assess skill are readable" 1 "(missing file)"
fi

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
