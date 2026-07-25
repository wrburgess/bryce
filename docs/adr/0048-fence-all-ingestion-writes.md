# Fence all ingestion writes behind refresh ownership

**Status:** accepted — closes issue #81's stale-writer gap left by ADR 0043.

## Decision

Every mutation produced by a whole-watch-list Refresh is executed in a short
`BEGIN IMMEDIATE` transaction that first proves the exact `refresh_runs` row is
still `running` with a strictly live lease. The mutation and predicate share
that transaction; provider I/O is always buffered before it. A refused mutation
means the run is `superseded`: it adds no counts or progress, does not sync tags,
and never settles late.

The fence covers calendars, MLB player/stat rows, and every Highlightly write:
match and box-score caches, legacy-line deletion, Highlightly stat upserts,
source activation, and cursor advancement. Lease renewal uses the same strict
live predicate, so a worker at (or past) expiry cannot revive itself before
reaping.

Targeted refresh captures the greatest committed `refresh_runs.id` while no
live whole refresh exists. Each of its writes repeats, in its own immediate
transaction, the assertion that no later run id exists. The append-only run id
is therefore a durable generation: a whole sweep that commits between targeted
admission and write makes the targeted write a no-op. A targeted request that
finds a live whole sweep, or loses its generation later, returns the observable
`{ skipped: true, reason: "whole-refresh-running", inserted: 0, updated: 0,
calendarFailures: [] }` result.

## Consequences

- Refresh freshness cannot describe rows overwritten by a reaped writer.
- Targeted refresh is deliberately deferred rather than racing a whole sweep.
- Cross-process tests use a real file-backed child process and IPC barriers;
  elapsed-time sleeps do not establish this invariant.
