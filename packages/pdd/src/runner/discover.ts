import fg from "fast-glob";
import type { PddConfig } from "../config/schema.js";

export const LAW_FILE_GLOB = "**/*.laws.{ts,mts,js,mjs}";

export async function discoverLawFiles(config: PddConfig): Promise<string[]> {
  const files = await fg(`${fg.escapePath(config.lawsDir)}/${LAW_FILE_GLOB}`, {
    cwd: config.root,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**"],
  });
  return files.sort();
}
