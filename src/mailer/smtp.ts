import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { MailMessage, Mailer } from "./types.js";

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

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}
