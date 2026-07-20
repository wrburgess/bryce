import type { LookupResult, MailContext, MailMessage, MailReceipt, Mailer } from "./types.js";

const POSTMARK_URL = "https://api.postmarkapp.com/email";
/** Postmark's outbound message search — the reconciliation lookup (ADR 0034 amendment). */
const POSTMARK_SEARCH_URL = "https://api.postmarkapp.com/messages/outbound";

/** How long a reconciliation lookup may run before it degrades to "unavailable". */
export const LOOKUP_TIMEOUT_MS = 5000;

/**
 * Statuses that mean Postmark has TAKEN RESPONSIBILITY for the message. `Queued`
 * counts: the mail has not left yet, but Postmark will send it, so re-sending
 * would duplicate. Narrowing this set to `Sent` would reintroduce the duplicate;
 * widening it to a status Postmark never delivers would suppress a real send.
 */
const ACCEPTED_STATUSES = new Set(["Sent", "Processed", "Queued"]);

/** What either injectable seam hands back — the slice of Response we read. */
export interface PostmarkResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

/** The injectable send seam (#25: no test ever reaches the network). A POST with a body. */
export type PostmarkFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<PostmarkResponse>;

/**
 * The injectable LOOKUP seam. Deliberately its own type rather than a widened
 * `PostmarkFetch`: the lookup is a GET carrying no body and an abort signal, and
 * making `body` optional on the shared type would describe a request shape
 * (`GET` with a body) that fetch rejects at runtime. Two honest types beat one
 * loose one.
 */
export type PostmarkLookupFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<PostmarkResponse>;

export interface PostmarkOptions {
  /** Injectable lookup transport; defaults to the platform fetch. */
  lookupFetch?: PostmarkLookupFetch;
  /** Bound on the reconciliation lookup; on expiry the lookup is `unavailable`. */
  lookupTimeoutMs?: number;
}

/**
 * Postmark via its plain HTTP API — no SDK dependency needed; the server token
 * comes from the environment (rules/security.md) and is only ever sent as the
 * X-Postmark-Server-Token header. The same token authorizes the message search
 * used for reconciliation, so that capability adds no new credential.
 */
export class PostmarkMailer implements Mailer {
  private readonly token: string;
  private readonly fetchImpl: PostmarkFetch;
  private readonly lookupFetchImpl: PostmarkLookupFetch;
  private readonly lookupTimeoutMs: number;

  constructor(
    token: string,
    fetchImpl: PostmarkFetch = (url, init) => fetch(url, init),
    options: PostmarkOptions = {},
  ) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.lookupFetchImpl = options.lookupFetch ?? ((url, init) => fetch(url, init));
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  }

  async send(message: MailMessage, context?: MailContext): Promise<MailReceipt> {
    const res = await this.fetchImpl(POSTMARK_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.token,
      },
      body: JSON.stringify({
        From: message.from,
        To: message.to,
        Subject: message.subject,
        HtmlBody: message.html,
        TextBody: message.text,
        MessageStream: "outbound",
        // Postmark echoes Metadata back on the message and in its search API,
        // so the slot key is queryable later (ADR 0034).
        ...(context !== undefined ? { Metadata: { deliveryKey: context.deliveryKey } } : {}),
      }),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`Postmark send failed with HTTP ${res.status}: ${body}`);
    }
    return { providerMessageId: parseMessageId(body) };
  }

  /**
   * Did the mail for `deliveryKey` already reach Postmark? Searches outbound
   * messages by the delivery-key metadata (Postmark filters on a single
   * metadata field, which is exactly what this needs).
   *
   * STRICTLY FAIL-OPEN: only a message Postmark reports as accepted returns
   * `accepted`. A miss, a non-2xx, a body we cannot read, a rejected request and
   * a timeout ALL return an outcome that re-sends. Postmark documents no
   * search-consistency guarantee, so a miss moments after acceptance is
   * expected — and re-sending on it is the whole point.
   */
  async findAccepted(deliveryKey: string, since: string | null): Promise<LookupResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<LookupResult>((resolve) => {
      timer = setTimeout(() => {
        // A recovery run that HANGS on a provider call is a worse failure than
        // the duplicate it is avoiding: abort and re-send.
        controller.abort();
        resolve({
          outcome: "unavailable",
          detail: `Postmark lookup timed out after ${this.lookupTimeoutMs}ms`,
        });
      }, this.lookupTimeoutMs);
    });
    try {
      return await Promise.race([this.searchOnce(deliveryKey, since, controller.signal), expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async searchOnce(
    deliveryKey: string,
    since: string | null,
    signal: AbortSignal,
  ): Promise<LookupResult> {
    let res: PostmarkResponse;
    try {
      res = await this.lookupFetchImpl(searchUrl(deliveryKey, since), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Postmark-Server-Token": this.token,
        },
        signal,
      });
    } catch (err) {
      return {
        outcome: "unavailable",
        detail: `Postmark lookup request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      return { outcome: "unavailable", detail: `Postmark lookup failed with HTTP ${res.status}: ${body}` };
    }
    return classifySearchBody(body);
  }
}

/**
 * The search URL. `fromdate` is bounded by the crashed attempt's claim time,
 * truncated to its UTC DAY because Postmark documents the filter as a date —
 * truncating can only WIDEN the window (the claim always precedes the send), and
 * the delivery-key metadata filter is what makes the match exact. An
 * absent or unparseable bound drops `fromdate` entirely rather than fabricating
 * one: a wider search is still correct, a wrong bound could hide a real
 * acceptance.
 */
function searchUrl(deliveryKey: string, since: string | null): string {
  const params = new URLSearchParams({ metadata_deliveryKey: deliveryKey });
  const sinceMs = since === null ? Number.NaN : Date.parse(since);
  if (Number.isFinite(sinceMs)) {
    params.set("fromdate", new Date(sinceMs).toISOString().slice(0, 10));
  }
  params.set("count", "1");
  params.set("offset", "0");
  return `${POSTMARK_SEARCH_URL}?${params.toString()}`;
}

/**
 * Map a search response onto the lookup's three outcomes. Every parse failure
 * lands on `unavailable`, NEVER on `not-found`: both re-send today, but they are
 * different facts, and a false `not-found` would read as "Postmark says it never
 * arrived" in the logs when the truth is "we could not read the answer".
 */
function classifySearchBody(body: string): LookupResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { outcome: "unavailable", detail: "Postmark lookup returned an unparseable body" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { outcome: "unavailable", detail: "Postmark lookup returned a non-object body" };
  }
  const messages = (parsed as Record<string, unknown>).Messages;
  if (!Array.isArray(messages)) {
    return { outcome: "unavailable", detail: "Postmark lookup returned no Messages array" };
  }
  for (const entry of messages) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.Status === "string" && ACCEPTED_STATUSES.has(record.Status)) {
      return {
        outcome: "accepted",
        providerMessageId: typeof record.MessageID === "string" ? record.MessageID : null,
      };
    }
  }
  // No message, or a message Postmark does not report as accepted (a bounce, a
  // rejection): either way this slot is not confirmed, so it re-sends.
  return { outcome: "not-found" };
}

/** Postmark's accepted-response MessageID; an empty or unparseable body is null. */
function parseMessageId(body: string): string | null {
  if (body === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const id = (parsed as Record<string, unknown>).MessageID;
  return typeof id === "string" ? id : null;
}
