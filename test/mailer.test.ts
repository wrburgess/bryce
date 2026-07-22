import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { ConsoleMailer } from "../src/mailer/console.js";
import { createMailer } from "../src/mailer/index.js";
import type { PostmarkFetch, PostmarkLookupFetch } from "../src/mailer/postmark.js";
import { LOOKUP_TIMEOUT_MS, PostmarkMailer } from "../src/mailer/postmark.js";
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
  subject: "MLB Daily Tracker - Sun, July 19, 2026",
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
      Subject: "MLB Daily Tracker - Sun, July 19, 2026",
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

  it("carries the delivery key as Metadata and returns Postmark's MessageID", async () => {
    const bodies: string[] = [];
    const mailer = new PostmarkMailer("pm-token", (_url, init) => {
      bodies.push(init.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ To: "hc@example.com", MessageID: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817", ErrorCode: 0 }),
          ),
      });
    });

    const receipt = await mailer.send(message, { deliveryKey: "bryce:digest:2026-07-19" });
    // The slot key rides on the message, so a future reconciliation can ask
    // Postmark whether THIS slot ever landed (ADR 0034).
    const body = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(body.Metadata).toEqual({ deliveryKey: "bryce:digest:2026-07-19" });
    expect(receipt.providerMessageId).toBe("b7bc2f4a-e38e-4336-af7d-e6c392c2f817");
  });

  it("sends no Metadata without a context, and reports a null id for an unparseable body", async () => {
    const bodies: string[] = [];
    const mailer = new PostmarkMailer("pm-token", (_url, init) => {
      bodies.push(init.body);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("not json") });
    });

    const receipt = await mailer.send(message);
    expect(JSON.parse(bodies[0] ?? "{}")).not.toHaveProperty("Metadata");
    // A provider that answers with something unexpected yields no id — never a
    // thrown send, and never a fabricated id on the delivery row.
    expect(receipt.providerMessageId).toBeNull();
  });
});

/**
 * The reconciliation lookup (ADR 0034 amendment, issue #41). Every test here is
 * really one assertion in two directions: `accepted` is the ONLY answer that may
 * suppress a resend, and every other way the lookup can end — a miss, an HTTP
 * error, a body we cannot read, a rejected request, a timeout — must resolve to
 * "we do not know", which re-sends. A wrong `accepted` is silent mail loss,
 * strictly worse than the duplicate this lookup exists to avoid, so the failure
 * modes are written out one by one rather than collapsed into a single case.
 */
describe("PostmarkMailer reconciliation lookup (fail-open)", () => {
  /** A send seam that must never fire: these tests only ever look messages up. */
  const noSend: PostmarkFetch = () => Promise.reject(new Error("send must not run in a lookup test"));

  function respondWith(body: string, init: { ok?: boolean; status?: number } = {}): PostmarkLookupFetch {
    return () =>
      Promise.resolve({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        text: () => Promise.resolve(body),
      });
  }

  function lookupMailer(lookupFetch: PostmarkLookupFetch, lookupTimeoutMs?: number): PostmarkMailer {
    return new PostmarkMailer("pm-token", noSend, {
      lookupFetch,
      ...(lookupTimeoutMs !== undefined ? { lookupTimeoutMs } : {}),
    });
  }

  function found(status: string, messageId = "pm-found-1"): string {
    return JSON.stringify({ TotalCount: 1, Messages: [{ MessageID: messageId, Status: status }] });
  }

  const EMPTY = JSON.stringify({ TotalCount: 0, Messages: [] });

  it("GETs the metadata-filtered search with the token header, a date bound, and no body", async () => {
    const calls: Array<{
      url: string;
      init: { method: string; headers: Record<string, string>; signal?: AbortSignal };
    }> = [];
    const mailer = lookupMailer((url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(EMPTY) });
    });

    await mailer.findAccepted("bryce:digest:2026-07-19", "2026-07-19T17:00:00.000Z");

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.init.method).toBe("GET");
    expect(call?.init.headers["X-Postmark-Server-Token"]).toBe("pm-token");
    // A GET carries no body — the whole query rides on the URL.
    expect(call?.init).not.toHaveProperty("body");
    const url = new URL(call?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://api.postmarkapp.com/messages/outbound");
    // Postmark filters on ONE metadata field at a time, which is exactly what
    // the stable per-slot delivery key needs.
    expect(url.searchParams.get("metadata_deliveryKey")).toBe("bryce:digest:2026-07-19");
    // The crashed attempt's claim time, truncated to its UTC day — Postmark
    // documents fromdate as a date, and truncating only widens the window.
    expect(url.searchParams.get("fromdate")).toBe("2026-07-19");
    expect(url.searchParams.get("count")).toBe("1");
    expect(url.searchParams.get("offset")).toBe("0");
  });

  it("omits the date bound entirely when the crashed attempt carried no claim stamp", async () => {
    const urls: string[] = [];
    const mailer = lookupMailer((url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(EMPTY) });
    });

    await mailer.findAccepted("bryce:digest:2026-07-19", null);

    // An unbounded search is still exact (the delivery key is the filter); a
    // FABRICATED bound would not be, and could hide a real acceptance.
    expect(new URL(urls[0] ?? "").searchParams.has("fromdate")).toBe(false);
  });

  it("reports accepted with the provider id for a Sent message", async () => {
    const mailer = lookupMailer(respondWith(found("Sent", "b7bc2f4a-e38e-4336-af7d-e6c392c2f817")));
    expect(await mailer.findAccepted("bryce:digest:2026-07-19", null)).toEqual({
      outcome: "accepted",
      providerMessageId: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
    });
  });

  it("reports accepted for a QUEUED message: Postmark has taken responsibility", async () => {
    // Queued means the mail has not gone out yet but Postmark will send it.
    // Re-sending on Queued would duplicate — this is why the outcome is named
    // `accepted` and not `delivered`.
    const mailer = lookupMailer(respondWith(found("Queued", "pm-queued-1")));
    expect(await mailer.findAccepted("bryce:digest:2026-07-19", null)).toEqual({
      outcome: "accepted",
      providerMessageId: "pm-queued-1",
    });
    const processed = lookupMailer(respondWith(found("Processed", "pm-processed-1")));
    expect(await processed.findAccepted("bryce:digest:2026-07-19", null)).toEqual({
      outcome: "accepted",
      providerMessageId: "pm-processed-1",
    });
  });

  it("reports not-found when the search matches nothing", async () => {
    const mailer = lookupMailer(respondWith(EMPTY));
    expect(await mailer.findAccepted("bryce:digest:2026-07-19", null)).toEqual({
      outcome: "not-found",
    });
  });

  it("never reports accepted for a message the provider did not accept", async () => {
    // A bounce is a message that exists and did NOT land: the slot is
    // unconfirmed, so it must re-send.
    const mailer = lookupMailer(respondWith(found("Bounced")));
    expect(await mailer.findAccepted("bryce:digest:2026-07-19", null)).toEqual({
      outcome: "not-found",
    });
  });

  it("reports unavailable, carrying the status, on an HTTP error", async () => {
    const mailer = lookupMailer(respondWith('{"Message":"server error"}', { ok: false, status: 500 }));
    const result = await mailer.findAccepted("bryce:digest:2026-07-19", null);
    expect(result.outcome).toBe("unavailable");
    expect(result.outcome === "unavailable" && result.detail).toContain("500");
  });

  it("reports unavailable — never a false not-found — for an unreadable body", async () => {
    // The distinction is the point: both re-send today, but `not-found` reads as
    // "Postmark says it never arrived" when the truth is "we could not read the
    // answer". Narrowing this to not-found is how a future change would start
    // trusting garbage.
    const mailer = lookupMailer(respondWith("not json"));
    expect((await mailer.findAccepted("bryce:digest:2026-07-19", null)).outcome).toBe("unavailable");

    const noMessages = lookupMailer(respondWith(JSON.stringify({ TotalCount: 1 })));
    expect((await noMessages.findAccepted("bryce:digest:2026-07-19", null)).outcome).toBe(
      "unavailable",
    );
  });

  it("reports unavailable when the request itself is rejected", async () => {
    const mailer = lookupMailer(() => Promise.reject(new Error("ENOTFOUND api.postmarkapp.com")));
    const result = await mailer.findAccepted("bryce:digest:2026-07-19", null);
    expect(result.outcome).toBe("unavailable");
    expect(result.outcome === "unavailable" && result.detail).toContain("ENOTFOUND");
  });

  it("reports unavailable and aborts the request when the lookup exceeds its timeout", async () => {
    // A recovery run that HANGS on the provider is worse than the duplicate it
    // is avoiding. Timeout 0 against a never-settling request makes the race
    // deterministic — no wall-clock sleep (rules/testing.md).
    let signal: AbortSignal | undefined;
    const mailer = lookupMailer((_url, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    }, 0);

    const result = await mailer.findAccepted("bryce:digest:2026-07-19", null);
    expect(result.outcome).toBe("unavailable");
    expect(result.outcome === "unavailable" && result.detail).toContain("timed out");
    // The hung request is cancelled, not left dangling behind the answer.
    expect(signal?.aborted).toBe(true);
    // The shipped bound is five seconds (ADR 0034 amendment).
    expect(LOOKUP_TIMEOUT_MS).toBe(5000);
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
      subject: "MLB Daily Tracker - Sun, July 19, 2026",
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

  it("returns nodemailer's messageId and rides the delivery key as a header", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const mailer = new SmtpMailer({ host: "smtp.example.com", port: 465, user: "u", pass: "p" }, () => ({
      sendMail: (mail: unknown) => {
        sent.push(mail as Record<string, unknown>);
        return Promise.resolve({ messageId: "<abc@smtp.example.com>" });
      },
    }));

    const receipt = await mailer.send(message, { deliveryKey: "bryce:heartbeat:2026-12-05" });
    expect(receipt.providerMessageId).toBe("<abc@smtp.example.com>");
    expect(sent[0]?.headers).toEqual({ "X-Bryce-Delivery-Key": "bryce:heartbeat:2026-12-05" });
  });

  it("reports a null id when the transport returns no messageId", async () => {
    const mailer = new SmtpMailer({ host: "smtp.example.com", port: 465, user: "u", pass: "p" }, () => ({
      sendMail: () => Promise.resolve({}),
    }));
    expect(await mailer.send(message)).toEqual({ providerMessageId: null });
  });
});

describe("ConsoleMailer", () => {
  it("records and prints the message instead of sending", async () => {
    const lines: string[] = [];
    const mailer = new ConsoleMailer((line) => lines.push(line));
    await mailer.send(message);
    expect(mailer.sent).toHaveLength(1);
    expect(lines[0]).toBe("mail to=hc@example.com from=bryce@example.com subject=MLB Daily Tracker - Sun, July 19, 2026");
    expect(lines[1]).toContain("2-4, HR");
  });

  it("captures the delivery context and returns a null-id receipt", async () => {
    const mailer = new ConsoleMailer(() => undefined);
    // The receipt contract holds for EVERY provider, including one with no
    // provider at all — the caller never has to special-case a mailer.
    const receipt = await mailer.send(message, { deliveryKey: "bryce:digest:2026-07-19" });
    expect(receipt).toEqual({ providerMessageId: null });
    expect(mailer.contexts[0]).toEqual({ deliveryKey: "bryce:digest:2026-07-19" });
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
