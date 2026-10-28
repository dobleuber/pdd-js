import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TAMPERING_MARKER } from "../src/mutate/constants.js";
import { summarizeMutants } from "../src/mutate/report.js";
import type { StrykerMutantResult } from "../src/mutate/run.js";

let dir: string;

const SOURCE = `export function add(a: number, b: number): number {
  return a + b;
}
export const sub = (a: number, b: number): number => a - b;
`;

function mutant(id: string, status: string, start: [number, number], end: [number, number], extra: Partial<StrykerMutantResult> = {}): StrykerMutantResult {
  return {
    id,
    fileName: path.join(dir, "src", "math.ts"),
    mutatorName: "ArithmeticOperator",
    replacement: "a * b",
    status,
    location: { start: { line: start[0], column: start[1] }, end: { line: end[0], column: end[1] } },
    ...extra,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pdd-mutate-report-"));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "math.ts"), SOURCE);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("mutation summary", () => {
  test("scores like Stryker and lists the survivors with their function", () => {
    const s = summarizeMutants(dir, [
      mutant("1", "Killed", [2, 10], [2, 15]),
      mutant("2", "Survived", [2, 10], [2, 15], { replacement: "a - b" }),
      mutant("3", "NoCoverage", [4, 54], [4, 59], { replacement: "a + b" }),
      mutant("4", "Timeout", [2, 10], [2, 15]),
      mutant("5", "CompileError", [2, 10], [2, 15]),
    ]);
    expect(s.score).toBe(50);
    expect(s.counts).toEqual({ total: 5, killed: 1, timeout: 1, survived: 1, noCoverage: 1, discarded: 1 });
    expect(s.survivors).toEqual([
      { status: "Survived", file: "src/math.ts", line: 2, col: 10, mutator: "ArithmeticOperator", original: "a + b", replacement: "a - b", function: "add" },
      { status: "NoCoverage", file: "src/math.ts", line: 4, col: 54, mutator: "ArithmeticOperator", original: "a - b", replacement: "a + b", function: "sub" },
    ]);
    expect(s.tampering).toEqual([]);
  });

  test("tampering under a mutant is reported, not scored", () => {
    const s = summarizeMutants(dir, [
      mutant("1", "Killed", [2, 10], [2, 15]),
      mutant("2", "RuntimeError", [2, 10], [2, 15], { statusReason: `${TAMPERING_MARKER} laws/x.laws.ts: the law process exited early` }),
    ]);
    expect(s.score).toBe(100);
    expect(s.tampering).toEqual([{ file: "src/math.ts", line: 2, mutator: "ArithmeticOperator", reason: "laws/x.laws.ts: the law process exited early" }]);
  });

  test("no valid mutants means no score", () => {
    expect(summarizeMutants(dir, []).score).toBeNull();
  });
});
