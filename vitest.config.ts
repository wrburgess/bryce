import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/contract/**/*.test.ts"],
    environment: "node",
    // Tests must never hit the network; anything reaching for live HTTP is a bug.
    setupFiles: ["test/network-guard.ts"],
    testTimeout: 10_000,
  },
});
