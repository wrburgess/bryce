import { describe, expect, it } from "vitest";
import { runProbe } from "../src/cli/ncaa-probe.js";
import { NcaaAccessDeniedError, NcaaClient } from "../src/ncaa/client.js";

describe("ncaa:probe", () => {
  it("reports an HTTP-200 access denial as a stable machine outcome", async () => {
    const client = new NcaaClient({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("<html><title>Access Denied</title></html>"),
        }),
      delayMs: 0,
    });
    const output: string[] = [];

    await expect(
      runProbe(["--seq", "9702101", "--season", "2026", "--type", "batting"], {
        client,
        write: (line) => output.push(line),
      }),
    ).resolves.toBe(1);

    expect(output).toEqual(["probe seq=9702101 season=2026 type=batting result=access_denied"]);
  });

  it("keeps the denial type at the client boundary", async () => {
    const client = new NcaaClient({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("<html><title>Access Denied</title></html>"),
        }),
      delayMs: 0,
    });

    await expect(client.getGameLogPage(9702101, "2026", "batting")).rejects.toBeInstanceOf(
      NcaaAccessDeniedError,
    );
  });
});
