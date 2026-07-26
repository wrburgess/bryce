/**
 * Compact, offline validation for the Reviewer Evidence block required by the
 * lifecycle. This deliberately does not fetch lifecycle-host artifacts: callers
 * supply the artifact URL and any platform commit attestation they observed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

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

export interface ReviewerEvidenceScope {
  /** GitHub owner/repository, for example `octo-org/bryce`. */
  repository?: string;
  /** Pull request number whose comment is the evidence artifact. */
  prNumber?: number;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "pending";
}

function validArtifactUrl(value: string | undefined, scope: ReviewerEvidenceScope = {}): value is string {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return false;
    const path = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
    const comment = url.hash.match(/^#issuecomment-(\d+)$/);
    if (path === null || comment === null) return false;
    if (scope.repository !== undefined && `${path[1]}/${path[2]}` !== scope.repository) return false;
    if (scope.prNumber !== undefined && Number(path[3]) !== scope.prNumber) return false;
    return true;
  } catch {
    return false;
  }
}

/** Fail closed unless every durable evidence field is present and covers `headSha`. */
export function validateReviewerEvidence(
  input: ReviewerEvidenceInput,
  headSha: string,
  scope: ReviewerEvidenceScope = {},
): ReviewerEvidenceResult {
  if (!nonEmpty(input.requestMarker)) return { valid: false, reason: "missing requestMarker" };
  if (!nonEmpty(input.reviewedSha)) return { valid: false, reason: "missing reviewedSha" };
  if (!nonEmpty(input.baseline)) return { valid: false, reason: "missing baseline" };
  if (!nonEmpty(input.reviewer)) return { valid: false, reason: "missing reviewer" };
  if (!nonEmpty(input.reviewerModel)) return { valid: false, reason: "missing reviewerModel" };
  if (!nonEmpty(input.disposition)) return { valid: false, reason: "missing disposition" };
  if (!nonEmpty(input.artifactUrl)) return { valid: false, reason: "missing artifactUrl" };
  if (input.disposition !== "ok") return { valid: false, reason: "disposition is not ok" };
  if (!validArtifactUrl(input.artifactUrl, scope)) return { valid: false, reason: "invalid artifact URL" };
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
  if (!input.requestCreated) return "unreachable";
  if (!input.responseReceived) return "timed-out";
  if (!validArtifactUrl(input.artifactUrl)) return "unreachable";
  if (!nonEmpty(input.commitId) || input.commitId !== input.reviewedSha) return "unattested";
  return "ok";
}

const EVIDENCE_BLOCK = /<!--\s*reviewer-evidence\s*\n([\s\S]*?)-->/;
const EVIDENCE_FIELDS: Readonly<Record<string, keyof ReviewerEvidenceInput>> = {
  "request-marker": "requestMarker",
  "reviewed-sha": "reviewedSha",
  baseline: "baseline",
  reviewer: "reviewer",
  "reviewer-model": "reviewerModel",
  disposition: "disposition",
  "artifact-url": "artifactUrl",
};

/** Parse the machine-locatable comment block that `verify` posts to a PR. */
export function parseReviewerEvidenceBlock(markdown: string): ReviewerEvidenceInput | null {
  const body = markdown.match(EVIDENCE_BLOCK)?.[1];
  if (body === undefined) return null;

  const evidence: ReviewerEvidenceInput = {};
  for (const line of body.split("\n")) {
    const field = line.match(/^([a-z-]+):\s*(.*?)\s*$/);
    if (field === null) continue;
    const fieldName = field[1];
    const value = field[2];
    if (fieldName === undefined || value === undefined) continue;
    const key = EVIDENCE_FIELDS[fieldName];
    if (key !== undefined) evidence[key] = value;
  }
  return evidence;
}

function usage(): string {
  return "usage: reviewer-evidence.ts --evidence FILE --head SHA --repo OWNER/REPO --pr NUMBER";
}

function cli(args: string[]): number {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !["--evidence", "--head", "--repo", "--pr"].includes(flag)) {
      console.error(usage());
      return 1;
    }
    options.set(flag, value);
  }

  const evidenceFile = options.get("--evidence");
  const headSha = options.get("--head");
  const repository = options.get("--repo");
  const prText = options.get("--pr");
  const prNumber = prText === undefined ? NaN : Number(prText);
  if (options.size !== 4 || evidenceFile === undefined || headSha === undefined || repository === undefined
    || !/^[-.\w]+\/[-.\w]+$/.test(repository) || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    console.error(usage());
    return 1;
  }

  let markdown: string;
  try {
    markdown = readFileSync(evidenceFile, "utf8");
  } catch {
    console.error(`reviewer-evidence: cannot read ${evidenceFile}`);
    return 1;
  }
  const evidence = parseReviewerEvidenceBlock(markdown);
  const result = evidence === null
    ? { valid: false as const, reason: "missing Reviewer Evidence block" }
    : validateReviewerEvidence(evidence, headSha, { repository, prNumber });
  if (!result.valid) {
    console.error(`reviewer-evidence: invalid: ${result.reason}`);
    return 1;
  }
  console.log("reviewer-evidence: valid");
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = cli(process.argv.slice(2));
}
