import type { Config } from "../config.js";
import { ConsoleMailer } from "./console.js";
import type { PostmarkFetch } from "./postmark.js";
import { PostmarkMailer } from "./postmark.js";
import type { TransportFactory } from "./smtp.js";
import { SmtpMailer } from "./smtp.js";
import type { Mailer } from "./types.js";

export interface MailerDeps {
  postmarkFetch?: PostmarkFetch;
  smtpTransportFactory?: TransportFactory;
}

/**
 * Config-driven provider selection (postmark is the configured default).
 * loadConfig has already fail-closed on missing provider credentials, but this
 * factory re-checks so it is safe to call with a hand-built Config too.
 */
export function createMailer(config: Config, deps: MailerDeps = {}): Mailer {
  switch (config.mailerProvider) {
    case "postmark": {
      if (config.postmarkServerToken === null) {
        throw new Error("MAILER_PROVIDER=postmark requires POSTMARK_SERVER_TOKEN");
      }
      return new PostmarkMailer(config.postmarkServerToken, deps.postmarkFetch);
    }
    case "smtp": {
      if (config.smtpHost === null || config.smtpUser === null || config.smtpPass === null) {
        throw new Error("MAILER_PROVIDER=smtp requires SMTP_HOST, SMTP_USER and SMTP_PASS");
      }
      return new SmtpMailer(
        {
          host: config.smtpHost,
          port: config.smtpPort,
          user: config.smtpUser,
          pass: config.smtpPass,
        },
        deps.smtpTransportFactory,
      );
    }
    case "console":
      return new ConsoleMailer();
  }
}
