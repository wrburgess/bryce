import type { MailMessage, Mailer } from "./types.js";

/** Development/test mailer: writes the message to stdout instead of sending. */
export class ConsoleMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
    this.write = write;
  }

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    this.write(`mail to=${message.to} from=${message.from} subject=${message.subject}`);
    this.write(message.text);
  }
}
