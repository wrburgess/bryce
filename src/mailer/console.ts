import type { MailContext, MailMessage, MailReceipt, Mailer } from "./types.js";

/** Development/test mailer: writes the message to stdout instead of sending. */
export class ConsoleMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  readonly contexts: Array<MailContext | undefined> = [];
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
    this.write = write;
  }

  async send(message: MailMessage, context?: MailContext): Promise<MailReceipt> {
    this.sent.push(message);
    this.contexts.push(context);
    this.write(`mail to=${message.to} from=${message.from} subject=${message.subject}`);
    this.write(message.text);
    // No provider, so no provider id — the receipt shape still holds.
    return { providerMessageId: null };
  }
}
