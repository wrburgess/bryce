import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The live tier (test/**/*.live.test.ts) is the ONLY sanctioned network path;
    // it never loads in the default suite. Preserve Vitest's node_modules defaults.
    exclude: [...configDefaults.exclude, "test/**/*.live.test.ts"],
    environment: "node",
    // A fail-closed network-egress guard (test/support/network-guard.ts, issue #25)
    // enforces the "tests must never hit the network" invariant: every in-process,
    // non-loopback fetch + TCP/TLS socket egress fails immediately and is recorded.
    // NOTE: `test.concurrent` is unsupported with the guard — its attempts buffer is
    // process-global and would cross-contaminate concurrent tests in one file.
    setupFiles: ["./test/support/network-setup.ts"],
    testTimeout: 10_000,
  },
});
