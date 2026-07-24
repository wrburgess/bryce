#!/usr/bin/env bash
#
# Tests for enforce-branch-creation.sh (Layer 3 fast-fail guard, ADR 0009).
#
# Run:  .claude/hooks/enforce-branch-creation.test.sh
# Exit: 0 if every case passes, 1 otherwise.
#
# These build throwaway git repos in a temp dir and feed the hook real
# PreToolUse-shaped JSON payloads on stdin, asserting the exit code
# (0 = allow, 2 = block). No network, no touching the real repo. The protected
# list comes from the repo's own .githooks/protected-branches sidecar (the hook
# resolves it relative to its own location), which is main/master/develop.
#
# Coverage map (what each block proves):
#   - Worktree-awareness: a write/commit in a feature-branch checkout is allowed
#     even though a *different* checkout is on main (the original misfire).
#   - Commit-to-main is blocked through every realistic Bash form: plain,
#     `git -C <dir>`, `cd <dir> && git`, and leading `ENV=val` assignments.
#   - Read-only Bash on main is allowed (the guard's scope is commits/pushes).
#   - Out-of-repo writes (the /tmp scratchpad) are allowed.
#   - Pushes targeting a protected ref are blocked even from a feature branch.
#
# This guard is the per-tool accelerator; the invocation-agnostic backstop for
# ALL commit paths (human, IDE, `--no-verify`) is the git-level pre-commit /
# pre-push hooks in .githooks/ (bin/guard-protected-branch), covered upstream by
# ai-config's test/guard_protected_branch.test.sh (the test/ tree is not
# vendored into Host Apps).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/enforce-branch-creation.sh"

command -v jq >/dev/null 2>&1 || { echo "tests require jq"; exit 1; }

TMP="$(mktemp -d)" || TMP=""
[ -n "$TMP" ] && [ -d "$TMP" ] || { echo "tests require a writable temp dir (mktemp -d failed)"; exit 1; }
trap 'rm -rf "$TMP"' EXIT

# --- build fixture repos ----------------------------------------------------
new_repo() {  # new_repo <path> <branch>
  local path="$1" branch="$2"
  git init -q -b "$branch" "$path"
  git -C "$path" config user.email t@t.test
  git -C "$path" config user.name test
  git -C "$path" commit -q --allow-empty -m init
}

MAIN_REPO="$TMP/main_checkout";     new_repo "$MAIN_REPO" main
FEAT_REPO="$TMP/feature_worktree";  new_repo "$FEAT_REPO" feature/issue-1-foo
DETACHED="$TMP/detached";           new_repo "$DETACHED" main
git -C "$DETACHED" checkout -q --detach HEAD
NONREPO="$TMP/plain_dir";           mkdir -p "$NONREPO"   # not a git repo

PASS=0; FAIL=0

# expect <name> <expected-exit> <json-payload>
expect() {
  local name="$1" want="$2" payload="$3" got
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf '  ok   %-58s (exit %s)\n' "$name" "$got"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %-58s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

write_payload() {  # write_payload <tool> <file_path> <cwd>
  jq -nc --arg t "$1" --arg f "$2" --arg c "$3" \
    '{tool_name:$t, cwd:$c, tool_input:{file_path:$f}}'
}
bash_payload() {   # bash_payload <command> <cwd>
  jq -nc --arg cmd "$1" --arg c "$2" \
    '{tool_name:"Bash", cwd:$c, tool_input:{command:$cmd}}'
}

echo "Write/Edit guard (worktree-aware):"
expect "write in feature worktree -> allow" 0 \
  "$(write_payload Edit "$FEAT_REPO/app/models/x.rb" "$FEAT_REPO")"
expect "write in main checkout -> block" 2 \
  "$(write_payload Edit "$MAIN_REPO/app/models/x.rb" "$MAIN_REPO")"
expect "write, cwd=main but file in worktree -> allow (misfire regression)" 0 \
  "$(write_payload Edit "$FEAT_REPO/CLAUDE.md" "$MAIN_REPO")"
expect "new file in new subdir of worktree -> allow" 0 \
  "$(write_payload Write "$FEAT_REPO/brand/new/dir/f.txt" "$FEAT_REPO")"
expect "new file in new subdir of main -> block" 2 \
  "$(write_payload Write "$MAIN_REPO/brand/new/dir/f.txt" "$MAIN_REPO")"
expect "write to /tmp scratchpad (no repo) -> allow" 0 \
  "$(write_payload Write "$NONREPO/scratch.txt" "$NONREPO")"
expect "write on detached HEAD -> block (fail-closed)" 2 \
  "$(write_payload Edit "$DETACHED/f.txt" "$DETACHED")"

echo "Bash guard (commits/pushes to protected branches):"
expect "git commit on feature branch -> allow" 0 \
  "$(bash_payload 'git commit -m work' "$FEAT_REPO")"
expect "git commit on main -> block" 2 \
  "$(bash_payload 'git commit -m oops' "$MAIN_REPO")"
expect "git -C <main> commit from feature cwd -> block (-C bypass)" 2 \
  "$(bash_payload "git -C $MAIN_REPO commit -m oops" "$FEAT_REPO")"
expect "cd <main> && git commit from feature cwd -> block (cd bypass)" 2 \
  "$(bash_payload "cd $MAIN_REPO && git commit -m oops" "$FEAT_REPO")"
expect "ENV=val git commit on main -> block (env-prefix bypass)" 2 \
  "$(bash_payload 'GIT_AUTHOR_NAME=x git commit -m oops' "$MAIN_REPO")"
expect "git -c k=v commit on main -> block (-c global flag)" 2 \
  "$(bash_payload 'git -c user.name=x commit -m oops' "$MAIN_REPO")"
expect "git status on main -> allow (read-only)" 0 \
  "$(bash_payload 'git status' "$MAIN_REPO")"
expect "echo > file on main -> allow (not a commit)" 0 \
  "$(bash_payload 'echo hi > notes.txt' "$MAIN_REPO")"
expect "ls -la on main -> allow (no git)" 0 \
  "$(bash_payload 'ls -la' "$MAIN_REPO")"
expect "git push (no args) on feature -> allow" 0 \
  "$(bash_payload 'git push' "$FEAT_REPO")"
expect "git push on main -> block" 2 \
  "$(bash_payload 'git push' "$MAIN_REPO")"
expect "git push origin main from feature -> block (refspec)" 2 \
  "$(bash_payload 'git push origin main' "$FEAT_REPO")"
expect "git push origin HEAD:main from feature -> block (refspec)" 2 \
  "$(bash_payload 'git push origin HEAD:main' "$FEAT_REPO")"
expect "git push origin refs/heads/main from feature -> block (full ref)" 2 \
  "$(bash_payload 'git push origin refs/heads/main' "$FEAT_REPO")"
expect "git push origin HEAD:refs/heads/main from feature -> block (full ref)" 2 \
  "$(bash_payload 'git push origin HEAD:refs/heads/main' "$FEAT_REPO")"
expect "git push origin +refs/heads/main from feature -> block (force-push)" 2 \
  "$(bash_payload 'git push origin +refs/heads/main' "$FEAT_REPO")"
expect "git push origin :main from feature -> block (delete main)" 2 \
  "$(bash_payload 'git push origin :main' "$FEAT_REPO")"
expect "git push origin feature/main-thing from feature -> allow (name contains main)" 0 \
  "$(bash_payload 'git push origin feature/main-thing' "$FEAT_REPO")"
expect "git merge on main -> block" 2 \
  "$(bash_payload 'git merge feature/x' "$MAIN_REPO")"
expect "git rebase on feature -> allow" 0 \
  "$(bash_payload 'git rebase main' "$FEAT_REPO")"

echo "Bash guard (--no-verify must not skip the git-level hooks):"
expect "git commit --no-verify on feature -> block" 2 \
  "$(bash_payload 'git commit --no-verify -m x' "$FEAT_REPO")"
expect "git commit -n on feature -> block (commit -n is --no-verify)" 2 \
  "$(bash_payload 'git commit -n -m x' "$FEAT_REPO")"
expect "git push --no-verify on feature -> block" 2 \
  "$(bash_payload 'git push --no-verify' "$FEAT_REPO")"
expect "git push -n on feature -> allow (push -n is --dry-run, not --no-verify)" 0 \
  "$(bash_payload 'git push -n' "$FEAT_REPO")"

echo "Bash guard (string-literal content must NOT be mistaken for commands):"
# Regression for the false block that scanning message/heredoc text caused:
# a commit on a FEATURE branch whose message mentions git push / HEAD:main.
HEREDOC_MSG="$(printf 'fix: thing\n\nmentions (`git push origin main`, `HEAD:main`) and\n`cd /repo/main && git commit` in prose.\n')"
expect "commit on feature, heredoc message mentions git push/HEAD:main -> allow" 0 \
  "$(bash_payload "git commit -F - <<'EOF'
$HEREDOC_MSG
EOF" "$FEAT_REPO")"
expect "commit on feature, inline -m with backtick git prose -> allow" 0 \
  "$(bash_payload 'git commit -m "see (`git push origin main`)"' "$FEAT_REPO")"
expect "echo mentioning git push origin main on main -> allow (not a command)" 0 \
  "$(bash_payload 'echo "remember: git push origin main is blocked"' "$MAIN_REPO")"
expect "cat heredoc writing text that contains git commit, on main -> allow" 0 \
  "$(bash_payload "cat > notes.txt <<'EOF'
git commit -m x
EOF" "$MAIN_REPO")"

echo "Bash guard (subshell / quoted / command-substitution forms):"
expect "(cd <main> && git commit) subshell from feature -> block" 2 \
  "$(bash_payload "(cd $MAIN_REPO && git commit -m oops)" "$FEAT_REPO")"
expect "cd <main>; git commit (semicolon) from feature -> block" 2 \
  "$(bash_payload "cd $MAIN_REPO ; git commit -m oops" "$FEAT_REPO")"
expect "git -C <main> commit chained after a read op -> block" 2 \
  "$(bash_payload "git status && git -C $MAIN_REPO commit -m oops" "$FEAT_REPO")"
expect "harmless subshell on main, no commit -> allow" 0 \
  "$(bash_payload "(cd $MAIN_REPO && git status)" "$FEAT_REPO")"

echo "Degraded payload (no tool_name -> direct cwd check):"
expect "unparseable payload, cwd=main -> block" 2 \
  "$(jq -nc --arg c "$MAIN_REPO" '{cwd:$c}')"
expect "unparseable payload, cwd=feature -> allow" 0 \
  "$(jq -nc --arg c "$FEAT_REPO" '{cwd:$c}')"

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
