import type { MailContext, MailMessage, MailReceipt, Mailer } from "./types.js";

const POSTMARK_URL = "https://api.postmarkapp.com/email";

export type PostmarkFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Postmark via its plain HTTP API — no SDK dependency needed; the server token
 * comes from the environment (rules/security.md) and is only ever sent as the
 * X-Postmark-Server-Token header.
 */
export class PostmarkMailer implements Mailer {
  private readonly token: string;
  private readonly fetchImpl: PostmarkFetch;

  constructor(token: string, fetchImpl: PostmarkFetch = (url, init) => fetch(url, init)) {
    this.token = token;
    this.fetchImpl = fetchImpl;
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
