---
name: assess
description: Stage 1 of the development lifecycle. Research a tracked issue and prepare an assessment for the Human Contributor — problem summary, codebase findings, 2-3 genuinely different options with trade-offs and risk, and a recommendation. Use when starting work on an issue, before any plan or code.
---

<what-to-do>

Review the tracked issue named in the invocation and prepare an assessment for the Human Contributor
(HC). This is **Stage 1 (Assess)** of the [development lifecycle](../../docs/standards/development-lifecycle.md).

Read host-specific values — the lifecycle host and its artifact map, the attribution/model, the review
severities, the quality-check commands — from [`PROJECT.md`](../../PROJECT.md). Never hardcode them
here. Name the lifecycle *verb* ("read the issue", "post the assessment to the issue"); the concrete
mechanism (which platform, which command) is set in `PROJECT.md` → *Lifecycle Host* (GitHub is the
default).

</what-to-do>

<procedure>

1. **Read the issue** — title, description, labels, milestone, and every existing comment. A prior
   comment may already carry constraints or a partial decision; fold it in.
2. **Check for duplicates and related work** — search open/closed issues and PRs for the issue's
   keywords. If you find overlapping or superseding work, note it and ask the HC whether to proceed or
   consolidate.
3. **Read the architecture context** the Host App provides — its top-level docs (e.g. `README`, any
   `docs/architecture/`), and the matching [Rules Layer](../../rules/) file for each subsystem the
   issue touches (`rules/backend.md`, `rules/frontend.md`, `rules/testing.md`, `rules/security.md`,
   `rules/scripting.md`). These three steps stay inline.
4. **Explore the codebase** — for any non-trivial issue, offload the open-ended trace to a **read-only
   sub-agent** so the file-by-file reading stays out of the orchestrator's context; it returns
   conclusions, not file dumps. Its prompt: the affected area drawn from the issue, and the
   **required output = the exploration-summary** below. Fold the returned summary into the assessment.
   A tightly-scoped issue touching one or two already-known files may be read inline instead.

   *Graceful degradation ([ADR 0003](../../docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md)):*
   on a tool without a read-only sub-agent, run the same exploration **inline** and produce the same
   summary. The mechanism degrades; the summary and its rigor do not.

   ### exploration-summary (sub-agent → assessor)
   ```
   { relevant_files: [ { path, role } ], existing_patterns: [str], dependencies: [str],
     test_coverage: { covered: [str], gaps: [str] }, risks: [str] }
   ```
5. **Check test coverage** for the affected area — read existing tests to see what's covered and what
   gap a change would introduce ([`rules/testing.md`](../../rules/testing.md)). If the Host App
   enforces a coverage floor, note the risk of dropping below it.
6. **Identify project-specific concerns** — walk the checklist and consult the matching Rules Layer
   file for each that applies:
   - A data-model or schema change? → the host's migration/data-integrity rules; is it reversible/safe?
   - Authorization? → the host's authorization patterns; does the change alter who can do what?
   - New persisted state, soft-delete, or audit-trail expectations? → the host's model conventions.
   - New status/type/enumerated values? → the host's enumeration pattern.
   - UI / templates / client behavior? → [`rules/frontend.md`](../../rules/frontend.md).
   - Search, background work, or an external service? → the matching backend rule + reindex/retry
     implications.
7. **Research ecosystem solutions before proposing custom code** — check whether the framework's
   built-ins or an established, well-maintained library already solves the problem
   ([`rules/backend.md`](../../rules/backend.md)). List what you considered in the assessment, even if
   rejected. "I couldn't find a fit" is acceptable; "I didn't look" is not.
8. **Identify unknowns** — list anything ambiguous or underspecified in the issue.
9. **Ask clarifying questions** — if requirements have gaps, ask the HC before proceeding. Ask, don't
   guess.

## Complexity criteria

- **Small** — a handful of files, no schema/migration, no authorization change, single subsystem.
- **Medium** — a moderate file count, may include a schema change, touches 2–3 subsystems, single agent.
- **Large** — many files, multiple schema changes, authorization changes, or cross-cutting concerns →
  recommend parallel agents if the host supports them.

**Compressed workflows** (the HC decides, not the AC): a trivial fix may skip Plan; a
documentation-only change may skip Assess and Plan (see the
[lifecycle doc](../../docs/standards/development-lifecycle.md)).

</procedure>

<output>

Post the assessment to the issue via the lifecycle host's issue-comment mechanism
([`PROJECT.md`](../../PROJECT.md) → *Lifecycle Host*), and also display it in the conversation so the
HC can discuss before choosing. Use this template:

```markdown
## Issue Assessment

### Summary
[What the issue asks for, in clear terms]

### Systems Affected
| System | Files/Areas | Impact |
|--------|-------------|--------|
| [e.g. Data model] | [e.g. `path/to/file`] | [e.g. new field + backfill] |

### Complexity: [Small | Medium | Large]
- [Key factors driving the estimate]

### Related Issues/PRs
- [Related work found, or "None found"]

### Project-Specific Considerations
- [Schema/migration safety, authorization, persistence/soft-delete, search/index, deployment — or "None"]

### Open Questions
- [Anything ambiguous needing HC input — or "None"]

### Risk Assessment
- [What could go wrong; the blast radius of the change]

### Implementation Options

#### Option A: [Name]
- **Approach:** [Description]
- **Pros / Cons / Risk:** […]
- **Estimated scope:** [files, tests, schema changes]

#### Option B: [Name]
- **Approach / Pros / Cons / Risk / Estimated scope:** […]

### Recommendation
Option [X] because [rationale].

### Next Step
HC: send this assessment to the Reviewer, then reply with your chosen option and run the plan skill
(`devise`) for the same issue.
```

Sign the comment with the attribution footer from [`PROJECT.md`](../../PROJECT.md) → *Attribution &
Model Declaration* (e.g. `— Claude Code (Opus 4.8)`), using your runtime-actual model.

**Terminal artifact:** the assessment posted on the issue.

## Quality standard

Before posting, self-review: did I research the codebase or guess from the issue text? Are my options
*genuinely different* approaches, not variations of one? Did I name risks that could waste
implementation time? Would a critical reviewer find a gap in this analysis?

</output>
