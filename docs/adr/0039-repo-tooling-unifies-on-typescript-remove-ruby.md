# Repo tooling unifies on TypeScript (tsx); Ruby is removed

**Status:** accepted — supersedes the *language* choice of [ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md) and part (i) of [ADR 0018](0018-neutrality-pass-scope-tooling-and-enforcement.md) (issue #64).

Bryce is a committed **Node/TypeScript application**, not a distributable Config Bundle vendored into
host apps ([ADR 0025](0025-typescript-node-stack.md)). The repo's meta-tooling — the structural parity
check, the Reviewer summon wrapper, the protected-branch derivation helper, and the action-pin guard —
was originally Ruby on the premise that it was **portable, dependency-free bundle infrastructure** that a
host would run on a bare runtime ([ADR 0008](0008-structural-parity-check-not-model-in-the-loop.md),
[ADR 0018](0018-neutrality-pass-scope-tooling-and-enforcement.md)). That premise no longer holds. We
therefore **port the four Ruby scripts to TypeScript, run via `tsx`** (the mechanism the app's own CLIs
already use), and **remove Ruby from the repo and CI**. This reclassifies the tooling scripts from
*Config Bundle infrastructure* to **Host App tooling** that shares the app's toolchain, giving the whole
repo one primary language.

## Considered Options

- **`tsx scripts/*.ts` + `npm ci` in `parity.yml` (chosen).** Real TypeScript, run the same way as
  `tsx src/cli/*.ts`. The parity CI job gains `setup-node` + `npm ci`, mirroring `app.yml`.
- **Zero-dependency plain `.mjs` (Node built-ins only).** Would keep the parity job lean (no `npm ci`),
  but leaves the tooling as untyped JS — an *exception* to the single-language goal, not a fulfillment of
  it. Rejected: the "lean parity job" benefit only mattered under the portability premise we dropped, and
  `app.yml` already pays the `npm ci` cost.
- **Compiled JS (`tsc` build).** Adds a build step and either committed build artifacts or a CI build
  that needs `npm ci` anyway. Rejected: cost without a compensating benefit.

## Consequences

- **Supersession is partial and precise.** ADR 0008's *other* decision — parity is verified
  **structurally, not model-in-the-loop** — is unchanged; the ported script asserts the same structural
  invariants. ADR 0018 part (ii) — **rules-neutrality stays author-owned, not machine-enforced** — is
  likewise untouched. Only 0008's "Ruby, not bash" and 0018(i)'s "don't rewrite the Ruby tooling" are
  reversed here. 0018(i) explicitly anticipated this as "a separate follow-up issue" — issue #64 is it.
- **Bash is retained as-is.** Git-hook shims (`.githooks/`, `bin/…`) and the `.test.sh` self-tests stay
  POSIX shell: git hooks run in git's environment on a fresh clone *before* `npm ci`, so the thin
  invocation layer must not depend on node/`tsx`. "Single language" here means *no second full toolchain
  (Ruby)*, not *zero shell*.
- **`rules/scripting.md` is host-scoped, not gutted.** Its "dependency-free bundled script" anti-pattern
  remains as neutral baseline guidance for a genuinely portable script; a host note records that Bryce's
  own tooling opts into the Node/TS toolchain, via the rule's existing "unless the host explicitly opts
  in" hook.
- **CLI contracts and exit semantics are preserved exactly** by the ports — the summon failure ladder
  (eight classifications, process-group kill, timeout) and `parity_check`'s `--root` fixture flag — because
  the load-bearing bash self-tests are kept and must stay green against the ports.
