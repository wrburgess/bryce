# MCP server as the primary interface; no web UI

The original handoff's Phase 2 was a server-rendered watch-list UI (CRUD, typeahead, stat pages).
The HC re-scoped Bryce to an AI-and-API interface. The primary surface is an **MCP server** exposing
the app's capabilities as tools (watch-list add/remove/search, stat-line queries, digest
preview/trigger, and a read-only SQL query tool for ad-hoc analysis) — so any Claude surface
(claude.ai, mobile, Claude Code) becomes the UI, reached remotely through the Cloudflare Tunnel with
Cloudflare Access in front. A thin token-authed **REST API** rides alongside for scripted clients,
sharing the same Zod validation. The daily digest email remains the one push surface and gains an
optional LLM-written narrative summary above the stat tables.

The explicit no: no web UI is built or planned. If glanceability is ever missed, the sanctioned
first step is a single read-only HTML page rendered from existing queries — not a framework.
