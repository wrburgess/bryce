import type { MailMessage, Mailer } from "./types.js";

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

  async send(message: MailMessage): Promise<void> {
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
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Postmark send failed with HTTP ${res.status}: ${detail}`);
    }
  }
}
