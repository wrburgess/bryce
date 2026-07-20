import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { ConsoleMailer } from "../src/mailer/console.js";
import { createMailer } from "../src/mailer/index.js";
import { PostmarkMailer } from "../src/mailer/postmark.js";
import { SmtpMailer } from "../src/mailer/smtp.js";

const baseConfig: Config = {
  databasePath: ":memory:",
  tz: "America/Chicago",
  mailerProvider: "console",
  postmarkServerToken: null,
  smtpHost: null,
  smtpPort: 465,
  smtpUser: null,
  smtpPass: null,
  digestTo: "hc@example.com",
  digestFrom: "bryce@example.com",
  ncaaScrapeDelayMs: 3000,
  mlbApiDelayMs: 0,
  serverPort: 3000,
  apiToken: null,
};

const message = {
  to: "hc@example.com",
  from: "bryce@example.com",
  subject: "Bryce digest - 2026-07-19",
  html: "<p>2-4, HR</p>",
  text: "2-4, HR\n",
};

describe("createMailer provider selection", () => {
  it("selects Postmark when configured", () => {
    const mailer = createMailer({
      ...baseConfig,
      mailerProvider: "postmark",
      postmarkServerToken: "pm-token",
    });
    expect(mailer).toBeInstanceOf(PostmarkMailer);
  });

  it("selects SMTP when configured", () => {
    const mailer = createMailer(
      { ...baseConfig, mailerProvider: "smtp", smtpHost: "smtp.example.com", smtpUser: "u", smtpPass: "p" },
      { smtpTransportFactory: () => ({ sendMail: () => Promise.resolve({}) }) },
    );
    expect(mailer).toBeInstanceOf(SmtpMailer);
  });

  it("selects the console mailer when configured", () => {
    expect(createMailer(baseConfig)).toBeInstanceOf(ConsoleMailer);
  });

  it("fails closed when postmark is selected without a token", () => {
    expect(() => createMailer({ ...baseConfig, mailerProvider: "postmark" })).toThrow(
      /POSTMARK_SERVER_TOKEN/,
    );
  });
});

describe("PostmarkMailer", () => {
  it("POSTs the exact Postmark request shape with the server-token header", async () => {
    const captured: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const mailer = new PostmarkMailer("pm-token", (url, init) => {
      captured.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
    });
    await mailer.send(message);

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe("https://api.postmarkapp.com/email");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers["X-Postmark-Server-Token"]).toBe("pm-token");
    expect(call?.init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      From: "bryce@example.com",
      To: "hc@example.com",
      Subject: "Bryce digest - 2026-07-19",
      HtmlBody: "<p>2-4, HR</p>",
      TextBody: "2-4, HR\n",
    });
  });

  it("throws with the HTTP status and detail on a non-2xx response", async () => {
    const mailer = new PostmarkMailer("pm-token", () =>
      Promise.resolve({ ok: false, status: 422, text: () => Promise.resolve('{"Message":"bad from"}') }),
    );
    await expect(mailer.send(message)).rejects.toThrow(/422.*bad from/);
  });
});

describe("SmtpMailer", () => {
  it("sends through the transport with all four content fields", async () => {
    const sent: unknown[] = [];
    const mailer = new SmtpMailer(
      { host: "smtp.example.com", port: 465, user: "u", pass: "p" },
      (options) => {
        expect(options.host).toBe("smtp.example.com");
        return {
          sendMail: (mail: unknown) => {
            sent.push(mail);
            return Promise.resolve({});
          },
        };
      },
    );
    await mailer.send(message);
    expect(sent[0]).toMatchObject({
      from: "bryce@example.com",
      to: "hc@example.com",
      subject: "Bryce digest - 2026-07-19",
      html: "<p>2-4, HR</p>",
      text: "2-4, HR\n",
    });
  });

  it("propagates a provider error", async () => {
    const mailer = new SmtpMailer({ host: "smtp.example.com", port: 465, user: "u", pass: "p" }, () => ({
      sendMail: () => Promise.reject(new Error("connection refused")),
    }));
    await expect(mailer.send(message)).rejects.toThrow("connection refused");
  });
});

describe("ConsoleMailer", () => {
  it("records and prints the message instead of sending", async () => {
    const lines: string[] = [];
    const mailer = new ConsoleMailer((line) => lines.push(line));
    await mailer.send(message);
    expect(mailer.sent).toHaveLength(1);
    expect(lines[0]).toBe("mail to=hc@example.com from=bryce@example.com subject=Bryce digest - 2026-07-19");
    expect(lines[1]).toContain("2-4, HR");
  });
});

describe("loadConfig fail-closed validation (rules/security.md)", () => {
  const minimal = { MAILER_PROVIDER: "console" };

  it("loads defaults with the console provider", () => {
    const config = loadConfig(minimal);
    expect(config.mailerProvider).toBe("console");
    expect(config.tz).toBe("America/Chicago");
    expect(config.mlbApiDelayMs).toBe(500);
    expect(config.databasePath).toBe("data/bryce.db");
  });

  it("defaults to the postmark provider and then requires its token", () => {
    expect(() => loadConfig({})).toThrow(ZodError);
    expect(() => loadConfig({ POSTMARK_SERVER_TOKEN: "t", DIGEST_TO: "a@b.c", DIGEST_FROM: "d@e.f" })).not.toThrow();
  });

  it("rejects a whitespace-only token (presence is not a real value)", () => {
    expect(() =>
      loadConfig({ POSTMARK_SERVER_TOKEN: "   ", DIGEST_TO: "a@b.c", DIGEST_FROM: "d@e.f" }),
    ).toThrow(ZodError);
  });

  it("requires SMTP credentials and digest addresses for the smtp provider", () => {
    expect(() => loadConfig({ MAILER_PROVIDER: "smtp" })).toThrow(ZodError);
    expect(() =>
      loadConfig({
        MAILER_PROVIDER: "smtp",
        SMTP_HOST: "smtp.example.com",
        SMTP_USER: "u",
        SMTP_PASS: "p",
        DIGEST_TO: "a@b.c",
        DIGEST_FROM: "d@e.f",
      }),
    ).not.toThrow();
  });

  it("rejects an unknown provider", () => {
    expect(() => loadConfig({ MAILER_PROVIDER: "carrier-pigeon" })).toThrow(ZodError);
  });
});
