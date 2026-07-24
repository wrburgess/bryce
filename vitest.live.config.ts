import { defineConfig } from "vitest/config";

/**
 * The explicit LIVE tier (issue #25). This separate config IS the opt-in: it
 * includes ONLY `*.live.test.ts` and wires NO network guard, so a real contract
 * smoke against an external service can run — deliberately, and never by default.
 *
 * Run it with `npm run test:live`. It is excluded from the default suite
 * (vitest.config.ts) and is NOT part of CI's required checks — so `npm test` and
 * the CI gate stay fully offline.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.live.test.ts"],
    environment: "node",
    // Live network calls are slower than the offline default; give them room.
    testTimeout: 30_000,
  },
});
