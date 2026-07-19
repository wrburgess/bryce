# Attribution carries tool + model version, sourced from a single declaration

**Status:** accepted

Agent attribution on commits, PRs, and comments records **both the tool and its model version** (e.g. `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`, footer `— Claude Code (Opus 4.8)`). The model indicator is deliberately retained — over time it is the **audit trail for quality and pricing** across the four agents.

This reverses the tempting "version-free" simplification. A version string does risk going stale, but the audit value outweighs the upkeep — provided staleness is contained:

- **Single source of truth.** The Project Config declares the current model per agent in **one place**. That one line is bumped when the host switches models (the same moment it would change anyway), so the version never scatters across skill bodies the way Markaz's did.
- **Runtime-accurate override.** Skills instruct the agent to sign with its **actual runtime model** when determinable, reconciling against the declared default and recording the actual if they differ — catching model drift, which is exactly what a cost/quality audit must not miss. A stale string that records the *wrong* model is worse than useless for an audit.
- **Human-readable names, not API IDs.** Use `Claude Opus 4.8`, never `claude-opus-4-8` — cleaner for audits, no internal identifiers leaked into history.

Attribution shows **per-agent identity** (Claude Code / Codex / Copilot / Gemini) so provenance reflects which agent did the work.

## Consequences

- The audit relies on the Project Config model declaration being kept current; a Host App switching models must update that one field.
- Copilot's backing model is variable/unknown (ADR 0002) — its declaration may read `Copilot (model varies)` rather than a fixed version.
