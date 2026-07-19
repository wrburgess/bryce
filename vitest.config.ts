import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests must never hit the network; anything reaching for live HTTP is a bug.
    testTimeout: 10_000,
  },
});
