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
#     A POSITIVE CONTROL runs the same fixture with only the direct child killed and
#     asserts the marker DOES appear — without it, "no marker" would also pass on a
#     fixture that never writes one, which is a vacuous test.
#   - Escalation: a descendant that IGNORES SIGTERM still dies, because the group
#     kill waits out its grace and escalates to SIGKILL instead of returning the
#     moment the leader is reaped. A reaped leader says nothing about its group.
#   - Liveness: a CLI that never drains stdin cannot hang the summon, and a child
#     exiting in the instant the deadline passes is still reaped, not discarded.
#   - A failed summon leaves NO body — including at a REUSED --out that a previous
#     successful summon already wrote, where a stale review reads exactly like a
#     fresh one.
#
# On wall-clock sleeps (rules/testing.md: "Never insert wall-clock waits in a test").
# Four cases here are IRREDUCIBLE: `--timeout`, the SIGTERM→SIGKILL grace, and the
# drain cap are all elapsed-time features, and a feature that fires on elapsed time
# cannot be proved without some elapsing. What that rule forbids is a sleep used as
# a synchronisation guess, and every remaining sleep is sized as a MARGIN, not a
# guess: each fixture's timer sits at least 500ms — mostly seconds — from the
# deadline it must land after, so scheduler jitter on a loaded runner cannot flip
# the outcome. Where a condition can be polled instead of waited on (a process
# dying, a marker appearing) the suite polls with a bound. The one case that was a
# guess — a 1.1s sleep against a 1s deadline plus a 250ms grace, a 150ms margin —
# was the flake `just_late`; the grace is now 1s and the fixture sleeps 1.5s, so
# the child's exit is centred in the window with 500ms of slack on both sides.
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
  FAKE_STARTED="$dir/grandchild-started"
  FAKE_PIDFILE="$dir/grandchild-pid"
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
  # difference the no-orphan assertion has to be able to see. 4s: the group kill
  # lands ~2s in (1s deadline + 1s final-poll grace), so the marker's timer sits a
  # full 2s past the kill it must not survive. It touches a `started` file the
  # instant it exists, so a caller can WAIT for the grandchild to be running rather
  # than guessing at process-startup latency — the guess is what flakes under load.
  slow)         ( : > "$here/grandchild-started"; sleep 4; : > "$here/child-survived" ) & wait ;;
  # A grandchild that IGNORES SIGTERM. The leader dies on the group TERM at once, so
  # a kill that returns as soon as the leader is reaped never escalates and this
  # survives; only waiting out the grace and sending SIGKILL stops it. It records
  # its pid up front so the assertion can be "is it dead?" (pollable) rather than
  # "did a timer fire?" (a wall-clock guess).
  stubborn)     ruby -e 'Signal.trap("TERM","IGNORE"); File.write(ARGV[0], Process.pid); sleep 120' \
                  "$here/grandchild-pid" & sleep 120 ;;
  # Never reads stdin, so a synchronous stdin write of more than a pipe buffer
  # would block the summon forever instead of timing out.
  ignore_stdin) sleep 30 ;;
  # Exits just PAST the deadline the test gives it: a complete review that arrives
  # in the instant the poll loop crosses its cap. Against `--timeout 1` and a 1s
  # final-poll grace, 1.5s centres the exit in the accept window (1.0s-2.0s) with
  # 500ms of slack on either side.
  just_late)    sleep 1.5; cat "$here/body" ;;
  # Emits a full review, then leaves a grandchild holding stdout open. The child is
  # reaped at once but the read never sees EOF, so the drain hits its cap (5s) with a
  # complete review it cannot return. The grandchild's own timer is far past that cap
  # so it cannot expire early and close the pipe on its own; the summon's group kill
  # is what ends it.
  holds_pipe)   cat "$here/body"; ( sleep 30 ) & ;;
  banner)       printf '[2026-07-20] OpenAI Codex v0.51.0\n' ;;
  # Exactly $FLOOR bytes, then one byte more than that, as the floor's two sides.
  at_floor)     head -c "$(cat "$here/floor")" /dev/zero | tr '\0' 'x' ;;
  under_floor)  n="$(cat "$here/floor")"; head -c "$((n - 1))" /dev/zero | tr '\0' 'x' ;;
  # Whitespace padding around a single token: comfortably over the floor by RAW
  # bytes, far under it by bytes of actual review text. Emptiness is judged after a
  # strip, so the floor must be too, or the two checks disagree about what "content"
  # means and padding buys a pass.
  padded)       n="$(cat "$here/floor")"; head -c "$((n + 20))" /dev/zero | tr '\0' ' '; printf 'ok' ;;
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

# Waits (bounded) for a path to appear, so a fixture's progress is POLLED rather than
# guessed at with a fixed sleep — the guess is what flakes on a loaded runner.
await_file() {  # await_file <path> <tenths-of-a-second>
  local path="$1" budget="$2" waited=0
  while [ ! -e "$path" ] && [ "$waited" -lt "$budget" ]; do
    sleep 0.1; waited=$((waited + 1))
  done
  [ -e "$path" ]
}

# POSITIVE CONTROL for the orphan fixture, run FIRST. "The marker is absent" is only
# evidence if the marker can appear at all — a fixture whose grandchild silently never
# fires would pass the no-orphan assertion while proving nothing. So: run the fake
# directly and kill the DIRECT CHILD only. The grandchild is untouched by that and
# must write its marker.
make_fake_codex slow
"$FAKE_BIN" review --base main >/dev/null 2>&1 &
CTRL_PID=$!
# Wait for the grandchild to EXIST before killing its parent. Sleeping a guess here
# was the flake: under load the fake had not always forked yet, so the kill landed
# first and no grandchild ever ran — the control then failed for a reason that had
# nothing to do with what it tests.
await_file "$FAKE_STARTED" 150
report "orphan fixture control: the grandchild starts at all" $?
kill -TERM "$CTRL_PID" 2>/dev/null
wait "$CTRL_PID" 2>/dev/null
await_file "$FAKE_MARKER" 150
report "orphan fixture control: grandchild survives a kill of the direct child alone" $?

make_fake_codex slow
expect_status "child outlives --timeout -> FAILED (timeout)" 1 "FAILED (timeout)" \
  ruby "$SCRIPT" --mode work --out "$TMP/slow.md" --timeout 1 --codex-bin "$FAKE_BIN"
# Non-vacuity, in THIS run rather than by reference to the control above: if the
# grandchild never started, "no marker" would be true for the wrong reason.
[ -e "$FAKE_STARTED" ]
report "timeout -> the fixture's grandchild did start (the marker was reachable)" $?
# The GRANDCHILD would touch the marker 4s in; the group kill lands ~2s in. Wait past
# the marker's timer: the direct child dies under any kill, so only a kill of the
# whole process group stops the grandchild. A surviving marker means an orphan
# outlived the summon.
sleep 5
[ ! -e "$FAKE_MARKER" ]
report "timeout -> child process group killed, no orphan survives" $?

# Escalation. The leader dies on the group SIGTERM immediately, but this grandchild
# IGNORES SIGTERM. A kill that returns the moment the leader is reaped never reaches
# its SIGKILL, and the grandchild outlives a summon that already reported `timeout`.
# The assertion is "is that process gone?", polled — not "did a timer fire?".
make_fake_codex stubborn
expect_bounded "SIGTERM-ignoring descendant -> FAILED (timeout)" 20 1 "FAILED (timeout)" \
  ruby "$SCRIPT" --mode work --out "$TMP/stubborn.md" --timeout 1 --codex-bin "$FAKE_BIN"
await_file "$FAKE_PIDFILE" 30 && [ -s "$FAKE_PIDFILE" ]
report "escalation fixture control: the SIGTERM-ignoring grandchild really started" $?
GRANDCHILD_PID="$(cat "$FAKE_PIDFILE" 2>/dev/null)"
ESC_WAITED=0
while [ -n "$GRANDCHILD_PID" ] && kill -0 "$GRANDCHILD_PID" 2>/dev/null && [ "$ESC_WAITED" -lt 30 ]; do
  sleep 0.1; ESC_WAITED=$((ESC_WAITED + 1))
done
[ -n "$GRANDCHILD_PID" ] && ! kill -0 "$GRANDCHILD_PID" 2>/dev/null
report "timeout -> a descendant that ignores SIGTERM is escalated to SIGKILL" $?
kill -KILL "$GRANDCHILD_PID" 2>/dev/null

# A complete review that lands in the instant the poll loop crosses its cap must
# be reaped, not thrown away: the deadline is a cap on waiting, not a guillotine.
# The fixture exits 1.5s into a 1s deadline with a 1s final-poll grace — dead centre
# of the 1.0s-2.0s accept window, 500ms clear of both edges, so this cannot be
# decided by how loaded the runner is.
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
# The reader buffers as bytes arrive, so hitting the cap costs only what had not yet
# been received — a review already in hand is NOT thrown away unreported. The status
# line has to say how much arrived; a single blocking read would report zero, because
# killing that thread discards everything it was holding.
BODY_BYTES="$(wc -c < "$FAKE_BODY" | tr -d ' ')"
grep -qF "$BODY_BYTES bytes of review text had been received" "$STDOUT_FILE"
report "drain timeout -> reports the bytes that DID arrive, not a silent loss" $?

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

# Emptiness and the floor must use ONE notion of content. `blank?` strips before it
# judges, so a body of pure padding plus a token is "not empty" — and if the floor
# counts RAW bytes, that same padding carries it over a threshold whose whole job is
# to demand substance. 60 bytes of spaces plus "ok" is 62 raw bytes and 2 real ones.
make_fake_codex padded 40
expect_status "whitespace padding over the floor -> FAILED (insufficient_output)" 1 \
  "FAILED (insufficient_output)" \
  ruby "$SCRIPT" --mode work --out "$TMP/padded.md" --min-bytes 40 --codex-bin "$FAKE_BIN"
grep -qF "only 2 bytes of review text" "$STDOUT_FILE"
report "whitespace padding -> counted as 2 bytes of review text, not 62" $?
[ ! -e "$TMP/padded.md" ]
report "whitespace padding -> no body file created" $?

# The floor is an opinion, not a law: a caller that wants the old behavior can
# turn it off, and a short body then classifies exactly as it used to.
make_fake_codex banner
expect_status "--min-bytes 0 -> the floor is disabled" 0 "summon_reviewer: OK - work review" \
  ruby "$SCRIPT" --mode work --out "$TMP/nofloor.md" --min-bytes 0 --codex-bin "$FAKE_BIN"

# ---------------------------------------------------------------------------
echo "A reused --out never serves a stale review:"

# --out is reused across summons — the AC points every run at the same path. A run
# that fails AFTER an earlier success must not leave the earlier review sitting
# there: the caller cannot tell a stale body from a fresh one, and a stale critique
# read as this run's is the worst outcome this script has, worse than no review.
# So the destination is cleared before the CLI is ever spawned.
STALE_OUT="$TMP/reused.md"
make_fake_codex ok
expect_status "reused --out: first summon succeeds" 0 "summon_reviewer: OK - work review" \
  ruby "$SCRIPT" --mode work --out "$STALE_OUT" --codex-bin "$FAKE_BIN"
[ -s "$STALE_OUT" ]
report "reused --out: the first summon really wrote a body" $?

make_fake_codex review_fail
expect_status "reused --out: second summon fails -> FAILED (exit_nonzero)" 1 "FAILED (exit_nonzero)" \
  ruby "$SCRIPT" --mode work --out "$STALE_OUT" --codex-bin "$FAKE_BIN"
[ ! -e "$STALE_OUT" ]
report "a failed summon clears the previous run's body from --out" $?

# The same invariant on the paths that never reach the CLI at all: a policy refusal
# and a dead binary must not leave a stale review readable either.
make_fake_codex ok
run_summon ruby "$SCRIPT" --mode work --out "$STALE_OUT" --codex-bin "$FAKE_BIN"
expect_status "reused --out: rewritten before the self-review refusal" 1 "FAILED (self_review)" \
  ruby "$SCRIPT" --mode work --out "$STALE_OUT" --ac codex --codex-bin "$FAKE_BIN"
[ ! -e "$STALE_OUT" ]
report "a self-review refusal clears the previous run's body from --out" $?

make_fake_codex ok
run_summon ruby "$SCRIPT" --mode work --out "$STALE_OUT" --codex-bin "$FAKE_BIN"
expect_status "reused --out: rewritten before a not_found failure" 1 "FAILED (not_found)" \
  ruby "$SCRIPT" --mode work --out "$STALE_OUT" --codex-bin /nonexistent/codex
[ ! -e "$STALE_OUT" ]
report "a not_found failure clears the previous run's body from --out" $?

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

# A non-ASCII byte can arrive in a flag the parser REJECTS, before the script's own
# code runs at all. OptionParser quotes the offending argument back into its message,
# so a raw em dash in a mistyped flag reaches stderr untouched unless the top-level
# rescue renders it like every other message.
expect_status "non-ASCII in a rejected flag -> usage error" 1 "usage error" \
  ruby "$SCRIPT" --mode work --out "$TMP/uni-flag.md" "$(printf -- '--bogus\xe2\x80\x94flag')"
pure_ascii_both
report "non-ASCII in a rejected flag -> stderr stays pure ASCII" $?
expect_status "non-ASCII in a rejected --timeout -> usage error" 1 "usage error" \
  ruby "$SCRIPT" --mode work --out "$TMP/uni-timeout.md" --timeout "$(printf 'ab\xe2\x80\x94c')"
pure_ascii_both
report "non-ASCII in a rejected --timeout -> stderr stays pure ASCII" $?

# ASCII rendering must not TRUNCATE a path. The detail cap exists to stop a chatty
# CLI flooding the status output; applying it to --out would print a path the caller
# cannot use while the body was written to the real, longer one — a display cap
# silently becoming a correctness bug. A long path is ordinary in a nested worktree.
LONG_DIR="$TMP/$(printf 'l%.0s' $(seq 1 120))"
mkdir -p "$LONG_DIR"
LONG_OUT="$LONG_DIR/$(printf 'n%.0s' $(seq 1 120)).md"
make_fake_codex ok
expect_status "very long --out -> exit 0" 0 "summon_reviewer: OK - work review" \
  ruby "$SCRIPT" --mode work --out "$LONG_OUT" --codex-bin "$FAKE_BIN"
grep -qF -- "-> $LONG_OUT" "$STDOUT_FILE"
report "very long --out -> the OK line reports the WHOLE path, untruncated" $?
[ -s "$LONG_OUT" ]
report "very long --out -> the body really was written to that path" $?

# The cap still applies where it belongs. Splitting rendering from bounding must not
# quietly unbound the DETAIL line: a CLI that dumps 4000 bytes on one stderr line is
# exactly what the cap is for, and it stays capped.
make_fake_codex unicode_fail
head -c 4000 /dev/zero | tr '\0' 'E' > "$FAKE_BODY"
expect_status "a CLI flooding one stderr line -> FAILED (exit_nonzero)" 1 "FAILED (exit_nonzero)" \
  ruby "$SCRIPT" --mode work --out "$TMP/flood-out.md" --codex-bin "$FAKE_BIN"
[ "$(awk '{ if (length($0) > m) m = length($0) } END { print m }' "$STDOUT_FILE")" -le 210 ]
report "detail lines are still bounded (the cap applies to detail, not to paths)" $?

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
doc_invocation() {  # doc_invocation <mode>  -> echoes the documented command line
  grep -F -- "ruby scripts/summon_reviewer.rb --mode $1 " "$PROJECT_MD" | head -1 |
    sed -e 's/^[[:space:]]*//' -e 's/`//g'
}

# Splits the DOCUMENTED command into argv FIRST, then substitutes placeholders per
# element into an array. Substituting paths into the string and word-splitting the
# result afterwards would let a TMPDIR containing a space silently become two
# arguments — the command would still "run", it would just run a different one, and
# the case would pass while proving nothing about the documented invocation. The
# template's own tokens never contain spaces, so splitting it is safe; the values
# substituted into it are exactly what must not be split.
doc_argv() {  # doc_argv <mode> <PLACEHOLDER=value>...  -> sets the DOC_ARGV array
  local mode="$1"; shift
  local line tok pair
  line="$(doc_invocation "$mode")"
  DOC_ARGV=()
  for tok in $line; do
    case "$tok" in
      ruby|scripts/summon_reviewer.rb) continue ;;
    esac
    for pair in "$@"; do
      [ "$tok" = "${pair%%=*}" ] && tok="${pair#*=}"
    done
    DOC_ARGV+=("$tok")
  done
}

if [ ! -f "$PROJECT_MD" ]; then
  report "PROJECT.md is readable" 1 "(missing $PROJECT_MD)"
else
  report "PROJECT.md is readable" 0

  # Deliberately a directory with a SPACE in it. A real checkout under
  # "~/Library/Application Support" or a macOS volume name hits this, and it is the
  # case that separates "the documented command was run" from "some argv derived
  # from it was run".
  DOC_DIR="$TMP/doc dir"
  mkdir -p "$DOC_DIR"
  make_fake_codex ok
  DOC_PLAN="$DOC_DIR/doc-plan.md"
  DOC_OUT="$DOC_DIR/doc-review.md"
  printf '## Plan\n1. Add the widget reaper.\n' > "$DOC_PLAN"

  PLAN_CMD="$(doc_invocation plan)"
  [ -n "$PLAN_CMD" ]
  report "PROJECT.md documents a plan-mode invocation" $?
  doc_argv plan "PLAN_FILE=$DOC_PLAN" "OUT_FILE=$DOC_OUT" "AC_NAME=claude"
  expect_status "PROJECT.md's plan-mode command runs (exit 0, not a usage error)" 0 \
    "summon_reviewer: OK - plan review" \
    ruby "$SCRIPT" "${DOC_ARGV[@]}" --codex-bin "$FAKE_BIN"
  [ -s "$DOC_OUT" ]
  report "PROJECT.md's plan-mode command writes its body under a path with a space" $?

  make_fake_codex ok
  DOC_OUT="$DOC_DIR/doc-review-work.md"
  WORK_CMD="$(doc_invocation work)"
  [ -n "$WORK_CMD" ]
  report "PROJECT.md documents a work-mode invocation" $?
  doc_argv work "OUT_FILE=$DOC_OUT" "AC_NAME=claude" "BRANCH=main"
  expect_status "PROJECT.md's work-mode command runs (exit 0, not a usage error)" 0 \
    "summon_reviewer: OK - work review" \
    ruby "$SCRIPT" "${DOC_ARGV[@]}" --codex-bin "$FAKE_BIN"
  [ -s "$DOC_OUT" ]
  report "PROJECT.md's work-mode command writes its body under a path with a space" $?

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
  # An empty extraction would make the NEGATIVE grep below pass for the wrong reason
  # — a renamed heading, not an absent claim. Assert the slice is non-empty first, so
  # the negative assertion is never rescued by the positive one next to it.
  [ -n "$STAGE1" ]
  report "Stage 1 extracts a non-empty section (the negative grep means something)" $?
  ! printf '%s\n' "$STAGE1" | grep -qiE 'the AC summons the Reviewer'
  report "Stage 1 does not claim an AC summon the script cannot perform" $?
  printf '%s\n' "$STAGE1" | grep -qiF "Reviewer"
  report "Stage 1 still requires a Reviewer pass on the assessment" $?
  grep -qiF "send this assessment to the Reviewer" "$ASSESS_MD"
  report "assess/SKILL.md still routes the assessment through the HC" $?

  STAGE2="$(awk '/^### Stage 2: Plan/{f=1} /^### Stage 3:/{f=0} f' "$LIFECYCLE_MD")"
  [ -n "$STAGE2" ]
  report "Stage 2 extracts a non-empty section" $?
  printf '%s\n' "$STAGE2" | grep -qiF "the AC summons the Reviewer"
  report "Stage 2 keeps the AC summon (plan mode exists)" $?
  STAGE4="$(awk '/^### Stage 4: Verify/{f=1} /^### Stage 5:/{f=0} f' "$LIFECYCLE_MD")"
  [ -n "$STAGE4" ]
  report "Stage 4 extracts a non-empty section" $?
  printf '%s\n' "$STAGE4" | grep -qiF "summoned the Reviewer"
  report "Stage 4 keeps the AC summon (work mode exists)" $?

  # The plan critique BLOCKS the handoff to Implement. `devise` says so, but `devise`
  # is not the only door into Stage 3: an agent entering through `invoke` directly, or
  # through `ship`'s Plan->Implement step, or reading the standard's Stage 3 trigger,
  # would start coding while the critique is still outstanding. A gate only one entry
  # point enforces is not a gate, so EVERY downstream trigger has to carry it.
  STAGE3="$(awk '/^### Stage 3: Implement/{f=1} /^### Stage 4:/{f=0} f' "$LIFECYCLE_MD")"
  [ -n "$STAGE3" ]
  report "Stage 3 extracts a non-empty section" $?
  printf '%s\n' "$STAGE3" | grep -qiF "critique"
  report "Stage 3's trigger requires the plan critique, not just a posted plan" $?
  printf '%s\n' "$STAGE2" | grep -qiF "blocks the handoff"
  report "Stage 2 states the critique blocks the handoff to Implement" $?
else
  report "lifecycle standard and assess skill are readable" 1 "(missing file)"
fi

INVOKE_MD="$REPO_ROOT/skills/invoke/SKILL.md"
SHIP_MD="$REPO_ROOT/skills/ship/SKILL.md"
DEVISE_MD="$REPO_ROOT/skills/devise/SKILL.md"
if [ -f "$INVOKE_MD" ] && [ -f "$SHIP_MD" ] && [ -f "$DEVISE_MD" ]; then
  grep -qiF "critique" "$INVOKE_MD"
  report "invoke/SKILL.md requires the plan critique before implementing" $?
  # The frontmatter `description` is what a tool matches on to decide whether the
  # skill applies, so a precondition stated only in the body is one an agent can
  # enter past without ever reading it.
  awk '/^description:/{print}' "$INVOKE_MD" | grep -qiF "critique"
  report "invoke's DESCRIPTION carries the precondition (not just its body)" $?
  grep -qiF "critique" "$SHIP_MD"
  report "ship/SKILL.md gates Plan -> Implement on the critique" $?

  # The auto-approved HUMAN gate must survive all of this: the critique is the
  # Reviewer's wait, not the HC's, and conflating them would reintroduce a human
  # pause this host deliberately removed.
  grep -qiF "auto-approved" "$SHIP_MD"
  report "ship still records the plan-approval human gate as auto-approved" $?
  grep -qiF "auto-approved" "$INVOKE_MD"
  report "invoke still records the plan-approval human gate as auto-approved" $?
else
  report "invoke, ship and devise skill bodies are readable" 1 "(missing file)"
fi

# ---------------------------------------------------------------------------
echo "The plan gate's fallback is real (a gate cannot name a mechanism that cannot run):"

# The Copilot fallback is a requested-reviewer POST on a PR. Plan review happens at
# Stage 2, where no PR exists yet — Stage 3 is what opens one, and Stage 3 is blocked
# on this very critique. So the PR-based fallback CANNOT run at the plan gate, and a
# ladder that promises it there is describing a mechanism that does not exist.
if [ -f "$PROJECT_MD" ] && [ -f "$DEVISE_MD" ]; then
  grep -qiE 'fallback.*(work|PR) review|(work|PR) review.*fallback' "$PROJECT_MD"
  report "PROJECT.md scopes the PR-based fallback to work reviews" $?
  grep -qiF "no PR exists" "$PROJECT_MD"
  report "PROJECT.md says why the PR fallback cannot serve the plan gate" $?
  # What a failed PLAN summon actually does, stated plainly rather than implied.
  grep -qiE 'plan summon.*(flag|missing)' "$PROJECT_MD"
  report "PROJECT.md states what a failed PLAN summon degrades to" $?
  ! grep -qiE 'fall back to the declared fallback Reviewer' "$DEVISE_MD"
  report "devise no longer promises a fallback Reviewer the plan gate cannot reach" $?
  grep -qiF "missing plan review" "$DEVISE_MD"
  report "devise flags the missing plan review instead" $?
else
  report "PROJECT.md and devise/SKILL.md are readable" 1 "(missing file)"
fi

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
