import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves an optional dependency from the project first (where users install it),
 * then from pdd itself. Returns the entry file, or undefined when it is not installed.
 */
export function resolvePackage(root: string, name: string): string | undefined {
  for (const from of [path.join(root, "package.json"), fileURLToPath(import.meta.url)]) {
    try {
      return createRequire(from).resolve(name);
    } catch {
      // try the next location
    }
  }
  return undefined;
}
