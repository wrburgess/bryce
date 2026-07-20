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
#     not_found, not_authenticated, exit_nonzero, empty_output, timeout,
#     self_review — so a caller can branch on the reason, not just on "it failed".
#   - Ordering guarantees: a failed auth preflight never spawns the review, and a
#     self-review refusal never spawns anything at all.
#   - No orphans: a timeout kills the child's whole process group — proved by a
#     marker file the child would have written had it survived the kill.
#   - ASCII-safe stdout (rules/scripting.md, ADR 0011): a CLI emitting em dashes,
#     smart quotes and CJK cannot put a non-ASCII byte on the script's stdout,
#     on the OK path or the failure path — while the body file keeps the original
#     UTF-8 bytes untouched. The same run classifies identically under LANG=C.
#   - Usage and output-path errors exit 1 with a readable message, never a Ruby
#     backtrace.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/summon_reviewer.rb"

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
make_fake_codex() {  # make_fake_codex <behavior>
  FAKE_N=$((FAKE_N + 1))
  local dir="$TMP/fake$FAKE_N"
  mkdir -p "$dir"
  FAKE_BIN="$dir/codex"
  FAKE_LOG="$dir/invocations.log"
  FAKE_BODY="$dir/body"
  FAKE_MARKER="$dir/child-survived"
  printf '%s' "$1" > "$dir/behavior"
  printf 'Findings:\n1. High - the plan omits a sad-path test.\n' > "$FAKE_BODY"
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
  slow)         sleep 3; : > "$here/child-survived"; echo "late output" ;;
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
# The fake would touch its marker 3s in. Wait past that: if the marker appears,
# the timeout killed the parent shell but orphaned the `sleep` beneath it.
sleep 4
[ ! -e "$FAKE_MARKER" ]
report "timeout -> child process group killed, no orphan survives" $?

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
printf 'Findings \xe2\x80\x94 the \xe2\x80\x9cwidget\xe2\x80\x9d reaper. \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\n' > "$FAKE_BODY"
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
printf 'Findings \xe2\x80\x94 the \xe2\x80\x9cwidget\xe2\x80\x9d reaper. \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\n' > "$FAKE_BODY"
expect_status "LANG=C LC_ALL=C run -> classification unchanged" 0 "summon_reviewer: OK - work review" \
  env LANG=C LC_ALL=C ruby "$SCRIPT" --mode work --out "$OUT" --codex-bin "$FAKE_BIN"
cmp -s "$OUT" "$FAKE_BODY"
report "LANG=C LC_ALL=C run -> body bytes still untouched" $?

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

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
