import { existsSync } from "node:fs";
import path from "node:path";

const LOCKFILES: ReadonlyArray<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm add -D"],
  ["yarn.lock", "yarn add -D"],
  ["bun.lock", "bun add -d"],
  ["bun.lockb", "bun add -d"],
  ["package-lock.json", "npm install -D"],
];

/**
 * The command that adds `specs` as dev dependencies, for the package manager the project
 * uses (found from the nearest lockfile, so it also works inside a monorepo). npm otherwise.
 */
export function addDevCommand(root: string, specs: readonly string[]): string {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const found = LOCKFILES.find(([file]) => existsSync(path.join(dir, file)));
    if (found) return `${found[1]} ${specs.join(" ")}`;
    if (path.dirname(dir) === dir) return `npm install -D ${specs.join(" ")}`;
  }
}
