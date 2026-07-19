# SQLite (WAL mode) over Postgres, with Litestream replication

Bryce is single-user with one meaningful writer (the nightly fetch job) plus occasional MCP-tool
writes, and will hold well under a gigabyte for years. We chose **SQLite in WAL mode** (typed schema
and migrations via Drizzle) over Postgres: the database is a file, so there is no second server
process, no credential management, and — decisive for a hands-off owner self-hosting on a laptop —
no major-version upgrade treadmill. Durability comes from **Litestream** streaming changes to
Cloudflare R2. The file-as-contract also enables the sanctioned analysis annex (ADR 0025): Python or
DuckDB reads the same file read-only, with no network database or role management.

Postgres's advantages (concurrent multi-instance writers, row-level security, extensions like
pgvector) don't apply to this workload. The decision is deliberately cheap to reverse: sub-gigabyte
data behind Drizzle (which speaks both dialects) makes a future SQLite→Postgres migration an
afternoon of dump-and-load, and Turso/libSQL offers hosted SQLite semantics if the deployment target
ever loses persistent disk.
