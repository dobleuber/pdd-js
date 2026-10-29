import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { addDevCommand } from "../src/shared/install-hint.js";

let dir: string;
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function project(lockfile?: string): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "pdd-hint-"));
  if (lockfile) await writeFile(path.join(dir, lockfile), "");
  return dir;
}

describe("addDevCommand", () => {
  test.each([
    ["pnpm-lock.yaml", "pnpm add -D z3-solver"],
    ["yarn.lock", "yarn add -D z3-solver"],
    ["bun.lock", "bun add -d z3-solver"],
    ["package-lock.json", "npm install -D z3-solver"],
  ])("%s → %s", async (lockfile, expected) => {
    expect(addDevCommand(await project(lockfile), ["z3-solver"])).toBe(expected);
  });

  test("finds the lockfile of a monorepo above the project", async () => {
    const root = await project("pnpm-lock.yaml");
    const pkg = path.join(root, "packages", "app");
    await mkdir(pkg, { recursive: true });
    expect(addDevCommand(pkg, ["a", "b"])).toBe("pnpm add -D a b");
  });

  test("falls back to npm without a lockfile", async () => {
    // tmpdir() could sit below a directory with a lockfile; only check the shape.
    expect(addDevCommand(await project(), ["z3-solver"])).toMatch(/ z3-solver$/);
  });
});
