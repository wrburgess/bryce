export interface MailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Per-delivery context handed to the provider alongside the message. The key is
 * stable per (kind, date) slot (`bryce:digest:2026-07-19`) rather than per
 * attempt, so a future reconciliation can ask the provider whether THIS slot
 * ever landed — see ADR 0034. Providers that cannot carry it simply ignore it.
 */
export interface MailContext {
  deliveryKey: string;
}

/**
 * What the provider said on acceptance. `providerMessageId` is null for
 * providers that return no id (the console mailer) — the interface holds for
 * every provider, and the caller stores whatever it gets.
 */
export interface MailReceipt {
  providerMessageId: string | null;
}

export interface Mailer {
  /** Deliver one message; MUST throw on failure (the digest job fails closed on it). */
  send(message: MailMessage, context?: MailContext): Promise<MailReceipt>;
}
