import type { PlayerRow, StatLineRow } from "../db/schema.js";
import { levelAbbrev } from "../mlb/levels.js";

/**
 * The derivation engine (Phase A of #29): a PURE, DB-free rule list that maps a
 * Player (plus his most-recent Stat Line, for the one stat-derived tag) to the
 * set of `derived` tags he should carry. `src/tags/service.ts` reconciles the
 * DB against this output; nothing here reads or writes the database.
 *
 * The rule-list shape is deliberate: `level:`/`pos:`/`prospect` derive from the
 * Player's own columns, but `level:dsl` can only come from a Stat Line (sportId
 * 16 collapses every rookie league). A future stat-derived tag drops in as one
 * more rule without restructuring.
 */

export interface DerivedTag {
  namespace: string;
  value: string;
}

export interface DeriveContext {
  player: PlayerRow;
  /** The player's most-recent Stat Line, or null before his first Refresh. */
  latestStatLine: StatLineRow | null;
}

type Rule = (ctx: DeriveContext) => DerivedTag[];

/**
 * `(players.level, players.milbLevel)` → one `level:` value. An invalid MiLB
 * pair (`milb` with a null/unknown `milbLevel`) yields NO tag rather than a
 * guess — a conservative default matching the NCAA-null-position principle.
 */
const MILB_LEVEL_TO_TAG: Record<string, string> = {
  "Triple-A": "aaa",
  "Double-A": "aa",
  "High-A": "high-a",
  "Single-A": "single-a",
  Rookie: "rookie",
};

const levelRule: Rule = ({ player }) => {
  if (player.level === "mlb") return [{ namespace: "level", value: "mlb" }];
  if (player.level === "ncaa") return [{ namespace: "level", value: "ncaa" }];
  const value = player.milbLevel === null ? undefined : MILB_LEVEL_TO_TAG[player.milbLevel];
  return value === undefined ? [] : [{ namespace: "level", value }];
};

/**
 * MLB `primaryPosition.abbreviation` → a granular tag AND its coarse group(s),
 * so a cohort can be selected at any altitude (a shortstop is `pos:ss`,
 * `pos:infield`, and `pos:batter`). An unknown or null abbreviation yields NO
 * `pos:` tags (conservative — NCAA rows carry a null position).
 */
interface PosEntry {
  granular: string;
  coarse: string[];
}

const POSITION_MAP: Record<string, PosEntry> = {
  P: { granular: "p", coarse: ["pitcher"] },
  SP: { granular: "sp", coarse: ["pitcher"] },
  RP: { granular: "rp", coarse: ["pitcher"] },
  C: { granular: "c", coarse: ["batter"] },
  "1B": { granular: "1b", coarse: ["infield", "batter"] },
  "2B": { granular: "2b", coarse: ["infield", "batter"] },
  "3B": { granular: "3b", coarse: ["infield", "batter"] },
  SS: { granular: "ss", coarse: ["infield", "batter"] },
  IF: { granular: "if", coarse: ["infield", "batter"] },
  LF: { granular: "lf", coarse: ["outfield", "batter"] },
  CF: { granular: "cf", coarse: ["outfield", "batter"] },
  RF: { granular: "rf", coarse: ["outfield", "batter"] },
  OF: { granular: "of", coarse: ["outfield", "batter"] },
  DH: { granular: "dh", coarse: ["batter"] },
  TWP: { granular: "twp", coarse: ["pitcher", "batter"] },
};

const posRule: Rule = ({ player }) => {
  if (player.position === null) return [];
  const entry = POSITION_MAP[player.position.toUpperCase()];
  if (entry === undefined) return [];
  return [
    { namespace: "pos", value: entry.granular },
    ...entry.coarse.map((c) => ({ namespace: "pos", value: c })),
  ];
};

/**
 * A fixed sentinel `value='prospect'` (not an empty value) keeps the NOT-NULL
 * value column and the unique index uniform. Present iff the Player is not MLB
 * (the HC's "non-MLB" definition); dropped on promotion to MLB.
 */
const prospectRule: Rule = ({ player }) =>
  player.level !== "mlb" ? [{ namespace: "prospect", value: "prospect" }] : [];

/**
 * The one stat-derived tag: `level:dsl` when the most-recent Stat Line is in the
 * Dominican Summer League. Reuses `levelAbbrev`, which owns the load-bearing
 * "Dominican Summer League" literal, rather than re-encoding the match here.
 *
 * The DSL override applies ONLY to a player whose CURRENT column-derived level is
 * `rookie` (`players.level='milb'` AND `players.milbLevel='Rookie'`). A promoted
 * player's latest stored line may still be a DSL game he has not superseded, but
 * his column level (AA/AAA/MLB) is now authoritative — emitting `level:dsl` there
 * would let this stat rule discard the correct column level. So it never fires
 * once the player has moved off Rookie.
 */
const dslRule: Rule = ({ player, latestStatLine }) => {
  if (latestStatLine === null) return [];
  if (!(player.level === "milb" && player.milbLevel === "Rookie")) return [];
  return levelAbbrev(latestStatLine.sportId, latestStatLine.leagueName) === "DSL"
    ? [{ namespace: "level", value: "dsl" }]
    : [];
};

const RULES: readonly Rule[] = [levelRule, posRule, prospectRule, dslRule];

/**
 * Run every rule and return the deduped derived-tag set with the `level:`
 * namespace guaranteed SINGLE-VALUED: `level:dsl` supersedes the column-derived
 * level (the "upgrade" — never two level tags). De-dups identical tags.
 */
export function deriveTags(ctx: DeriveContext): DerivedTag[] {
  const all = RULES.flatMap((rule) => rule(ctx));
  const hasDsl = all.some((t) => t.namespace === "level" && t.value === "dsl");
  const seen = new Set<string>();
  const out: DerivedTag[] = [];
  for (const tag of all) {
    // Single-valued level: once dsl is present, drop every other level value.
    if (tag.namespace === "level" && hasDsl && tag.value !== "dsl") continue;
    const key = `${tag.namespace}\u0000${tag.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
