# Digest stat lines are an HC-specified fixed set with single-game rates, backed by fielding ingestion

The digest's stat text is an **HC-specified fixed format** (an HC choice, replacing the compact
"2-4, HR, 3 RBI" style): every stat is always shown, zeros included, in a fixed order. Batting lines
render `PA, H, K, 2B, 3B, HR, RBI, R, SB, CS, E, BB`; pitching lines render
`IP, ER, K, K/9, BB, HA, HRA, ERA, WHIP, S, HLD, QS` (HA/HRA = hits/home runs allowed). The
formatters live in `src/digest/render.ts`; nothing about the date/opponent/doubleheader framing
changed.

ERA, WHIP, and K/9 are **single-game rates** (an HC choice): ER x 9 / IP, (BB + HA) / IP, and
K x 9 / IP for that outing only, never season-cumulative. IP is baseball notation — "6.1" is six
innings plus one out — so `src/digest/rates.ts` converts to outs (integer part x 3 + fraction digit,
fraction 0-2 only) before any division; unparseable notation is null, never a wrong number. ERA and
WHIP round to two decimals, K/9 to one (matching the HC's example). Zero or unparseable IP renders
all three rates as `-`. QS is `1` when IP >= 6.0 innings (18 outs) AND ER <= 3, else `0`. Saves and
holds default to 0 when absent — NCAA tracks no holds, so an NCAA reliever legitimately always shows
`HLD 0`.

The batter's **E comes from a new `fielding` stat category** (an HC choice): `stat_lines.stat_type`
gains a third value (type-level only in SQLite — no migration; the ADR 0029 unique key already
handles it), the MLB sweep fetches the `fielding` game-log group alongside hitting/pitching, and the
NCAA adapter fetches the fielding category page (`E` maps to the canonical `errors` key). Fielding
rows are storage, **never a rendered line**: at assembly (`src/digest/assemble.ts`) a fielding row's
errors merge into the same player+game batting line, a fielding-only appearance synthesizes an
all-zeros batting line carrying the E, and the rows are marked reported with everything else. Two-way
players keep separate batting and pitching lines.

NCAA caveats, all deliberate: the bundled fielding `year_stat_category_id`s in `src/ncaa/seasons.ts`
follow the source's consecutive-id pattern (batting, pitching, fielding) but are **UNVERIFIED** —
Akamai blocks live confirmation from the build environment — pending `npm run ncaa:probe -- --type
fielding` on the host; a wrong id fails loud, never a silent gap. And because the scraped batting
table may carry no PA column, the normalizer **derives PA** as AB + BB + HBP + SF + SH over whichever
components the page exposes (an approximation: the page has no catcher's-interference column). A real
PA column, when present, maps directly and wins. The renderer keeps its own AB + BB + HBP fallback as
belt and suspenders for rows ingested before this change.
