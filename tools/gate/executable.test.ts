import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExecutable } from "./executable.ts";

// Raised by the contractor review of 4576409, lens: does any guard fail open?
// `requires` names the executable a check needs, and existsSync answers a
// different question — a directory, a non-executable file, and a real binary
// are all "present". The declaration says this field names the executable and
// not a proxy for it, so the probe has to establish executability.

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "deuce-gate-"));
}

test("a real executable is executable", () => {
  const dir = sandbox();
  try {
    const bin = join(dir, "bin");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    assert.equal(isExecutable(bin), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The exact shape the review named: X_OK succeeds on a directory, because for
// a directory it means "traversable". Existence and executability are not the
// same question, and neither is traversability.
test("a directory is not executable, even though it is present and traversable", () => {
  const dir = sandbox();
  try {
    assert.equal(isExecutable(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a present but non-executable file is not executable", () => {
  const dir = sandbox();
  try {
    const plain = join(dir, "plain");
    writeFileSync(plain, "not a program\n");
    chmodSync(plain, 0o644);
    assert.equal(isExecutable(plain), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing path is not executable", () => {
  const dir = sandbox();
  try {
    assert.equal(isExecutable(join(dir, "nothing-here")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// node_modules/.bin entries are symlinks, so the probe must resolve them
// rather than stat the link.
test("a symlink to an executable is executable, and a dangling one is not", () => {
  const dir = sandbox();
  try {
    const bin = join(dir, "bin");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);

    const good = join(dir, "good-link");
    symlinkSync(bin, good);
    assert.equal(isExecutable(good), true, "a symlink to a real executable");

    const dangling = join(dir, "dangling-link");
    symlinkSync(join(dir, "gone"), dangling);
    assert.equal(isExecutable(dangling), false, "a dangling symlink");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// There is deliberately no test here asserting that the live declaration's
// prerequisite exists on this machine. Such a test gave the `tests` check —
// which declares no `requires` — a hidden dependency on node_modules, so a
// fresh worktree would fail it for a reason the declaration does not state.
// The gate already checks the live prerequisite at run time, loudly and with
// the fix named; asserting it again in a test only smuggles it in undeclared.
// Raised by the contractor review of ba62c8a.
