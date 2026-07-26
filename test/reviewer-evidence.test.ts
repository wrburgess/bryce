import { describe, expect, it } from "vitest";

import {
  classifyFallbackEvidence,
  parseReviewerEvidenceBlock,
  validateReviewerEvidence,
  type ReviewerEvidence,
} from "../scripts/reviewer-evidence.js";

const SHA = "a".repeat(40);
const evidence: ReviewerEvidence = {
  requestMarker: "reviewer-request-123",
  reviewedSha: SHA,
  baseline: "origin/main",
  reviewer: "codex",
  reviewerModel: "gpt-5.6-terra",
  disposition: "ok",
  artifactUrl: "https://github.com/example/bryce/pull/131#issuecomment-1",
};

describe("Reviewer Evidence", () => {
  it("accepts complete evidence for the current SHA", () => {
    expect(validateReviewerEvidence(evidence, SHA)).toEqual({ valid: true, evidence });
  });

  it("accepts an HTTPS GitHub PR-comment artifact for the expected repository and PR", () => {
    expect(validateReviewerEvidence(evidence, SHA, { repository: "example/bryce", prNumber: 131 }))
      .toEqual({ valid: true, evidence });
  });

  it("rejects incomplete evidence", () => {
    const { artifactUrl: _artifactUrl, ...missingArtifact } = evidence;
    expect(validateReviewerEvidence(missingArtifact, SHA)).toEqual({
      valid: false,
      reason: "missing artifactUrl",
    });
  });

  it("rejects a pending disposition", () => {
    expect(validateReviewerEvidence({ ...evidence, disposition: "pending" }, SHA)).toEqual({
      valid: false,
      reason: "missing disposition",
    });
  });

  it("rejects an invalid artifact URL", () => {
    expect(validateReviewerEvidence({ ...evidence, artifactUrl: "local-review.md" }, SHA)).toEqual({
      valid: false,
      reason: "invalid artifact URL",
    });
  });

  it.each([
    "http://github.com/example/bryce/pull/131#issuecomment-1",
    "https://github.com/example/bryce/issues/131#issuecomment-1",
    "https://github.com/example/bryce/pull/131",
    "https://github.com/other/bryce/pull/131#issuecomment-1",
    "https://github.com/example/bryce/pull/132#issuecomment-1",
  ])("rejects an artifact URL outside the GitHub PR-comment scope: %s", (artifactUrl) => {
    expect(validateReviewerEvidence({ ...evidence, artifactUrl }, SHA, {
      repository: "example/bryce",
      prNumber: 131,
    })).toEqual({ valid: false, reason: "invalid artifact URL" });
  });

  it("parses the machine-locatable Reviewer Evidence comment block", () => {
    expect(parseReviewerEvidenceBlock(`
### Reviewer Evidence
<!-- reviewer-evidence
request-marker: ${evidence.requestMarker}
reviewed-sha: ${evidence.reviewedSha}
baseline: ${evidence.baseline}
reviewer: ${evidence.reviewer}
reviewer-model: ${evidence.reviewerModel}
disposition: ${evidence.disposition}
artifact-url: ${evidence.artifactUrl}
-->
`)).toEqual(evidence);
  });

  it("returns null when a comment has no Reviewer Evidence block", () => {
    expect(parseReviewerEvidenceBlock("## Self-review\nNo independent review yet.")).toBeNull();
  });

  it("rejects evidence for an older commit", () => {
    expect(validateReviewerEvidence(evidence, "b".repeat(40))).toEqual({
      valid: false,
      reason: "stale reviewed SHA",
    });
  });

  it("classifies a fallback with no request or artifact as unreachable", () => {
    expect(classifyFallbackEvidence({
      requestCreated: false,
      responseReceived: false,
      reviewedSha: SHA,
    })).toBe("unreachable");
  });

  it("classifies a requested fallback with no response as timed-out", () => {
    expect(classifyFallbackEvidence({
      requestCreated: true,
      responseReceived: false,
      reviewedSha: SHA,
    })).toBe("timed-out");
  });

  it("fails closed for an async response without an exact commit attestation", () => {
    const base = {
      requestCreated: true,
      artifactUrl: evidence.artifactUrl,
      responseReceived: true,
      reviewedSha: SHA,
    };
    expect(classifyFallbackEvidence(base)).toBe("unattested");
    expect(classifyFallbackEvidence({ ...base, commitId: "b".repeat(40) })).toBe("unattested");
  });

  it.each([undefined, "local-review.md", "https://example.invalid/review"])(
    "classifies an answered fallback without a host artifact URL as unreachable: %s",
    (artifactUrl) => {
      expect(classifyFallbackEvidence({
        requestCreated: true,
        artifactUrl,
        responseReceived: true,
        commitId: SHA,
        reviewedSha: SHA,
      })).toBe("unreachable");
    },
  );

  it("accepts a fallback answered with a host artifact attesting the reviewed SHA", () => {
    expect(classifyFallbackEvidence({
      requestCreated: true,
      artifactUrl: evidence.artifactUrl,
      responseReceived: true,
      commitId: SHA,
      reviewedSha: SHA,
    })).toBe("ok");
  });
});
