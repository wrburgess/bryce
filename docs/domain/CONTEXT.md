# Baseball Digest

The domain language of Bryce: a single-user daily digest of stat lines for a personal watch list of
baseball players across MLB, MiLB, and NCAA.

## Language

**Player**:
A human being on the watch list — exactly one record per person, whatever level or team he is at.
_Avoid_: "prospect" (a stage, not an identity), "level-slot" (a Player is not "Holliday at AAA")

**Level**:
A Player's current competitive tier — `mlb`, `milb`, or `ncaa` — a mutable *location*, never part of
identity.
_Avoid_: "league" (MiLB levels contain many leagues), "class"

**MiLB Level**:
The minor-league tier (Triple-A, Double-A, High-A, Single-A, Rookie/Complex) a `milb` Player is
currently assigned to; empty for `mlb` and `ncaa` Players.
_Avoid_: "affiliate" (that's the team, not the tier)

**Watch List**:
The set of *active* Players — the digest's audience of one's chosen few. Deactivating a Player
removes him from the digest but keeps his history.
_Avoid_: "roster" (a real baseball concept; using it here invites confusion)

**External ID**:
A Player's source-native identity: the MLB Stats API `personId`, which is stable across MLB and
every MiLB level. NCAA Players have no reliable equivalent (see *Flagged ambiguities*).
_Avoid_: "player id" (ambiguous with the app's own primary key)

## Relationships

- A **Player** has exactly one **Level** at a time; promotion or demotion *changes* his Level, it
  never creates a second Player.
- A **Player**'s Level, MiLB Level, and team are refreshed automatically from the source APIs
  during the nightly fetch — the digest regroups on its own when a Player moves.
- A **Watch List** is just the active subset of Players; there is no separate list object.

## Example dialogue

> **Dev:** "Holliday got called up Tuesday — do I need to move him to an MLB **Player**?"
> **Domain expert:** "No. He's one **Player** whose **Level** changed. Wednesday's digest shows him
> in the MLB section automatically, and his Triple-A lines from Monday are still his history."

## Flagged ambiguities

- "level" was used to mean both *identity* ("the AAA guy I'm watching") and *location* — resolved:
  location only, refreshed from the source, never identity.
- NCAA player identity is unresolved by design so far: no clean numeric ID; matching may need
  school + name. To be settled when the NCAA adapter is distilled (Phase 3).
