import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { analyzeCoverage, type CoverageReport } from "../src/coverage/analyze.js";

let dir: string;

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true },
    include: ["src", "laws"],
  }),
  "src/a.ts": `
export function f(x: number): number { return g(x) + 1; }
function g(x: number): number { return helper(x); }
export function helper(x: number): number { return x * 2; }
export const k = (s: string): string => s.trim();
export function unused(): number { return 0; }
export class Thing {}
export type T = { a: number };
export interface I { b: string }
export const VALUE = 3;
`,
  "src/b.ts": `export default function named(): void {}\n`,
  "src/index.ts": `export { f } from "./a.js";\nexport * from "./b.js";\n`,
  "src/a.test.ts": `export function testHelper(): void {}\n`,
  "laws/a.laws.ts": `import { f } from "../src/index.js";\nexport const check = (): boolean => f(1) === 3;\n`,
  "laws/arbitraries.ts": `import * as a from "../src/a.js";\nexport const gen = a.k;\n`,
};

async function analyze(extra = "{}"): Promise<CoverageReport> {
  return analyzeCoverage(parseConfig(dir, extra));
}

const names = (list: Array<{ name: string }>): string[] => list.map((e) => e.name);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pdd-coverage-"));
  for (const [rel, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("law coverage", () => {
  test("sorts exported functions into covered, indirect and uncovered", async () => {
    const r = await analyze();
    expect(names(r.covered)).toEqual(["f", "k"]);
    expect(r.indirect).toMatchObject([{ name: "helper", via: "f" }]);
    expect(names(r.uncovered)).toEqual(["unused", "Thing", "named"]);
    expect(r.uncovered.find((e) => e.name === "Thing")?.kind).toBe("class");
  });

  test("skips types, plain values and test files, and dedupes re-exports", async () => {
    const r = await analyze();
    const all = [...r.covered, ...r.indirect, ...r.uncovered];
    expect(names(all)).not.toContain("T");
    expect(names(all)).not.toContain("VALUE");
    expect(names(all)).not.toContain("testHelper");
    expect(all.filter((e) => e.name === "f")).toHaveLength(1);
    expect(r.covered[0]).toMatchObject({ file: "src/a.ts", line: 2 });
  });

  test("coverage.ignore leaves files out", async () => {
    const r = await analyze(`{"coverage": {"ignore": ["src/b.ts"]}}`);
    expect(names(r.uncovered)).toEqual(["unused", "Thing"]);
  });
});
