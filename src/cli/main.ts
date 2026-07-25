import { pathToFileURL } from "node:url";

/** True when `moduleUrl` is the script Node was launched with (vs. an import). */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

/** Exit only after both stdio streams accepted all queued diagnostics. */
export async function exitAfterDrain(code: number): Promise<never> {
  process.exitCode = code;
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
  ]);
  process.exit(code);
}
