# Context Map

Two bounded contexts live in this repository. Terms from one never leak into the other.

## Contexts

- [AI-config layer](./CONTEXT.md) — the vendored ai-config bundle's own vocabulary (Config Bundle,
  Adapter, Skill, Rules Layer…). Governs *how agents work in this repo*; `AGENTS.md` links to it.
- [Baseball Digest domain](./docs/domain/CONTEXT.md) — the app's domain language (Player, Level,
  Stat Line…). Governs *what the app is about*. Lives under `docs/domain/` until the TypeScript app
  scaffolds; if it later moves next to the code, this map is the single place that re-points.

## Relationships

- No shared terms. Where a word could mean either (e.g. "skill"), the config-layer meaning wins in
  agent-facing files (`AGENTS.md`, `skills/`, `rules/`) and the domain meaning wins in app code and
  product docs.
