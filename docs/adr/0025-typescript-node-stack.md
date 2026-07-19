# TypeScript on Node for the application stack

The original handoff specified Rails 8, chosen when the app included a server-rendered web UI. The
HC re-scoped Bryce to an AI-and-API-first tool (no web UI) that agents — not the HC — write, review,
and maintain, and asked for a stack selected on that basis. We chose **TypeScript on Node** over Go,
Python, and Rails: the dominant risk surface is external JSON (MLB Stats API, ncaa-api), where
TypeScript + Zod validates loudly at the boundary (Go's `encoding/json` silently zero-fills missing
fields — the worst failure mode for a stats pipeline a hands-off owner won't catch); the MCP
TypeScript SDK is the protocol's reference implementation, and the MCP server is now the app's
primary interface; and one typed language covers pipeline, API, MCP, and digest.

## Considered Options

- **Go** — the serious runner-up: single static binary, near-zero maintenance entropy, tiny
  dependency surface. Rejected because its permissive JSON decoding trades loud failures for silently
  wrong stats, and its MCP/glue ecosystem is thinner. Revisit if operational quiet ever outranks
  boundary safety.
- **Python** — strong AI ecosystem, but dynamic typing shifts error-catching from CI to runtime;
  wrong trade for agent-written, hands-off-owned code. Python remains sanctioned as a contained
  analysis annex (read-only against the SQLite file) if statistical modeling ever materializes.
- **Rails** — earns its keep through server-rendered UI conventions this app no longer has.
