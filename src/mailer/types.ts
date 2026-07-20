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

/**
 * What a provider lookup can tell us about a delivery key (ADR 0034 amendment).
 *
 * `accepted` — NOT `delivered` — is deliberate. Postmark reports `Queued`,
 * `Processed` and `Sent` for a message it has taken responsibility for, and
 * suppressing our resend is correct for all three. Naming this `delivered`
 * would invite a later "fix" narrowing it to `Sent`, which would reintroduce
 * exactly the duplicate this lookup exists to avoid.
 *
 * `accepted` is the ONLY outcome that may suppress a send. `not-found` and
 * `unavailable` both mean "we do not know", and not knowing always resends —
 * a wrong `accepted` is silent mail loss, which is strictly worse than the
 * duplicate this whole mechanism is trying to avoid.
 */
export type LookupResult =
  | { outcome: "accepted"; providerMessageId: string | null }
  | { outcome: "not-found" }
  | { outcome: "unavailable"; detail: string };

export interface Mailer {
  /** Deliver one message; MUST throw on failure (the digest job fails closed on it). */
  send(message: MailMessage, context?: MailContext): Promise<MailReceipt>;
  /**
   * Ask the provider whether `deliveryKey` already landed, searching from
   * `since` (an ISO instant — the crashed attempt's claim time, which is always
   * at or before its send) or from the beginning when `since` is null (the
   * crashed row carried no claim stamp). A bound is an optimization; the
   * delivery key is what makes the match exact, so "no bound" is always
   * correct and a FABRICATED bound never is — it could hide a real acceptance.
   * OPTIONAL by construction: a provider that cannot
   * answer simply does not implement it and keeps the documented at-least-once
   * behaviour — never a stub that throws.
   *
   * MUST NOT throw: every failure mode is an `unavailable` result, so the
   * caller has one fail-open branch instead of two.
   */
  findAccepted?(deliveryKey: string, since: string | null): Promise<LookupResult>;
}
