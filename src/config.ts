import { z } from "zod";

/**
 * Environment configuration, Zod-validated at the boundary (rules/security.md:
 * secrets from env only, fail closed, normalize input before guarding on it).
 */

const EnvSchema = z
  .object({
    DATABASE_PATH: z.string().trim().min(1).default("data/bryce.db"),
    /**
     * Host timezone for "today" — digest windows and season boundaries.
     *
     * Deliberately NOT named `TZ`. `TZ` is a reserved POSIX variable that
     * terminals, editors and CI set on their own, and `loadDotEnv` never
     * overrides a real environment variable (src/env.ts) — so a `.env` saying
     * `TZ=America/Chicago` silently loses to an ambient `TZ=UTC` and every host
     * date shifts. Observed in production 2026-07-20: an evening run recorded a
     * delivery for tomorrow's date. An app-scoped key nothing else sets is the
     * fix; the "real env wins" rule is correct and unchanged.
     */
    BRYCE_TZ: z.string().trim().min(1).default("America/Chicago"),
    /** Directory holding local Snapshots (whole-DB point-in-time copies). */
    BACKUP_DIR: z.string().trim().min(1).default("backups"),
    /**
     * How many newest Snapshots retention keeps. A positive integer: <1, a
     * fraction, or a non-number is a config error (fail closed, never silently
     * default), so a mis-set value can never widen retention to "keep zero" and
     * delete every Snapshot.
     */
    BACKUP_KEEP_LAST: z.coerce.number().int().positive().default(10),
    MAILER_PROVIDER: z.enum(["postmark", "smtp", "console"]).default("postmark"),
    POSTMARK_SERVER_TOKEN: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    DIGEST_TO: z.string().optional(),
    DIGEST_FROM: z.string().optional(),
    MLB_API_DELAY_MS: z.coerce.number().int().nonnegative().default(500),
    NCAA_SCRAPE_DELAY_MS: z.coerce.number().int().nonnegative().default(3000),
    SERVER_PORT: z.coerce.number().int().positive().default(3000),
    /** Bearer token guarding /api and /mcp; whitespace-only is treated as absent. */
    API_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Fail closed: a provider that cannot actually send is a config error, not a
    // runtime surprise. Whitespace-only values are treated as absent.
    const has = (v: string | undefined): v is string => v !== undefined && v.trim().length > 0;
    if (env.MAILER_PROVIDER === "postmark" && !has(env.POSTMARK_SERVER_TOKEN)) {
      ctx.addIssue({
        code: "custom",
        path: ["POSTMARK_SERVER_TOKEN"],
        message: "POSTMARK_SERVER_TOKEN is required when MAILER_PROVIDER=postmark",
      });
    }
    if (env.MAILER_PROVIDER === "smtp") {
      for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"] as const) {
        if (!has(env[key])) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when MAILER_PROVIDER=smtp`,
          });
        }
      }
    }
    if (env.MAILER_PROVIDER !== "console") {
      for (const key of ["DIGEST_TO", "DIGEST_FROM"] as const) {
        if (!has(env[key])) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when MAILER_PROVIDER=${env.MAILER_PROVIDER}`,
          });
        }
      }
    }
  });

export interface Config {
  databasePath: string;
  tz: string;
  backupDir: string;
  backupKeepLast: number;
  mailerProvider: "postmark" | "smtp" | "console";
  postmarkServerToken: string | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpUser: string | null;
  smtpPass: string | null;
  digestTo: string | null;
  digestFrom: string | null;
  mlbApiDelayMs: number;
  ncaaScrapeDelayMs: number;
  serverPort: number;
  apiToken: string | null;
}

const clean = (v: string | undefined): string | null => {
  if (v === undefined) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): Config {
  const parsed = EnvSchema.parse(env);

  // A .env written before the rename still says TZ=..., which is now inert.
  // Silence there would mean wrong windows with no signal, so say so once.
  if (env.BRYCE_TZ === undefined && typeof env.TZ === "string" && env.TZ.trim().length > 0) {
    warn(
      `config: TZ=${env.TZ.trim()} is ignored — set BRYCE_TZ instead ` +
        `(using ${parsed.BRYCE_TZ}). TZ is a reserved variable ambient tooling sets.`,
    );
  }

  return {
    databasePath: parsed.DATABASE_PATH,
    tz: parsed.BRYCE_TZ,
    backupDir: parsed.BACKUP_DIR,
    backupKeepLast: parsed.BACKUP_KEEP_LAST,
    mailerProvider: parsed.MAILER_PROVIDER,
    postmarkServerToken: clean(parsed.POSTMARK_SERVER_TOKEN),
    smtpHost: clean(parsed.SMTP_HOST),
    smtpPort: parsed.SMTP_PORT,
    smtpUser: clean(parsed.SMTP_USER),
    smtpPass: clean(parsed.SMTP_PASS),
    digestTo: clean(parsed.DIGEST_TO),
    digestFrom: clean(parsed.DIGEST_FROM),
    mlbApiDelayMs: parsed.MLB_API_DELAY_MS,
    ncaaScrapeDelayMs: parsed.NCAA_SCRAPE_DELAY_MS,
    serverPort: parsed.SERVER_PORT,
    apiToken: clean(parsed.API_TOKEN),
  };
}
