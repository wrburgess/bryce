/**
 * Compact, offline validation for the Reviewer Evidence block required by the
 * lifecycle. This deliberately does not fetch lifecycle-host artifacts: callers
 * supply the artifact URL and any platform commit attestation they observed.
 */

export interface ReviewerEvidence {
  requestMarker: string;
  reviewedSha: string;
  baseline: string;
  reviewer: string;
  reviewerModel: string;
  disposition: "ok";
  artifactUrl: string;
}

export type ReviewerEvidenceInput = Partial<Omit<ReviewerEvidence, "disposition">> & {
  disposition?: string;
};

export type ReviewerEvidenceResult =
  | { valid: true; evidence: ReviewerEvidence }
  | { valid: false; reason: string };

export type FallbackClassification = "ok" | "unreachable" | "timed-out" | "unattested";

export interface FallbackEvidenceInput {
  requestCreated: boolean;
  artifactUrl?: string;
  responseReceived: boolean;
  commitId?: string;
  reviewedSha: string;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "pending";
}

function validArtifactUrl(value: string | undefined): value is string {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Fail closed unless every durable evidence field is present and covers `headSha`. */
export function validateReviewerEvidence(
  input: ReviewerEvidenceInput,
  headSha: string,
): ReviewerEvidenceResult {
  if (!nonEmpty(input.requestMarker)) return { valid: false, reason: "missing requestMarker" };
  if (!nonEmpty(input.reviewedSha)) return { valid: false, reason: "missing reviewedSha" };
  if (!nonEmpty(input.baseline)) return { valid: false, reason: "missing baseline" };
  if (!nonEmpty(input.reviewer)) return { valid: false, reason: "missing reviewer" };
  if (!nonEmpty(input.reviewerModel)) return { valid: false, reason: "missing reviewerModel" };
  if (!nonEmpty(input.disposition)) return { valid: false, reason: "missing disposition" };
  if (!nonEmpty(input.artifactUrl)) return { valid: false, reason: "missing artifactUrl" };
  if (input.disposition !== "ok") return { valid: false, reason: "disposition is not ok" };
  if (!validArtifactUrl(input.artifactUrl)) return { valid: false, reason: "invalid artifact URL" };
  if (input.reviewedSha !== headSha) return { valid: false, reason: "stale reviewed SHA" };

  return {
    valid: true,
    evidence: {
      requestMarker: input.requestMarker,
      reviewedSha: input.reviewedSha,
      baseline: input.baseline,
      reviewer: input.reviewer,
      reviewerModel: input.reviewerModel,
      disposition: "ok",
      artifactUrl: input.artifactUrl,
    },
  };
}

/**
 * Classify an asynchronous fallback without treating a request as a review.
 * Platform success is usable only when it attests exactly to the reviewed SHA.
 */
export function classifyFallbackEvidence(input: FallbackEvidenceInput): FallbackClassification {
  if (!input.requestCreated || !validArtifactUrl(input.artifactUrl)) return "unreachable";
  if (!input.responseReceived) return "timed-out";
  if (!nonEmpty(input.commitId) || input.commitId !== input.reviewedSha) return "unattested";
  return "ok";
}
