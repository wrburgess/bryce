import type { HighlightlyClient, HighlightlyNcaaPlayerSearchResult } from "../highlightly/client.js";
import { HighlightlyError } from "../highlightly/client.js";
import type { MlbClient } from "../mlb/client.js";
import { SEARCH_RESULT_CAP } from "../mlb/client.js";

/**
 * The ONE home for the two identity-resolution rules an `add` command shares —
 * MLB name search with `--pick` disambiguation, NCAA name search with no pick
 * escape — plus the Highlightly error-to-exit-code mapping.
 *
 * These lived inline in `src/cli/seed.ts` until #191 added a second add
 * command (`sk players add`). Copying them would have re-authored a shared
 * invariant at a second call site, which is how the two ambiguity rules drift
 * apart by omission rather than loudly (`rules/scripting.md`): the next
 * surface that needs "print the candidates and refuse" would be written
 * without it and still read as locally correct. Extracted VERBATIM — the
 * output strings and exit codes here are byte-identical to the ones `seed add`
 * shipped, which is why `test/seed.test.ts` needed no edit.
 *
 * That verbatim claim covers the EXTRACTED lines, and still holds. #204 then
 * added a line neither command shipped (the capped-list notice) — deliberately
 * here rather than at one call site, which is the whole point of this file: a
 * new shared rule is authored once and both `add` surfaces get it, instead of
 * one of them getting it and the other silently reading as locally correct.
 *
 * Deliberately narrow deps: a `Pick<>` of the one client method each rule
 * calls plus a line sink, so a caller cannot pass a whole CLI dependency
 * bundle and quietly grow a coupling.
 */

/** What the MLB pick rule needs: the search call and somewhere to print. */
export interface MlbPickDeps {
  client: Pick<MlbClient, "searchPeople">;
  write: (line: string) => void;
}

/** What the NCAA pick rule needs: the search call and somewhere to print. */
export interface NcaaPickDeps {
  highlightlyClient: Pick<HighlightlyClient, "searchNcaaPlayers">;
  write: (line: string) => void;
}

/**
 * The one line that tells an operator the candidate list they are reading is
 * the API's maximum rather than the whole truth. Names NO flag, deliberately:
 * the two callers spell the same input differently (`players add --name`,
 * `seed add --search`), so a message naming one is wrong at the other.
 */
const cappedNotice = (): string =>
  `note: the API caps this search at ${SEARCH_RESULT_CAP} candidates; the list may be incomplete — narrow the name`;

/**
 * Resolve an MLB/MiLB name to exactly one `personId`, or null having already
 * written the operator-facing reason. One hit and no `--pick` resolves
 * silently; several hits print a NUMBERED candidate list and refuse, because a
 * guessed pick is a wrong player added under a right-looking summary.
 *
 * A result set AT `SEARCH_RESULT_CAP` is indistinguishable from a truncated one
 * — the API returns no total and `limit` cannot raise the cap — so both the
 * refusal and the `--pick` path say so. Rendering a capped list as complete
 * turns this function's own guarantee inside out: the numbered list exists to
 * stop a guessed pick, and a pick off a silently truncated list is the same
 * wrong player arriving by a quieter route (#204).
 */
export async function pickFromSearch(
  name: string,
  pickFlag: string | undefined,
  deps: MlbPickDeps,
): Promise<number | null> {
  const results = await deps.client.searchPeople(name);
  const capped = results.length >= SEARCH_RESULT_CAP;
  if (results.length === 0) {
    deps.write(`error: no matches for search=${name}`);
    return null;
  }
  if (results.length === 1 && pickFlag === undefined) {
    const only = results[0];
    return only !== undefined ? only.id : null;
  }
  if (pickFlag === undefined) {
    deps.write(`multiple matches for search=${name}; re-run with --pick I`);
    results.forEach((p, i) => {
      deps.write(
        `[${i + 1}] personId=${p.id} name=${p.fullName} position=${p.primaryPosition?.abbreviation ?? "?"}`,
      );
    });
    // Last, so it is the line still on screen after 50 candidates scroll past.
    if (capped) deps.write(cappedNotice());
    return null;
  }
  const pick = Number.parseInt(pickFlag, 10);
  const chosen = Number.isInteger(pick) ? results[pick - 1] : undefined;
  if (chosen === undefined) {
    deps.write(`error: --pick ${pickFlag} out of range 1..${results.length}`);
    return null;
  }
  // Advisory, never fatal: a capped list with a valid --pick still succeeds.
  if (capped) deps.write(cappedNotice());
  return chosen.id;
}

/**
 * Resolve an NCAA name to exactly one Highlightly identity, or null having
 * already written the reason. There is deliberately NO `--pick` escape here:
 * an ambiguous NCAA name tells the operator to re-run with the explicit
 * Highlightly identity the candidate lines print. Minting a second, different
 * ambiguity rule for NCAA is precisely what #191 exists to prevent.
 */
export async function pickNcaaFromSearch(
  name: string,
  deps: NcaaPickDeps,
): Promise<HighlightlyNcaaPlayerSearchResult | null> {
  const results = await deps.highlightlyClient.searchNcaaPlayers(name);
  if (results.value.length === 0) {
    deps.write(`error: no NCAA matches for name=${name}`);
    return null;
  }
  if (results.value.length > 1) {
    deps.write(`multiple NCAA matches for name=${name}; re-run with an explicit Highlightly identity`);
    results.value.forEach((player, index) => {
      deps.write(`[${index + 1}] highlightlyPlayerId=${player.playerId} name=${player.canonicalName} teamId=${player.teamId}`);
    });
    return null;
  }
  return results.value[0]!;
}

/**
 * Render a Highlightly failure and map it to its documented exit code —
 * 78 not-configured, 75 quota/coverage (retry later), 65 bad identity input,
 * 69 anything else upstream. Anything that is not a HighlightlyError is
 * rethrown: a bug must not be laundered into a tidy exit status.
 */
export function writeHighlightlyError(err: unknown, deps: { write: (line: string) => void }): number {
  if (err instanceof HighlightlyError) {
    deps.write(`error: ${err.code}: ${err.message}`);
    return err.code === "highlightly_not_configured" ? 78 : err.code === "highlightly_quota_exhausted" || err.code === "highlightly_coverage_incomplete" ? 75 : err.code === "highlightly_player_not_found" || err.code === "highlightly_identity_mismatch" ? 65 : 69;
  }
  throw err;
}
