import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { MailContext, MailMessage, MailReceipt, Mailer } from "./types.js";

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export type TransportFactory = (options: SmtpOptions) => Pick<Transporter, "sendMail">;

const defaultTransportFactory: TransportFactory = (options) =>
  nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.port === 465,
    auth: { user: options.user, pass: options.pass },
  });

/** SMTP via nodemailer — works for Forward Email and any standard SMTP relay. */
export class SmtpMailer implements Mailer {
  private readonly transport: Pick<Transporter, "sendMail">;

  constructor(options: SmtpOptions, transportFactory: TransportFactory = defaultTransportFactory) {
    this.transport = transportFactory(options);
  }

  async send(message: MailMessage, context?: MailContext): Promise<MailReceipt> {
    const info: unknown = await this.transport.sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      // SMTP has no metadata channel, so the slot key rides as a custom header
      // where a relay's logs can still show it (ADR 0034).
      ...(context !== undefined ? { headers: { "X-Bryce-Delivery-Key": context.deliveryKey } } : {}),
    });
    return { providerMessageId: messageIdOf(info) };
  }
}

/** nodemailer's SentMessageInfo.messageId, when the transport supplies one. */
function messageIdOf(info: unknown): string | null {
  if (typeof info !== "object" || info === null) return null;
  const id = (info as Record<string, unknown>).messageId;
  return typeof id === "string" ? id : null;
}
