export interface MailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  /** Deliver one message; MUST throw on failure (the digest job fails closed on it). */
  send(message: MailMessage): Promise<void>;
}
