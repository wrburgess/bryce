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
});
