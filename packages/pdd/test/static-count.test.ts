import { describe, expect, test } from "vitest";
import { scanLawFile } from "../src/runner/static-count.js";

const scan = (src: string) => scanLawFile("x.laws.ts", src);

describe("scanLawFile", () => {
  test("counts top-level laws and their names", () => {
    const r = scan(`import { law, forAll, arb } from "pdd";
law("a", forAll(arb.integer(), () => true));
law(\`b\`, forAll(arb.integer(), () => true));`);
    expect(r).toEqual({ count: 2, names: ["a", "b"], violations: [] });
  });

  test("supports aliased and namespace imports", () => {
    const r = scan(`import { law as L } from "pdd"; import * as P from "pdd";
L("a", x); P.law("b", y);`);
    expect(r.count).toBe(2);
    expect(r.violations).toEqual([]);
  });

  test("flags laws hidden behind a condition", () => {
    const r = scan(`import { law } from "pdd";
if (process.env.CI) law("hidden", x);
law("visible", y);`);
    expect(r.count).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.message).toMatch(/top-level statement/);
    expect(r.violations[0]?.line).toBe(2);
  });

  test("flags laws inside functions and loops", () => {
    const r = scan(`import { law } from "pdd";
for (const n of [1, 2]) law("n" + n, x);
function f() { law("inner", y); }`);
    expect(r.violations.map((v) => v.message)).toEqual([
      expect.stringMatching(/top-level/),
      expect.stringMatching(/top-level/),
    ]);
  });

  test("flags computed names and aliasing", () => {
    const r = scan(`import { law } from "pdd";
law(name, x);
const L = law;`);
    expect(r.violations.map((v) => v.message)).toEqual([
      expect.stringMatching(/string literal/),
      expect.stringMatching(/called directly/),
    ]);
  });

  test("ignores a local function called law", () => {
    const r = scan(`function law(n: string) {}
law("not a pdd law");`);
    expect(r.count).toBe(0);
  });
});
