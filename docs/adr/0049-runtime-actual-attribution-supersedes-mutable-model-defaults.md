# Runtime-actual attribution supersedes mutable model defaults

**Status:** accepted

## Context

ADR 0007 correctly requires model-bearing attribution for auditability, and ADR 0024 correctly
separates a harness name from the model it runs. Their implementation also relied on a mutable
per-harness model column in `PROJECT.md`. That duplicate prediction can drift from the model that
actually produced an artifact, weakening the audit record it was meant to support.

## Decision

Artifact attribution is the sole model-identity record. `PROJECT.md` retains the exact attribution
heading and a harness-to-identity-email mapping, but contains no model/default column. Commit trailers
use `Co-Authored-By: HARNESS MODEL <EMAIL>` and lifecycle-host footers use `— HARNESS (MODEL)`, where
`MODEL` is the human-readable runtime-actual model. When it cannot be determined, `MODEL` is literal
`unknown`; it never falls back to a configured prediction.

Reviewer CLI model identifiers remain operational invocation inputs. They are not artifact labels and
are never derived from the attribution mapping; every reviewer call provides known, distinct acting
and reviewer identifiers.

## Supersession

This supersedes only the mutable-default portions of ADR 0007: its **Single source of truth** and
**Runtime-accurate override** decision bullets, plus its first Consequence. It supersedes only the
`Declared model`-column portion of ADR 0024 Decision item 2 and its first Consequence. ADR 0007's
model-bearing audit requirement and ADR 0024's harness/model naming convention remain accepted.

## Consequences

- Audit provenance is honest when a runtime model cannot be discovered: the artifact says `unknown`
  rather than recording a stale value.
- The parity check validates the five-harness identity mapping and rejects a model/default schema from
  the live Project Config.
- Reviewer independence stays fail-closed without turning a CLI model identifier into documentation
  attribution.
