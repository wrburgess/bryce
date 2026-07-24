# Human-facing app CLIs emit UTF-8; the ASCII-safe-stdout rule scopes to machine output

**Status:** accepted

The bundled scripting rule ([`rules/scripting.md`](../../rules/scripting.md)) carries the anti-pattern
*"never emit non-ASCII bytes from a bundled script's stdout/stderr"* ([ADR 0011](0011-ascii-safe-stdout-stays-doc-only.md);
provenance issue #5 / PR #14). Written as a blanket rule it collides with a fact the app already lived:
`src/cli/seed.ts` echoes a Player's `fullName` in UTF-8, `docs/cli/README.md` documents that
`seed`/`list` print names like `José`, and the digest/API/MCP surfaces preserve full Unicode by
construction ([ADR 0041](0041-normalize-player-names-nfc-at-ingestion.md) / #65). Yet
`test/seed.test.ts` still asserted an *"ASCII-only stdout"* contract (passing only because its fixtures
were ASCII) and `seed`'s docstring still claimed *"ASCII-only key=value lines"*. This ADR resolves
issue #74 — the doctrine question [ADR 0041](0041-normalize-player-names-nfc-at-ingestion.md) flagged
as "a separate question against ADR 0011 / `rules/scripting.md`."

## The criterion — by an output's primary purpose, not by file location

A command's stdout emits **UTF-8** *iff its primary purpose is to render player/person identity (or
full email content) for the HC to read directly* on his single-user UTF-8 host
([ADR 0028](0028-local-macbook-hosting-cloudflare-tunnel.md)). Everything else — portable/CI tooling,
machine diagnostics, and greppable bulk/machine-outcome reporters whose identity fields are
deliberately folded — stays **ASCII**. The line is drawn by *what the output is for*, never by whether
the file lives under `src/cli/` or `scripts/` (both classes appear in each directory), and not by
"greppability" alone (a `seed` row and a `batch-add` outcome are both greppable `key=value`).

The **identity contract** for the UTF-8 side is the *canonical stored identity*: names are
NFC-normalized, whitespace-collapsed, and trimmed at the ingestion boundary
([ADR 0041](0041-normalize-player-names-nfc-at-ingestion.md)), so a CLI echoes that canonical form in
UTF-8 — not raw upstream bytes.

## Per-command classification

| Command | Emits player/email identity? | Class | Encoding |
|---|---|---|---|
| `seed` (`add`/`deactivate`/`list`/`tag`) | yes (`name=…`) | human-facing app CLI | **UTF-8** |
| `digest` (`MAILER_PROVIDER=console`) | yes (rendered email) | human-facing app CLI | **UTF-8** (already) |
| `players:batch-add` | yes, but **folded + forgery-proofed** | greppable bulk-outcome reporter | ASCII |
| `ncaa:probe` | parsed name/school (folded) | machine diagnostic | ASCII |
| `refresh`, `db:migrate`, `db:backup`, `db:restore`, `players:backup`, `players:restore`, `server` | no identity field | — | ASCII by construction |
| `scripts/*` (`summon-reviewer`, `human-gates`, `check-action-pins`, `connector-smoke`) | n/a | portable / CI tooling | ASCII |

`players:batch-add` is the deliberate exception on the app-CLI side: its `asciiField()` fold is
**dual-purpose** — besides locale-safety it collapses whitespace / strips control bytes so a crafted
upstream name cannot forge a fake `key=value` token on a greppable bulk line (PR #84). Option 1's
"the HC should see `Acuña`" does not override that forgery-proofing, so `batch-add` keeps folding.

## Scope boundaries

- **`ncaa:probe` is ASCII only for its folded identity fields** (`name`/`school` via `ascii()`).
  Generic fetch/parse/top-level errors still emit a raw `err.message`, which can carry non-ASCII bytes.
  Closing that sad-path gap (sanitizing flag echoes and exception messages, with tests over every
  promised path) is **out of scope** here and deferred to a tracked follow-up — the issue #74 body
  already noted a blanket "diagnostic output is ASCII-safe" claim would need that broader work.
- **`seed` is not given forgery-proofing.** Option 1 chose a plain UTF-8 identity echo; names are
  NFC-normalized at ingestion. Adding `batch-add`-style field-hardening to `seed` is a separate concern.
- **Enforcement is unchanged.** [ADR 0011](0011-ascii-safe-stdout-stays-doc-only.md)'s decision — the
  rule stays doc-only, caught by output-asserting tests, not a source-byte scan — still holds. This ADR
  refines the rule's *scope*, not its *enforcement mechanism*.

## Consequences

- `test/seed.test.ts`'s stale ASCII-only case is replaced by a canonical-identity contract test that
  feeds an NFD name and asserts the NFC form survives verbatim on stdout across the identity-bearing
  `seed` paths (MLB add, NCAA add, deactivate, list, search candidates).
- `rules/scripting.md` gains a **Host (Bryce) opt-in** clause carrying the criterion above; `seed`'s
  docstring is corrected.
- A pre-existing, unrelated doc-drift — many `#65 / ADR 0039` references that should read **ADR 0041**
  (the name-normalization ADR was renumbered; 0039 is the TypeScript-tooling ADR) — is **not** folded
  into this change and is deferred to its own tracked follow-up.
