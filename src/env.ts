import { existsSync } from "node:fs";

/**
 * Load a .env file into process.env if one exists, via Node's native loader.
 * Real environment variables always win; the file only fills in gaps
 * (rules/security.md: secrets stay out of the repo, config is env-only).
 */
export function loadDotEnv(path = ".env"): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
