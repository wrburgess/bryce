# Player Tags — model & selector reference

Player tags let you select cohorts of Players ("everyone on my fantasy roster", "all DSL guys",
"shortstops I'm scouting"). This page is the **conceptual reference**: which tags exist, how they are
produced, and the selector grammar. For the operational commands, see the surface docs linked under
[Adding tags](#adding-tags).

Phase A of the [report engine](https://github.com/wrburgess/bryce/issues/29) (issue
[#30](https://github.com/wrburgess/bryce/issues/30)). One table, `player_tags(player_id, namespace,
value, source, created_at)`.

## The `source` column — derived vs. manual

Every tag is either **derived** or **manual**, and the two never fight:

- **Derived** tags (`source='derived'`) are computed from the Player's own data and **recomputed
  automatically** — on add, on every Refresh, and by a self-healing startup backfill. You never write
  them by hand; a write to a derived namespace is rejected. `tag rebuild` re-derives them for every
  Player.
- **Manual** tags (`source='manual'`) are set only through the tag commands and are **never touched by
  derivation** — a `status:` tag survives every Refresh.

Derivation rewrites only the `source='derived'` rows for a Player, so the two sets are disjoint by
construction. The namespaces are disjoint too: `level`, `pos`, `prospect` are derived-only; `status`
is manual-only.

## Derived namespaces

### `level:` (single-valued)

Exactly one `level:` tag per Player (enforced by a partial unique index). Mapped from
`(players.level, players.milbLevel)`:

| `players.level` | `players.milbLevel` | Tag |
|---|---|---|
| `mlb` | — | `level:mlb` |
| `milb` | `Triple-A` | `level:aaa` |
| `milb` | `Double-A` | `level:aa` |
| `milb` | `High-A` | `level:high-a` |
| `milb` | `Single-A` | `level:single-a` |
| `milb` | `Rookie` | `level:rookie` (may upgrade to `level:dsl` — below) |
| `ncaa` | — | `level:ncaa` |
| `milb` | *null / unknown* | *(no `level:` tag — conservative, no guess)* |

**`level:dsl` — the one stat-derived tag.** `sportId 16` collapses every Rookie/complex league, so the
Dominican Summer League is distinguishable only by a Stat Line's league name. When a **current Rookie**
Player's most-recent Stat Line is in the Dominican Summer League, his `level:rookie` upgrades to
`level:dsl`. The override applies **only** while his column level is Rookie — once he is promoted
(AA/AAA/MLB), his column level is authoritative and `dsl` never fires, even if an old DSL game is still
his latest stored line.

### `pos:` (granular **and** coarse)

Derived from `players.position` (MLB `primaryPosition.abbreviation`). Each Player gets his **granular**
position tag plus its **coarse** group(s), so a cohort can be selected at any altitude (a shortstop is
`pos:ss`, `pos:infield`, **and** `pos:batter`). A **null or unknown** abbreviation yields **no** `pos:`
tags (NCAA rows carry a null position — no wrong guess).

| Position | Granular | Coarse |
|---|---|---|
| `P` / `SP` / `RP` | `pos:p` / `pos:sp` / `pos:rp` | `pos:pitcher` |
| `C` | `pos:c` | `pos:batter` |
| `1B` / `2B` / `3B` / `SS` / `IF` | `pos:1b` … `pos:if` | `pos:infield`, `pos:batter` |
| `LF` / `CF` / `RF` / `OF` | `pos:lf` … `pos:of` | `pos:outfield`, `pos:batter` |
| `DH` | `pos:dh` | `pos:batter` |
| `TWP` (two-way) | `pos:twp` | `pos:pitcher`, `pos:batter` |

### `prospect`

A valueless-by-convention tag (fixed sentinel `value='prospect'`). Present **iff** the Player is not
MLB (`players.level !== 'mlb'` — the HC's "non-MLB" definition), and **dropped** on promotion to MLB.
Select it with the bare token `prospect`.

## Manual namespace

### `status:`

Set by hand to record roster choices. Allowed values: **`rostered`**, **`scouted`**. Adding a value
outside this set, or writing to a derived namespace, is rejected on every surface. Manual `status:`
tags are also round-tripped by the Player List Backup.

## Selector grammar

The same selector works on every surface (CLI `list --tags`, MCP `watchlist_list` `tags`, REST
`GET /api/players?tags=`):

- **Comma-separated tokens are AND** — `level:aaa,status:rostered` = AAA Players who are also rostered.
- **Token forms:** `namespace:value` (exact, e.g. `level:aaa`) **or** a **bare namespace** that matches
  any value in it (e.g. `prospect`, or `pos` for "has any position tag"). Overlapping tokens resolve
  correctly (`pos,pos:ss` is satisfiable by a single `pos:ss` tag).
- **Bounds:** duplicate tokens are de-duplicated; at most **16** tokens.
- **Malformed input is rejected, never silently ignored** — a token like `:foo` or a value with stray
  colons, and a provided expression that normalizes to **zero** tokens (e.g. `,,,` or whitespace),
  return a validation error (REST **400** / MCP `isError` / CLI exit `1`). An **absent** `tags` argument
  means "no filter" (the full list); a *present-but-empty* one is an error.
- There is **no OR/NOT grammar** — deferred until a real need appears.

## How derived tags stay current

Derivation runs wherever a Player's identity/location can change, so tags never go stale:

- On **add** (his first Refresh, or directly when Offseason Sleep skips it).
- On every **Refresh** — a single-player or the nightly whole-list sweep — so a promotion
  (Rookie → AA → AAA → MLB) moves his `level:` tag and drops `prospect` without intervention.
- On **batch add**, per newly staged Player.
- On **startup**, a self-healing backfill derives for any Player still missing his derived tags (via a
  `NOT EXISTS` anti-join — no whole-table scan), so an upgrade or a crashed partial run heals.

## Adding tags

Manual (`status:`) tags are managed on all three surfaces; derived tags are never added by hand.

| Surface | Add | Remove | List | Filter a cohort |
|---|---|---|---|---|
| **CLI** ([reference](../cli/README.md)) | `seed tag add --person-id N --tag status:rostered` | `seed tag remove … --tag status:rostered` | `seed tag list --person-id N` | `seed list --tags <expr>` |
| **MCP** ([reference](../mcp/README.md)) — the agent-facing interface | `player_tag_add` | `player_tag_remove` | `player_tags_list` | `watchlist_list` (`tags`) |
| **REST** ([reference](../api/README.md)) | `POST /api/players/:id/tags` | `DELETE /api/players/:id/tags/:namespace/:value` | `GET /api/players/:id/tags` | `GET /api/players?tags=<expr>` |

All surfaces address a Player by his external identity — MLB/MiLB `personId` or NCAA
`stats_player_seq` — resolving to a not-found error if he is absent. To force a full re-derivation of
the derived tags for every Player, run `seed tag rebuild`.
