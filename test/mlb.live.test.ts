import { describe, expect, it } from "vitest";
import { MlbClient } from "../src/mlb/client.js";

/**
 * The LIVE contract smoke (issue #25). This is the ONE sanctioned real network
 * call: it hits the public MLB Stats API to prove our client still matches the
 * upstream contract. It runs ONLY under `npm run test:live` (vitest.live.config.ts);
 * it is excluded from the default suite and from CI's required checks, so `npm test`
 * stays fully offline behind the network guard.
 *
 * A network-unavailable environment is an explicit skip, not a failure — the smoke
 * proves the contract when the network is there, and stays silent when it is not.
 */

/** True for the errors that mean "no network here", as opposed to a contract break. */
function isNetworkUnavailable(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}` : String(err);
  return /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(text);
}

describe("MLB Stats API live contract smoke", () => {
  it("getTeam(147) returns the New York Yankees (id + name contract)", async (ctx) => {
    const client = new MlbClient({ delayMs: 0 });
    let team: Awaited<ReturnType<MlbClient["getTeam"]>>;
    try {
      team = await client.getTeam(147);
    } catch (err) {
      if (isNetworkUnavailable(err)) {
        ctx.skip();
        return;
      }
      throw err;
    }
    // teamId 147 is the Yankees — a stable, decades-old franchise id. If the API
    // ever drops `name` or `id`, the Zod parse in getTeam throws and this fails loud.
    expect(team.id).toBe(147);
    expect(team.name).toContain("Yankees");
  });

  /**
   * #204: the unscoped `/people/search` stopped covering Single-A and Rookie,
   * and five rostered players became unfindable by name. No OFFLINE test can
   * catch that — it is a change in an upstream default we do not control, and
   * an offline test asserting their answer would pin their behavior and rot.
   * This is the one place the round trip can be proven end to end.
   *
   * personId 837864 is deliberate. He plays in the Dominican Summer League,
   * which is NOT a sportId of its own — sportId 16 covers every rookie/complex
   * league and `league_name` is the only thing separating the DSL from the
   * domestic complexes (src/mlb/levels.ts). So the DSL is the deepest corner of
   * the LAST rung in SPORT_IDS, and this fails first if the scope is dropped on
   * our side or narrows again on theirs. Both halves are asserted because they
   * are different failures with the same symptom — "we stopped asking
   * correctly" versus "they stopped answering".
   */
  it("scoped searchPeople resolves a DSL (sportId 16) identity by name", async (ctx) => {
    const urls: string[] = [];
    const client = new MlbClient({
      delayMs: 0,
      fetchImpl: (url) => {
        urls.push(url);
        return fetch(url);
      },
    });
    let people: Awaited<ReturnType<MlbClient["searchPeople"]>>;
    try {
      people = await client.searchPeople("Leanders Matos");
    } catch (err) {
      if (isNetworkUnavailable(err)) {
        ctx.skip();
        return;
      }
      throw err;
    }
    expect(urls[0]).toContain("sportIds=");
    expect(people.map((p) => p.id)).toContain(837864);
  });
});
