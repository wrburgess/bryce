# Player Card Presentation: defaults follow the surface's audience, and PDF is deferred a second time

Issue #141 asked for the single-player report — now canonically a **Player Card**
([`docs/domain/CONTEXT.md`](../domain/CONTEXT.md)) — to become readable in three targets: console, HTML,
and PDF. Distillation kept the first two, dropped the third, and changed one thing ADR 0037 had fixed:
a Player Card's `format` **defaults per surface** rather than defaulting to `json` everywhere. The
governing constraint the HC set is that a Card must be a *command-driven result* — a CLI user or an
agent asks once and receives a finished artifact, never a data structure plus the standing invitation
to re-invent a layout.

**Presentation widened to fit.** It was defined as a rendering of a whole **Digest**; it now covers a
rendering of a whole *report* — a Digest or a Player Card. The rule ADR 0037 actually depends on is
untouched: **Presentation = document, Export = table.** A Card is a document, so it inherits the
Presentation rules instead of spawning a parallel concept with its own answers to the same questions.

## Defaults follow the audience, not one global rule

ADR 0037 set `format` defaulting to `json` "so every current caller is unchanged." That rule was
protecting **programmatic** callers. For a Player Card the surfaces do not share an audience, so they
do not share a default:

| Surface | Default | Audience |
|---|---|---|
| CLI `sk report player` | `console` | a human at a terminal |
| MCP `report_player` | `console` | an agent, which should receive a finished artifact to show |
| REST `GET /api/players/:id/card` | `json` | the actual programmatic caller — unchanged |

Every surface still accepts every format; only the default moves. The measurement that decided it: a
Card's JSON carries `Aggregate.counters` for **every** counter key of the stat type — 27 batting, 43
pitching — plus `deriveAllRates` output (9 batting, 18 pitching) and six repeated per-row fields. A
two-way player over three Card Windows is ~315 key/value pairs, **2–4k tokens on every call**, and the
agent then spends *more* tokens choosing among ~70 fields and laying them out slightly differently each
time. The console rendering is ~300 tokens and identical every time.

**MCP returns the same `console` rendering the CLI prints** — one text layout, one pure function, one
set of fixture tests. Agent surfaces display tool text verbatim in monospace, so column alignment
survives. Markdown is deliberately **not** added for the Card even though `digest_preview` has it: a
fourth renderer to maintain with no consumer asking for it.

**The tool description is half the mechanism.** An agent picks a tool from its description string.
`report_player`'s reads as a spec for a data structure; it is rewritten to lead with the outcome
("returns a formatted, ready-to-display card; pass `format: 'json'` only for raw numbers"). Without
that, flipping the default alone does not stop an agent from over-thinking the result.

## PDF, deferred again — print from the HTML instead

ADR 0037 deferred PDF until "a concrete need appears — printing/archiving a season summary." #141
assumed that need rather than demonstrating it: the HC's stated use is reading a Card from iTerm2 or
from a chat session, and an agent cannot read a PDF it just generated. The HTML target instead carries
a `@media print` block — page breaks between Card Windows, repeating table headers, grayscale-safe
colors — so ⌘P → *Save as PDF* produces the paginated document #141 described, with **zero new
dependencies and no third layout engine** after `textTable` and `htmlTable`.

Two facts make the deferral cheaper than it looks. #141's own AC requires renderers to be **pure
functions over `PlayerCard`** — which disqualifies Puppeteer (async, spawns a browser) and a system
tool (spawns a process, and is untestable on the `ubuntu-latest` CI that ADR 0028's MacBook runtime does
not match). Only a hand-laid-out pure-JS writer satisfies the AC, and that is the option that costs the
most. **If an automated PDF need later appears with a real consumer attached — a scheduled archive, a
mail attachment — the sanctioned step is `pdf-lib` over the existing Column model, never
`npm install puppeteer`.**

## The browser-URL surface is split out, because it is not a Player Card feature

The HC also wants to open a Card in a browser from a chat session on a phone or in ChatGPT. That is a
**delivery** problem; #141 is a **rendering** issue. It is deferred to its own issue rather than bundled,
for a reason that is not scheduling: a `/view/*` route is a **Presentation delivery surface**, and
`renderDigestHtmlDocument` has existed since ADR 0037 with no browser-reachable way to look at it. One
issue serves both reports; bundling it here would bury a general capability inside a specific one and
review a **new auth boundary on a tunnel-exposed host** as a footnote to a rendering PR. It inverts the
auth model every current route uses — `/api/*` and `/mcp` require `Authorization: Bearer`, which a
browser cannot send (ADR 0037's stated reason for refusing a bare browser URL) — so it needs Cloudflare
Access's interactive login plus in-app `Cf-Access-Jwt-Assertion` validation, which nothing in the app
does today. That issue carries its own ADR.

Until it lands, the chat case is served by `format: 'html'` over MCP: Claude renders the HTML as an
artifact in the split-screen panel. That path is real but costs ~2–4k tokens round-trip and lets the
*model* retype the document, so it can truncate a table or "improve" the CSS. The view route replaces it
with one link, exact bytes, and works in ChatGPT — which the artifact path does not.

## Consequences

1. **One table per Card Window, not the windows side by side.** #29 specified "`last10` + `last30` +
   `ytd` side by side"; #141 specified a table per window; the HC chose #141's shape. The payoff is that
   each table covers exactly one window, so **BB%/K% appear and disappear per window exactly as they do
   in the Digest** rather than becoming dashed-out cells. The cost is that comparing `last10` to `ytd`
   means reading across sections. The threshold itself needs no new judgment: `isLongWindow`
   (`src/domain/window.ts`) already rules thirty games in, ten games out, `ytd` in.

2. **`assemblePlayerCard` gains QS / RW / RL, and the "byte-identical" AC is relaxed to
   "additive-only."** `DigestRow` carries `qualityStarts`, `reliefWins`, and `reliefLosses`; the Card's
   row carried none of them, and per ADR 0036 they are **per-game decisions counted at assembly** that
   cannot be recovered from summed counters. A starter's Card would therefore have omitted quality
   starts — an incoherence against the Digest for the same player. The assembler counts them at a second
   call site using the existing pattern (no new stat math), and #141's criterion becomes: every field
   present today keeps its name, position, and value. That preserves what the criterion protected — no
   scripted caller breaks — without freezing the payload forever.

3. **Per-row `Span` is deliberately not carried.** The Digest needs it because two *players*' last-N
   windows cover different dates; a Card is one player, so the window's own `from`/`to` is honest.

4. **`--format json` remains the machine contract on every surface,** and REST still defaults to it. The
   CLI and MCP default flip is a behavior change to two surfaces whose consumers are a human and a
   language model respectively; it is recorded here so it does not read as a violation of ADR 0037.
