# Bryce — Daily Baseball Digest

A single-user Rails 8 application that emails a daily digest of the previous day's stats for a
personal watch list of baseball players across three levels: **MLB**, **MiLB** (all levels), and
**NCAA**. Boring, conventional Rails over clever custom solutions.

- **Product spec / handoff:** [`docs/product/daily-baseball-digest-handoff.md`](docs/product/daily-baseball-digest-handoff.md)
- **Domain glossary & decisions:** [`CONTEXT.md`](CONTEXT.md) + [`docs/adr/`](docs/adr/)

## Stack

Rails 8 · Solid Queue (+ `config/recurring.yml`) · Hotwire · Bootstrap 5 · SQLite · ActionMailer ·
Faraday · Minitest.

## AI config

This repo vendors the [ai-config](https://github.com/wrburgess/ai-config) Generic Baseline
(canonical instructions in [`AGENTS.md`](AGENTS.md), host values in [`PROJECT.md`](PROJECT.md)),
trimmed to the nine dev-lifecycle skills as a host Customization. Notable host policies:

- **Human gates:** plan approval is auto-approved; the **merge gate is the one human stop**
  (`PROJECT.md` → *Lifecycle Host* → *Human gates*).
- **Quality gate:** `ruby scripts/parity_check.rb` from day one; the Rails checks in
  `PROJECT.md` → *Quality Checks* apply once the app is scaffolded.

After cloning, activate the branch-protection guardrails once:

```bash
bin/setup
```
