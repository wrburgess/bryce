# In-app Snapshot + Player List Backup, complementary to Litestream replication

Bryce gains an in-app **Snapshot** (a whole-database, point-in-time file copy) and a portable,
versioned **Player List Backup** (every Player row, re-importable) for *logical* recovery — rolling
back a bad migration or a bad edit, and preserving the one irreplaceable thing, the human's Player
choices and notes. This is deliberately **separate from and complementary to** the Litestream
**Replica** ([ADR 0026](0026-sqlite-over-postgres.md), [ADR 0028](0028-local-macbook-hosting-cloudflare-tunnel.md)):
continuous replication is off-box disaster recovery for *hardware* loss, but it faithfully streams a
bad migration's corruption too, depends on committing to Cloudflare R2, and cannot be exercised by a
unit test — so it does not, on its own, satisfy issue #67's "restorable after a bad migration,
verified by test" requirement.

## Considered Options

- **Rely on Litestream alone** — rejected: it replicates corruption as readily as good data, cannot
  be verified by a CI test, and depends on an R2 setup and cost the owner has not committed to.
- **Build a full off-box backup subsystem now** (scheduled upload, tiered retention) — rejected as
  out-of-scope and a second, competing durability story; off-box durability for **Snapshots** is
  deferred, not designed here.
- **Chosen:** a local, testable in-app **Snapshot** + **Player List Backup** — a manual command, an
  automatic Snapshot taken before any *pending* migration applies, and a scheduled nightly Snapshot,
  all under a keep-last-N retention policy in a local `backups/` directory. **Restore** is a guarded
  operation (integrity-check the incoming file and confirm the expected tables, take a safety-Snapshot
  of the current database, then atomically swap and clear stale WAL sidecars); the **Player List
  Backup** re-imports network-free by upserting on each Player's natural identity (MLB `external_id`
  or NCAA `ncaa_player_seq`), never re-pulling from the sources.

## Consequences

- Two backup mechanisms now coexist. They are **complementary, not redundant** — the **Snapshot** is
  the local, testable point-in-time rollback; the **Replica** is the continuous off-box guard against
  hardware loss. Neither should be removed as duplicating the other.
- Each **Snapshot** is a full-size copy consuming local disk; the keep-last-N policy bounds the total.
- Off-box durability for **Snapshots** is not yet solved: until a follow-up adds it, a **Snapshot**
  survives only as long as the laptop's disk. The **Replica** (once enabled) remains the off-box story
  for the live database.
- **Stat Line** history is included in a **Snapshot** precisely because re-pulling it is slow (source
  rate limits) to impossible (NCAA past seasons may be unavailable), even though it is nominally
  re-derivable; the **Player List Backup** is the portable capture of the choices that are *never*
  re-derivable.
