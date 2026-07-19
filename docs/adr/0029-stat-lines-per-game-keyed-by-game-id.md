# Stat Lines are per-game, keyed by the source Game ID — not per-date

The product handoff proposed `unique [player_id, game_date, stat_type]`, which cannot represent a
doubleheader (two games, one date — routine in MiLB, where twin seven-inning games are scheduled on
purpose): game two would overwrite or collide with game one. We store one Stat Line per game per
role instead, unique on `[player_id, game_id, stat_type]`, where `game_id` is the MLB Stats API
`gamePk` and the NCAA adapter synthesizes a stable equivalent (date + opponent + game sequence)
inside its isolation boundary. Storage stays a faithful mirror of games that actually happened —
any per-day view (the digest showing "Game 1 / Game 2") is presentation, never storage — and
per-game keys keep re-fetch corrections and suspended-game resumptions idempotent. This is a
**deliberate deviation from the written spec**: do not "simplify" back to date-keyed uniqueness.
