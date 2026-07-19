#!/usr/bin/env bash
#
# enforce-branch-creation.sh — PreToolUse guard (Layer 3 fast-fail accelerator, ADR 0009)
#
# Purpose: stop changes from landing on a PROTECTED branch (main/master/develop
# by default) — above all, commits/pushes straight to a protected branch. On
# every other branch an agent is free to write, commit, and push at any time;
# this guard must never get in the way there.
#
# Wired in .claude/settings.json as a PreToolUse hook matching
# "Write|Edit|MultiEdit|NotebookEdit|Bash". The full tool payload arrives as
# JSON on stdin; we read it rather than trusting $CLAUDE_PROJECT_DIR.
#
# Why not $CLAUDE_PROJECT_DIR: a resumed session can re-root that variable onto
# the MAIN checkout even while the session is operating inside a worktree on a
# feature branch. The old hook did `cd "$CLAUDE_PROJECT_DIR" && git rev-parse`,
# so it read main's HEAD and falsely blocked legitimate feature-branch work.
# We instead evaluate the branch of the ACTUAL target — the file being written,
# or the repo the git command runs in — which is always worktree-correct.
#
# Exit codes (PreToolUse contract):
#   0  → allow the tool call
#   2  → block the tool call; stderr is shown to the agent
# We deliberately never exit 1: a non-2 nonzero would let the tool run anyway
# (fail-open). Every path below ends in an explicit `allow` or `block`.
#
# This guard is a per-tool accelerator (best UX: it blocks the write before it
# happens) over the same invariant the git-level hooks enforce. It governs AI
# actions taken through Claude Code's tools only; the invocation-agnostic
# backstop that also covers a human's direct git usage is the git-level
# pre-commit/pre-push hooks (.githooks/ → bin/guard-protected-branch), activated
# by bin/install-git-hooks. Layer 3 must never be the ONLY guard (ADR 0009).

# The protected-branch list is NOT hardcoded: it is read from the sidecar
# .githooks/protected-branches (generated from PROJECT.md — the single authored
# source — by bin/install-git-hooks). Resolve it relative to this script:
# .claude/hooks/../../.githooks. If the sidecar is missing/empty, fail CLOSED to
# a safe default set (never fail open).
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR="${HOOK_DIR}/../../.githooks/protected-branches"
DEFAULT_PROTECTED=("main" "master" "develop")
PROTECTED_BRANCHES=()
if [ -r "$SIDECAR" ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line="${_line#"${_line%%[![:space:]]*}"}"   # ltrim
    _line="${_line%"${_line##*[![:space:]]}"}"    # rtrim
    [ -n "$_line" ] || continue
    case "$_line" in \#*) continue ;; esac        # skip comment lines
    PROTECTED_BRANCHES+=("$_line")
  done < "$SIDECAR"
fi
[ "${#PROTECTED_BRANCHES[@]}" -eq 0 ] && PROTECTED_BRANCHES=("${DEFAULT_PROTECTED[@]}")

allow() { exit 0; }
block() { echo "$1" >&2; exit 2; }

# ---------------------------------------------------------------------------
# Read the JSON payload from stdin and pull out the few fields we need.
# ---------------------------------------------------------------------------
payload="$(cat)"

# json_get <jq-filter> <python-key-path> — extract a string field.
# Prefers jq, falls back to python3. Both are absent only on bare CI images;
# in that case we degrade to a worktree-cwd check further down (never fail-open
# for git-write operations).
json_get() {
  local jq_filter="$1" py_path="$2" out=""
  if command -v jq >/dev/null 2>&1; then
    out="$(printf '%s' "$payload" | jq -r "$jq_filter // empty" 2>/dev/null)"
  elif command -v python3 >/dev/null 2>&1; then
    out="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cur = data
for key in sys.argv[1].split("."):
    if isinstance(cur, dict):
        cur = cur.get(key)
    else:
        cur = None
        break
if cur is not None:
    print(cur)
' "$py_path" 2>/dev/null)"
  fi
  printf '%s' "$out"
}

tool_name="$(json_get '.tool_name' 'tool_name')"
cwd="$(json_get '.cwd' 'cwd')"
file_path="$(json_get '.tool_input.file_path' 'tool_input.file_path')"
[ -n "$file_path" ] || file_path="$(json_get '.tool_input.notebook_path' 'tool_input.notebook_path')"
command="$(json_get '.tool_input.command' 'tool_input.command')"

# Session cwd is the worktree the agent is operating in. Fall back to the hook
# process's own cwd (also the session dir) if stdin gave us nothing.
[ -n "$cwd" ] || cwd="$PWD"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

is_protected() {
  local b="$1" p
  for p in "${PROTECTED_BRANCHES[@]}"; do
    [ "$b" = "$p" ] && return 0
  done
  return 1
}

# Print the checked-out branch of the repo containing $1 (a file or dir path).
# Prints nothing when $1 is NOT inside any git repo (e.g. the /tmp scratchpad) —
# there is no protected branch to defend there, so the caller allows it.
# Prints "HEAD" for a detached HEAD (caller treats that as fail-closed).
branch_of() {
  local p="$1" dir
  [ -n "$p" ] || return 0
  if [ -d "$p" ]; then dir="$p"; else dir="$(dirname "$p")"; fi
  # A brand-new file may sit in a not-yet-created dir; walk up to a real one.
  while [ -n "$dir" ] && [ "$dir" != "/" ] && [ ! -d "$dir" ]; do
    dir="$(dirname "$dir")"
  done
  git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null
}

# Resolve a possibly-relative path against a base dir (no realpath dependency).
resolve_dir() {
  local d="$1" base="$2"
  case "$d" in
    /*) printf '%s' "$d" ;;
    *)  printf '%s/%s' "$base" "$d" ;;
  esac
}

# ---------------------------------------------------------------------------
# Write-family tools: block edits whose target file lives on a protected branch.
# Worktree-aware: the branch comes from the file's own repo, not the session.
# ---------------------------------------------------------------------------
guard_write() {
  local target="${file_path:-$cwd}" branch
  branch="$(branch_of "$target")"
  [ -n "$branch" ] || allow                         # not in a repo (scratchpad)
  if [ "$branch" = "HEAD" ]; then
    block "Detached HEAD at '$target' — refusing the write as a safety measure. Check out a named feature branch first."
  fi
  if is_protected "$branch"; then
    block "Refusing to modify files on protected branch '$branch'. Create or switch to a feature branch first (agents have full freedom on any non-protected branch)."
  fi
  allow
}

# ---------------------------------------------------------------------------
# Bash tool: the only thing we care about is a git operation that could land a
# commit / move a ref onto a protected branch. We parse the command so the guard
# can't be sidestepped with the forms the old prefix matcher ("Bash(git
# commit:*)") silently missed:
#   - `git -C <dir> commit`                 (run against another checkout)
#   - `GIT_AUTHOR_NAME=x git commit`        (leading ENV=val assignments)
#   - `cd <dir> && git commit`              (directory change first)
#   - `(cd <dir> && git commit)` / `$(...)` (subshell / command substitution)
#   - `git push origin main` / `HEAD:main`  (protected refspec from any branch)
# Anything that is not such an operation is allowed (read-only git, file writes,
# etc.) — per the rule that this guard's sole concern is commits/pushes to a
# protected branch.
#
# To avoid FALSE blocks, string-literal content is treated as data, not commands:
# heredoc bodies are cut (above) and quotes/backticks are NOT unwrapped, so a
# commit message or echo that merely mentions `git push origin main` is ignored.
#
# RESIDUAL (documented, not covered here): a string parser cannot defeat a
# Turing-complete shell, and it cannot perfectly tell code from a quoted literal.
#   - Under-block: `bash -c '<quoted compound>'`, `eval`, base64-decoded
#     commands, or a repo path built at runtime can still reach a commit.
#   - Over-block: a one-line inline message that literally contains a command
#     separator AND git text — `git commit -m "did x && git push origin main"` —
#     could still trip the scan (use a heredoc / `-F` for such messages).
# The complete, invocation-agnostic backstop is the git-level pre-commit /
# pre-push hooks (git runs them no matter how the commit was triggered, with zero
# string parsing). See .githooks/ and bin/guard-protected-branch.
# ---------------------------------------------------------------------------

# Operations that create a commit or move a branch ref.
is_ref_moving_subcommand() {
  case "$1" in
    commit|push|merge|rebase|cherry-pick|revert|am) return 0 ;;
    *) return 1 ;;
  esac
}

# Un-glue shell *grouping* punctuation a token may be prefixed/suffixed with, so
# a real subshell or command substitution — `(cd`, `$(git`, `commit)` — is still
# recognized. We deliberately do NOT strip quotes or backticks: prose inside a
# commit message or string literal (e.g. ``(`git push origin main`)``) must stay
# un-command-like so it is skipped, not mistaken for an executed command.
strip_wrappers() {
  local t="$1" i
  for i in 1 2 3; do t="${t#[\$\(\{]}"; done
  for i in 1 2; do t="${t%[\)\}]}"; done
  printf '%s' "$t"
}

guard_bash() {
  local cmd="$1"
  [ -n "$cmd" ] || allow

  # Drop heredoc bodies before inspecting anything. Everything from the first
  # `<<` to the end is DATA fed to a command (a commit message via `git commit
  # -F - <<EOF…`, a file being written with `cat <<EOF…`), not commands to run.
  # Scanning it produced false blocks on messages that merely *mention* git
  # commands. The leading command (e.g. `git commit -F -`) survives the cut.
  cmd="${cmd%%<<*}"

  case "$cmd" in *git*) ;; *) allow ;; esac      # no git token → nothing to guard

  set -f   # no globbing: `set -- $seg` must word-split only, never expand `*.rb`
  local curdir="$cwd" seg
  # Split on command separators into one segment per line, using pure bash
  # parameter expansion — NOT `sed`. A missing external tool must never leave
  # `normalized` empty and silently fail OPEN for a git-write command (the old
  # `sed` pipeline did exactly that). Crude (ignores quoting) but only ever
  # widens what we inspect; the branch check below is what actually gates a block.
  local normalized="$cmd"
  normalized="${normalized//&&/$'\n'}"   # `a && b`
  normalized="${normalized//||/$'\n'}"   # `a || b`
  normalized="${normalized//|/$'\n'}"    # `a | b`
  normalized="${normalized//;/$'\n'}"    # `a ; b`

  while IFS= read -r seg; do
    # shellcheck disable=SC2086
    set -- $seg
    [ "$#" -gt 0 ] || continue

    # Un-glue shell *grouping* punctuation from each token, so a subshell or
    # command substitution — `(cd`, `commit)`, `$(git` — is still recognized.
    # Quotes/backticks are deliberately NOT stripped (see strip_wrappers): that
    # keeps prose in a commit message — e.g. ``(`git push origin main`)`` — from
    # looking like a command, so a quoted token like `'cd` is intentionally
    # left unmatched.
    local -a _toks=() _t
    for _t in "$@"; do _toks+=("$(strip_wrappers "$_t")"); done
    set -- "${_toks[@]}"
    [ "$#" -gt 0 ] || continue

    # Strip leading `ENV=value` assignments (`GIT_AUTHOR_NAME=x git commit`).
    while [ "$#" -gt 0 ]; do
      case "$1" in
        [A-Za-z_]*=*) shift ;;
        *) break ;;
      esac
    done
    [ "$#" -gt 0 ] || continue

    # Track directory changes so `cd <dir> && git commit` is evaluated in <dir>.
    if [ "$1" = "cd" ] && [ -n "${2:-}" ]; then
      curdir="$(resolve_dir "$2" "$curdir")"
      continue
    fi

    # Is this segment a git invocation? (`git`, `/usr/bin/git`, ...)
    case "$1" in
      git|*/git) ;;
      *) continue ;;
    esac
    shift   # drop the `git` token

    # Walk git's global options to find -C <dir> and the subcommand.
    local repodir="$curdir" sub=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -C)            repodir="$(resolve_dir "${2:-.}" "$curdir")"; shift 2; continue ;;
        --git-dir=*)   repodir="$(resolve_dir "${1#--git-dir=}" "$curdir")"; shift; continue ;;
        --git-dir)     repodir="$(resolve_dir "${2:-.}" "$curdir")"; shift 2; continue ;;
        -c)            shift 2; continue ;;     # `-c key=val` config override
        -*)            shift; continue ;;       # any other global flag
        *)             sub="$1"; shift; break ;;
      esac
    done
    [ -n "$sub" ] || continue

    is_ref_moving_subcommand "$sub" || continue

    # Block `--no-verify` (and commit's `-n` alias): it skips the git-level
    # pre-commit/pre-push protected-branch hooks (.githooks → bin/guard-protected
    # -branch), which are the invocation-agnostic backstop. Skipping them is only
    # ever an attempt to dodge branch protection here, so refuse outright.
    local arg
    for arg in "$@"; do
      case "$arg" in
        --no-verify) block "Refusing 'git $sub --no-verify': it skips the protected-branch git hooks. Drop --no-verify." ;;
        -n)          [ "$sub" = "commit" ] && block "Refusing 'git commit -n' (--no-verify): it skips the protected-branch git hooks. Drop -n." ;;
      esac
    done

    local branch
    branch="$(branch_of "$repodir")"
    # No branch resolved: a git ref-moving op outside a detectable repo is
    # suspicious — fail closed rather than let a commit slip onto a protected branch.
    if [ -z "$branch" ]; then
      block "Could not determine the branch for 'git $sub' in '$repodir' — blocking as a safety measure (the guard cannot confirm it is not a protected branch)."
    fi
    if [ "$branch" = "HEAD" ] || is_protected "$branch"; then
      block "Refusing 'git $sub' on protected branch '${branch}' in '$repodir'. Commits/pushes to a protected branch are not allowed; use a feature branch."
    fi

    # `git push` can target a protected branch even from a feature branch.
    # Normalize each refspec to its destination ref and compare, so every
    # spelling is caught: `main`, `refs/heads/main`, `HEAD:main`,
    # `HEAD:refs/heads/main`, force-push `+refs/heads/main`, and the branch
    # deletion `:main`. (A branch merely *named* `feature/main` is not matched —
    # its destination normalizes to `feature/main`, not `main`.)
    if [ "$sub" = "push" ]; then
      local tok dest
      for tok in "$@"; do
        case "$tok" in -*) continue ;; esac   # skip flags (--force, -u, …)
        dest="${tok##*:}"            # refspec destination = part after last ':'
        dest="${dest#+}"             # drop a force-push '+'
        dest="${dest#refs/heads/}"   # drop a refs/heads/ prefix
        if is_protected "$dest"; then
          block "Refusing 'git push' targeting protected ref '$tok'. Pushing to a protected branch is not allowed."
        fi
      done
    fi
  done <<EOF
$normalized
EOF

  allow
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
case "$tool_name" in
  Write|Edit|MultiEdit|NotebookEdit) guard_write ;;
  Bash)                              guard_bash "$command" ;;
  "")
    # No tool name (jq/python3 missing, or odd payload). Degrade to a direct
    # worktree check so we never silently fail-open for the common case.
    branch="$(branch_of "$cwd")"
    if [ -n "$branch" ] && { [ "$branch" = "HEAD" ] || is_protected "$branch"; }; then
      block "On protected branch '$branch' and unable to parse the tool payload — blocking as a safety measure."
    fi
    allow
    ;;
  *) allow ;;
esac

allow
