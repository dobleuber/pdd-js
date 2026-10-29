/**
 * pdd smt's translator and its Z3 encoding.
 *
 * Every law in the fixture says in its name what pdd smt must answer:
 *   "proven: ..."         Z3 proves it (unsat);
 *   "sat: ..."            Z3 finds an input that breaks the law or one of its obligations;
 *   "untranslatable: ..." the translator refuses it, with a reason containing the text after the colon.
 *
 * The differential tests compare the translation with real JavaScript on sampled inputs,
 * both through the plain IR evaluator and through Z3.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import type ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { smtExitCode } from "../src/commands/smt.js";
import { parseConfig } from "../src/config/load.js";
import { lawsDirFiles, loadProjectProgram } from "../src/shared/program.js";
import * as ir from "../src/smt/ir.js";
import { findSmtLaws, translateLaw, type SmtProblem, type Translation } from "../src/smt/translate.js";
import { openZ3, type Z3Session } from "../src/smt/z3.js";

const PDD_API = fileURLToPath(new URL("../src/api/index.ts", import.meta.url));

/** Expressions over integers a and b, compared against JavaScript. `b` is never 0. */
const EXPRESSIONS = [
  "a % b",
  "Math.floor(a / b)",
  "Math.ceil(a / b)",
  "Math.trunc(a / b)",
  "Math.floor((a * 3 - 1) / (b * 2))",
  "Math.abs(a - b)",
  "Math.min(a, b, 3)",
  "Math.max(a, -b)",
  "Math.sign(a)",
  "a > b ? a - b : b - a",
  "-a * b + 7",
  "(a % b) + Math.trunc(a / b) * b",
  "a <= b && b !== 0 ? 1 : 0",
  "!(a === b) || a < 0 ? a : b",
];

const SRC = `
export const LIMIT = 100;
export const SETTINGS = { rate: 5 };
export let counter = 0;

export function clamp(x: number): number {
  if (x < 0) throw new RangeError("negative");
  if (x > LIMIT) return LIMIT;
  return x;
}

export function risky(x: number): number {
  if (x > 50) throw new RangeError("too big");
  return x;
}

export const lineTotal = ({ price, qty }: { price: number; qty: number }): number => price * qty;

export function swap(t: readonly [number, number]): [number, number] {
  const [x, y] = t;
  return [y, x];
}

export function sumTo(n: number): number {
  while (n > 100) {
    return 0;
  }
  return n;
}

export function fact(n: number): number {
  return n <= 1 ? 1 : n * fact(n - 1);
}

export function bump(x: number): number {
  return x + counter;
}

export function rated(x: number): number {
  return x * SETTINGS.rate;
}

export function label(x: number): boolean {
  return \`\${x}\` === "1";
}

${EXPRESSIONS.map((e, i) => `export function e${i}(a: number, b: number): number { return ${e}; }`).join("\n")}
`;

const SHADOW = `
const Math = { ceil: (x: number): number => x + 1 };
export function up(x: number): number {
  return Math.ceil(x);
}
`;

const LAWS = `
import { law, forAll, arb } from "@dobleuber/pdd";
import { clamp, risky, lineTotal, swap, sumTo, fact, bump, rated, label, LIMIT } from "../src/m.js";
import { up } from "../src/shadow.js";
import { twice } from "../src/sib.js";

const small = arb.integer({ min: -1000, max: 1000 });
const positive = arb.integer({ min: 1, max: 10 });
const fake = { integer: (o: { min: number; max: number }) => arb.integer(o) };

law("proven: abs is never negative", forAll(small, (x) => Math.abs(x) >= 0), { smt: true });
law("proven: the remainder keeps the dividend's sign", forAll(arb.integer({ min: -100, max: 100 }), positive, (a, b) => a % b === 0 || (a % b < 0) === (a < 0)), { smt: true });
law("proven: floor division brackets the dividend", forAll(small, positive, (a, b) => Math.floor(a / b) * b <= a && a < (Math.floor(a / b) + 1) * b), { smt: true });
law("proven: an unreachable throw and a module const", forAll(arb.nat({ max: 500 }), (x) => clamp(x) <= LIMIT), { smt: true });
law("proven: records and destructuring", forAll(arb.record({ price: arb.nat(1000), qty: positive }), (item) => lineTotal(item) >= item.price), { smt: true });
law("proven: tuples", forAll(arb.tuple(small, small), (t) => { const s = swap(t); return s[0] === t[1] && s.length === 2; }), { smt: true });
law("proven: oneof, constantFrom and booleans", forAll(arb.oneof(arb.constantFrom(2, 4), arb.integer({ min: 10, max: 12 })), arb.boolean(), (x, flag) => (flag ? x : -x) !== 0), { smt: true });
law("proven: a thunk body", () => forAll(arb.maxSafeNat(), (n) => n >= 0 && Number.isInteger(n)), { smt: true });

law("sat: the remainder can be negative", forAll(arb.integer({ min: -10, max: 10 }), positive, (a, b) => a % b >= 0), { smt: true });
law("sat: a reachable throw", forAll(arb.nat({ max: 100 }), (x) => risky(x) >= 0), { smt: true });
law("sat: n + 1 may leave the safe-integer range", forAll(arb.maxSafeNat(), (n) => n + 1 > n), { smt: true });
law("sat: the divisor may be 0", forAll(arb.integer({ min: -3, max: 3 }), arb.integer({ min: -3, max: 3 }), (a, b) => Math.floor(a / b) <= Math.abs(a)), { smt: true });
law("sat: a false law", forAll(positive, (x) => x * x !== 49), { smt: true });

law("untranslatable: wrapped in Math.floor", forAll(small, (x) => x / 2 <= x), { smt: true });
law("untranslatable: loops are not supported", forAll(positive, (n) => sumTo(n) >= 0), { smt: true });
law("untranslatable: recursive", forAll(positive, (n) => fact(n) >= 1), { smt: true });
law("untranslatable: is not a const", forAll(positive, (n) => bump(n) >= n), { smt: true });
law("untranslatable: module-level object", forAll(positive, (n) => rated(n) >= n), { smt: true });
law("untranslatable: strings are not supported", forAll(positive, (n) => label(n) || true), { smt: true });
law("untranslatable: method calls", forAll(positive, (n) => up(n) > n), { smt: true });
law("untranslatable: cannot see through map/filter/chain", forAll(positive.map((x) => x * 2), (n) => n > 0), { smt: true });
law("untranslatable: imported from \\"@dobleuber/pdd\\"", forAll(fake.integer({ min: 0, max: 1 }), (n) => n < 2), { smt: true });
law("untranslatable: the literal \`true\`", forAll(positive, (n) => n > 0), { smt: !false });
law("untranslatable: sits next to", forAll(positive, (n) => twice(n) === n * 2), { smt: true });

law("not marked, so not collected", forAll(positive, (n) => n > 0));
law("not marked either", forAll(positive, (n) => n > 0), { runs: 10 });
`;

const DIFF_LAWS = `
import { law, forAll, arb } from "@dobleuber/pdd";
import { ${EXPRESSIONS.map((_, i) => `e${i}`).join(", ")} } from "../src/m.js";
const any = arb.integer({ min: -100000, max: 100000 });
${EXPRESSIONS.map((_, i) => `law("e${i}", forAll(any, any, any, (a, b, r) => e${i}(a, b) === r), { smt: true });`).join("\n")}
`;

let dir: string;
let program: ts.Program;
let z3: Z3Session;
const results = new Map<string, Translation>();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pdd-smt-"));
  const files: Record<string, string> = {
    "pdd.config.json": "{}",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, paths: { "@dobleuber/pdd": [PDD_API] } },
      include: ["src", "laws"],
    }),
    "src/m.ts": SRC,
    "src/shadow.ts": SHADOW,
    "src/sib.ts": "export function twice(n: number): number { return n * 2; }\n",
    "src/sib.js": "export function twice(n) { return n + n; }\n",
    "laws/a.laws.ts": LAWS,
    "laws/diff.laws.ts": DIFF_LAWS,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  const config = parseConfig(dir, "{}");
  const loaded = loadProjectProgram(config, lawsDirFiles(config));
  if (loaded.status !== "ok") throw new Error("fixture program did not load");
  program = loaded.program;
  for (const file of lawsDirFiles(config)) {
    for (const site of findSmtLaws(program, dir, file)) results.set(site.name, translateLaw(program, dir, site));
  }
  z3 = await openZ3(dir);
}, 60_000);

afterAll(async () => {
  await z3?.close();
  await rm(dir, { recursive: true, force: true });
});

function problem(name: string): SmtProblem {
  const t = results.get(name);
  if (!t) throw new Error(`no smt law named ${name}`);
  if (!t.ok) throw new Error(`${name} did not translate: ${t.reason} (${t.at})`);
  return t.problem;
}

describe("pdd smt translation", () => {
  test("collects only the laws marked smt", () => {
    expect(results.has("not marked, so not collected")).toBe(false);
    expect(results.has("not marked either")).toBe(false);
    expect(results.size).toBe(24 + EXPRESSIONS.length);
  });

  const names = [...LAWS.matchAll(/law\("((?:proven|sat|untranslatable): [^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => (m[1] as string).replace(/\\"/g, '"'));

  test.each(names.filter((n) => n.startsWith("untranslatable")))("%s", (name) => {
    const t = results.get(name);
    expect(t?.ok, `${name} should not translate`).toBe(false);
    if (t && !t.ok) expect(t.reason).toContain(name.slice("untranslatable: ".length));
  });

  test.each(names.filter((n) => !n.startsWith("untranslatable")))("%s", async (name) => {
    const p = problem(name);
    const outcome = await z3.check(p.pre, p.goal, p.leaves, 10_000);
    expect(outcome.status).toBe(name.startsWith("proven") ? "unsat" : "sat");
    if (outcome.status === "sat") {
      // The model is inside the input domain, and breaks the goal by the plain evaluator too.
      expect(ir.evaluate(p.pre, outcome.model)).toBe(true);
      let goal: boolean;
      try {
        goal = ir.evaluate(p.goal, outcome.model) === true;
      } catch {
        goal = false; // e.g. a division by zero the obligations were guarding against
      }
      expect(goal).toBe(false);
    }
  });

  test("a reported reason points at the code that caused it", () => {
    const t = results.get("untranslatable: loops are not supported");
    expect(t && !t.ok && t.at).toMatch(/^src\/m\.ts:\d+$/);
  });
});

describe("pdd smt semantics match JavaScript", () => {
  const sample = fc.sample(fc.tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 }).filter((b) => b !== 0)), { numRuns: 40, seed: 42 });
  const edges: Array<[number, number]> = [[7, 2], [-7, 2], [7, -2], [-7, -2], [0, -3], [6, 3], [-6, 3], [1, 1000], [-1, 1000]];

  test.each(EXPRESSIONS.map((e, i) => [e, i] as const))("%s", async (expr, i) => {
    const js = new Function("a", "b", `return Number(${expr});`) as (a: number, b: number) => number;
    const p = problem(`e${i}`);
    const [a, b, r] = p.leaves.map((l) => l.name) as [string, string, string];
    for (const [va, vb] of [...edges, ...sample]) {
      const expected = js(va, vb) + 0; // -0 → 0
      const model = new Map<string, bigint | boolean>([[a, BigInt(va)], [b, BigInt(vb)], [r, BigInt(expected)]]);
      // the IR evaluator agrees with JavaScript ...
      expect(ir.evaluate(p.result, model), `${expr} with a=${va}, b=${vb}`).toBe(true);
      // ... and so does Z3: with these inputs, the only r that satisfies the goal is the JS result.
      const pin = ir.and(p.pre, ir.eq(ir.ivar(a), ir.int(BigInt(va))), ir.eq(ir.ivar(b), ir.int(BigInt(vb))));
      const outcome = await z3.check(pin, ir.implies(p.result, ir.eq(ir.ivar(r), ir.int(BigInt(expected)))), p.leaves, 10_000);
      expect(outcome.status, `${expr} with a=${va}, b=${vb} (Z3)`).toBe("unsat");
    }
  }, 60_000);
});

describe("pdd smt exit codes", () => {
  const report = (s: Partial<{ proven: number; counterexamples: number; notProven: number; tampering: number }>) => ({
    z3: null,
    laws: [],
    summary: { laws: 3, proven: 0, counterexamples: 0, notProven: 0, tampering: 0, ...s },
  });
  test("tampering beats a counterexample, which beats an unproven law under --strict", () => {
    expect(smtExitCode(report({ proven: 3 }), true)).toBe(0);
    expect(smtExitCode(report({ notProven: 1 }), false)).toBe(0);
    expect(smtExitCode(report({ notProven: 1 }), true)).toBe(7);
    expect(smtExitCode(report({ counterexamples: 1, notProven: 1 }), true)).toBe(1);
    expect(smtExitCode(report({ tampering: 1, counterexamples: 1 }), true)).toBe(4);
  });
});
