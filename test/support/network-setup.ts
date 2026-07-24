// network-setup.ts — Vitest `setupFiles` entry that arms the fail-closed network
// guard for every default-suite test (issue #25). Wired in vitest.config.ts.
//
// `setupFiles` (not `globalSetup`) is required so the patch lands in each test
// worker's own module registry, where the code under test resolves `fetch`,
// `net`, and `tls`.
//
// NOTE: `test.concurrent` is unsupported with the guard — the attempts buffer and
// its per-test `afterEach` drain are shared process-global state, so concurrent
// tests in one file would cross-contaminate each other's recorded attempts.

import { afterAll, afterEach } from "vitest";
import {
  assertNoUnapprovedAttempts,
  installNetworkGuard,
  resetAttempts,
} from "./network-guard.js";

installNetworkGuard();

// Fail the OWNING test on any unapproved attempt, then always reset so a leak in
// one test can never poison the next. The `finally` guarantees the reset even when
// the assertion throws first.
afterEach(() => {
  try {
    assertNoUnapprovedAttempts();
  } finally {
    resetAttempts();
  }
});

// Suite-level backstop: catch any attempt that lands after the last test's
// afterEach has already run (a late async connect).
afterAll(() => {
  try {
    assertNoUnapprovedAttempts();
  } finally {
    resetAttempts();
  }
});
