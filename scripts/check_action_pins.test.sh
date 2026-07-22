#!/usr/bin/env bash
#
# Tests for check-action-pins.ts (the supply-chain action-pin guard — issue #59).
#
# Run:  bash scripts/check_action_pins.test.sh
# Exit: 0 if every case passes, 1 otherwise.
#
# Drives the REAL TypeScript script (via tsx) against FIXTURE workflow trees built in a temp dir,
# so the suite is offline and deterministic. Coverage: a SHA-pinned workflow
# passes; a mutable tag, a branch ref, a missing ref, and a too-short hex each
# fail; local (`./`) and docker refs are exempt; the offender count is exact; and
# stdout stays ASCII under LANG=C.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-action-pins.ts"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TSX="$REPO_ROOT/node_modules/.bin/tsx"

[ -x "$TSX" ] || { echo "tests require tsx (run: npm ci)"; exit 1; }

PASS=0
FAIL=0
SHA="11d5960a326750d5838078e36cf38b85af677262" # a real 40-hex SHA shape

mk_workflow() { # $1=root  $2=filename  $3=uses-value
  mkdir -p "$1/.github/workflows"
  cat >"$1/.github/workflows/$2" <<YAML
name: fixture
on: [push]
permissions:
  contents: read
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: $3
YAML
}

check() { # $1=label  $2=expected-exit  $3=root  [$4=expected substring in output]
  local label="$1" want="$2" root="$3" needle="${4:-}"
  local out rc
  out="$("$TSX" "$SCRIPT" --root "$root" 2>&1)"
  rc=$?
  if [ "$rc" -ne "$want" ]; then
    echo "  FAIL  $label (exit $rc, wanted $want)"; FAIL=$((FAIL + 1)); return
  fi
  if [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF "$needle"; then
    echo "  FAIL  $label (output missing: $needle)"; FAIL=$((FAIL + 1)); return
  fi
  echo "  ok    $label"; PASS=$((PASS + 1))
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. SHA-pinned external action -> pass
R="$TMP/pinned"; mk_workflow "$R" app.yml "actions/checkout@$SHA # v4.4.0"
check "SHA-pinned action passes" 0 "$R" "OK"

# 2. mutable tag -> fail, names the offender
R="$TMP/tag"; mk_workflow "$R" app.yml "actions/checkout@v4"
check "mutable tag fails" 1 "$R" "actions/checkout@v4"

# 3. branch ref -> fail
R="$TMP/branch"; mk_workflow "$R" app.yml "actions/checkout@main"
check "branch ref fails" 1 "$R" "FAIL"

# 4. no ref at all -> fail
R="$TMP/noref"; mk_workflow "$R" app.yml "actions/checkout"
check "missing ref fails" 1 "$R" "FAIL"

# 5. too-short hex (not 40) -> fail
R="$TMP/short"; mk_workflow "$R" app.yml "actions/checkout@11d5960"
check "short hex fails" 1 "$R" "FAIL"

# 6. local action -> exempt (pass)
R="$TMP/local"; mk_workflow "$R" app.yml "./.github/actions/local"
check "local ./ action is exempt" 0 "$R" "OK"

# 7. exact offender count across two files
R="$TMP/count"
mk_workflow "$R" a.yml "actions/checkout@$SHA # v4.4.0"
mk_workflow "$R" b.yml "actions/setup-node@v4"
check "counts exactly one offender" 1 "$R" "1 unpinned"

# 8. ASCII-safe stdout under LANG=C (rules/scripting.md, ADR 0011).
#    Detect non-ASCII bytes with tr (shell-only; BSD grep lacks -P, and the interpreter dep is gone).
R="$TMP/ascii"; mk_workflow "$R" app.yml "actions/checkout@v4"
ascii_out="$(LANG=C LC_ALL=C "$TSX" "$SCRIPT" --root "$R" 2>&1)"
if [ "$(printf '%s' "$ascii_out" | LC_ALL=C tr -d '\000-\177' | wc -c | tr -d ' ')" = "0" ]; then
  echo "  ok    ASCII-safe stdout"; PASS=$((PASS + 1))
else
  echo "  FAIL  ASCII-safe stdout"; FAIL=$((FAIL + 1))
fi

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
