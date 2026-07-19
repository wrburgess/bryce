# Host on the HC's MacBook behind a Cloudflare Tunnel; jobs are self-healing, not punctual

Bryce runs on the HC's MacBook (managed by `launchd`), exposed via a **Cloudflare Tunnel**
(`cloudflared`) with Cloudflare Access in front of the MCP/API endpoints — no VPS, no port
forwarding, and Litestream replicates the SQLite file to R2 on the same Cloudflare account. Chosen
over a VPS/Fly.io for zero hosting cost and because the HC already operates Cloudflare.

The binding design consequence: a laptop sleeps, so **no job may assume it ran on schedule**. Every
fetch run covers a trailing multi-day window (which also catches MLB stat corrections and late West
Coast finals), digest delivery is keyed by covered-date so any missed digest sends on next wake
rather than being lost, and all writes are idempotent upserts. A `pmset` scheduled wake around the
5:00 AM Central run time makes misses rare; the self-healing design makes them harmless. Email goes
out via a provider-agnostic mailer — default **Postmark** (existing free Developer plan, 100
emails/month), with the HC's **Forward Email** SMTP as the swap-in alternative.
