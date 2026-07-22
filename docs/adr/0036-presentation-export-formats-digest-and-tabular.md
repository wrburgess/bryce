# Presentation and Export formats: a `format` param over the existing surfaces, not a new UI

Issue #55 asked the app to produce HTML, CSV, PDF, Excel, and Markdown. Those are two concepts, not
five loose formats (docs/domain/CONTEXT.md): a **Presentation** is a human-readable rendering of a
*whole* Digest (both Roll-up tables in one artifact) as HTML/PDF/Markdown; an **Export** is one
tabular result per file (a query, or *one* of the Digest's two tables) as CSV/Excel. The rule that
falls out — **Presentation = document, Export = table** — is why an Export of the Digest must pick a
table (`table=batters|pitchers`, default `batters`) while a Presentation renders both.

Formats are selected by an explicit **`format` param** (a query param for REST, a tool argument for
MCP), defaulting to `json` so every current caller is unchanged — it only *adds* an alternative body.
It is applied to exactly the surfaces the concepts fit: `digest_preview` gains `html`/`md`/`csv`;
`stat_lines` and `sql_query` gain `csv` only (they are raw rows, never a Presentation). We chose an
explicit param over `Accept:` content negotiation because it is visible in a URL, linkable, trivially
testable, and is what a future browser-openable view route wants.

Delivery is split by channel strength, and this is what keeps [ADR 0027](0027-mcp-first-interface-no-web-ui.md)
(MCP-first, *no web UI*) intact. The **text** formats (HTML/Markdown/CSV) return **inline via MCP**
for viewing inside the agent surface; the **document-and-table surfaces** — `digest_preview` and
`stat_lines` — additionally download as files via the **authed REST** API (`GET /api/…?format=…`) for
scripts and tooling — a GET returning a file is not a web UI. A *bare browser* URL is deliberately
**not** supported yet: it cannot send the `Authorization: Bearer` header the REST surface requires, and
the alternatives are all worse (a token in the query string leaks it into history and logs; cookie
sessions break the stateless server). The sanctioned next step, when glanceability is genuinely missed,
is ADR 0027's "single read-only HTML page" served through a **Cloudflare-Access-JWT-validated** view
route — documented here so it is not re-invented, built later.

**The `sql_query` surface is the deliberate exception: its CSV is MCP-inline only, with no REST
download in Phase 1.** Unlike `digest_preview` and `stat_lines` — whose REST routes are parameterless
GETs — `sql_query` carries the SQL text and up to fifty bound params, which a `GET /api/…?format=csv`
would have to place in the query string. That reintroduces *exactly* the URL-leakage this ADR rejects
one paragraph up (SQL and params captured in history and access logs). So Phase 1 gives `sql_query`
CSV where it is actually consumed — the MCP agent surface — and **defers** its REST download. The
sanctioned next step, if a concrete need to pipe an ad-hoc query into a spreadsheet appears, is a
`POST /api/sql` returning a CSV file (SQL in the request body, never the URL) — documented here so it
is not re-invented as an unsafe GET.

## Phasing and the explicit no

Phase 1 ships **HTML, Markdown, and CSV only** — all three fall out of the existing `Column[]` model
in `src/digest/render.ts` (or a plain array of rows) with **zero new dependencies**. **PDF and Excel
are deferred**: each drags in a heavyweight dependency (a headless Chromium or a hand-laid-out PDF
library; `exceljs` or the license/security-encumbered SheetJS) whose weight is not justified for a
single-user app on a personal MacBook ([ADR 0025](0025-typescript-node-stack.md),
[ADR 0028](0028-local-macbook-hosting-cloudflare-tunnel.md)). They are built only when a concrete
need appears — printing/archiving a season summary, or pivoting a SQL export in a spreadsheet — so a
future contributor does not reflexively `npm install puppeteer`.

## Considered and rejected

- **MCP-only (binaries as base64 blobs).** "Open in browser" barely works and downloading a blob from
  the agent surface is clumsy.
- **REST-only for every format.** Loses inline viewing inside the agent, which is the primary interface.
- **`Accept:`-header content negotiation.** Invisible in a URL, awkward from a browser, heavier to test.
- **One wide denormalized Digest CSV** (a `role` column + the union of batting and pitching columns).
  Fuses two entities the domain deliberately keeps apart and reads as sparse noise.
- **All five formats now.** Pulls two heavyweight dependencies into the app before a use for them exists.
