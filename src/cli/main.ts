import { pathToFileURL } from "node:url";

/** True when `moduleUrl` is the script Node was launched with (vs. an import). */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return moduleUrl === pathToFileURL(entry).href;
}
