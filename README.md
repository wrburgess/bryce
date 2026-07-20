# Bryce — Daily Baseball Digest

A single-user, **AI-and-API-first** application that emails a daily digest of the previous day's
stats for a personal watch list of baseball players across three levels: **MLB**, **MiLB** (all
levels), and **NCAA**. No web UI: the primary interface is an **MCP server**, so Claude (web,
mobile, or CLI) is the front end.

- **Getting started (run it locally):** [`docs/guides/getting-started.md`](docs/guides/getting-started.md);
  production ops in [`docs/guides/running-bryce.md`](docs/guides/running-bryce.md)
- **Product spec / handoff:** [`docs/product/daily-baseball-digest-handoff.md`](docs/product/daily-baseball-digest-handoff.md)
  (see its 2026-07-19 architecture revision)
- **Domain glossary & decisions:** [`CONTEXT.md`](CONTEXT.md) + [`docs/adr/`](docs/adr/)
  (stack/storage/interface/hosting: ADRs 0025–0028)

## Stack

TypeScript on Node · Hono (REST API) · MCP TypeScript SDK (primary interface) · Zod (boundary
contracts) · SQLite in WAL mode + Drizzle (+ Litestream → R2 backup) · Vitest. Hosted on the HC's
MacBook behind a Cloudflare Tunnel with Cloudflare Access; email via Postmark (Forward Email SMTP
as the swappable alternative).

## AI config

This repo vendors the [ai-config](https://github.com/wrburgess/ai-config) Generic Baseline
(canonical instructions in [`AGENTS.md`](AGENTS.md), host values in [`PROJECT.md`](PROJECT.md)),
trimmed to the nine dev-lifecycle skills as a host Customization. Notable host policies:

- **Human gates:** plan approval is auto-approved; the **merge gate is the one human stop**
  (`PROJECT.md` → *Lifecycle Host* → *Human gates*).
- **Quality gate:** `ruby scripts/parity_check.rb` from day one; the npm checks in
  `PROJECT.md` → *Quality Checks* apply once the app is scaffolded.

After cloning, activate the branch-protection guardrails once:

```bash
bin/setup
```
