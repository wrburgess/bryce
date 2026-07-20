import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { PostmarkMailer } from "../src/mailer/postmark.js";
import { SmtpMailer } from "../src/mailer/smtp.js";
import { MlbClient } from "../src/mlb/client.js";
import { NcaaClient } from "../src/ncaa/client.js";

const message = {
  to: "hc@example.com",
  from: "bryce@example.com",
  subject: "subject",
  html: "<p>html</p>",
  text: "text",
};

describe("default test-suite network guard", () => {
  it("rejects direct fetch", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(/Network egress is disabled in tests/);
  });

  it("rejects direct http and https requests", () => {
    expect(() => http.get("http://example.com")).toThrow(/Network egress is disabled in tests/);
    expect(() => https.request("https://example.com")).toThrow(/Network egress is disabled in tests/);
  });

  it("rejects raw socket and TLS connections", () => {
    expect(() => net.connect(80, "example.com")).toThrow(/Network egress is disabled in tests/);
    expect(() => tls.connect(443, "example.com")).toThrow(/Network egress is disabled in tests/);
  });

  it("blocks MlbClient default fetch path before egress", async () => {
    const client = new MlbClient({ delayMs: 0 });
    await expect(client.getPerson(691185)).rejects.toThrow(/Network egress is disabled in tests/);
  });

  it("blocks NcaaClient default fetch path before egress", async () => {
    const client = new NcaaClient({ delayMs: 0 });
    await expect(client.getGameLogPage(2649785, "2025", "batting")).rejects.toThrow(
      /Network egress is disabled in tests/,
    );
  });

  it("blocks PostmarkMailer default fetch path before egress", async () => {
    const mailer = new PostmarkMailer("token");
    await expect(mailer.send(message)).rejects.toThrow(/Network egress is disabled in tests/);
  });

  it("blocks SmtpMailer default socket path before egress", async () => {
    const mailer = new SmtpMailer({
      host: "smtp.example.com",
      port: 465,
      user: "user",
      pass: "pass",
    });
    await expect(mailer.send(message)).rejects.toThrow(/Network egress is disabled in tests/);
  });
});
