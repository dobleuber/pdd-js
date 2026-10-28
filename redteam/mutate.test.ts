/**
 * pdd mutate and pdd coverage against a copy of the example project.
 * The Stryker runs are slow and CPU-heavy, so they run one after another.
 *
 * Exit codes: 0 pass · 1 law failed · 4 tampering · 5 config · 6 spec too weak.
 */
import { describe, expect, test, type TestContext } from "vitest";
import { makeSandbox, type Sandbox } from "./sandbox.js";

async function sandbox(ctx: TestContext): Promise<Sandbox> {
  const s = await makeSandbox();
  ctx.onTestFinished(() => s.dispose());
  return s;
}

interface MutateJson {
  exitCode: number;
  check: { exitCode: number };
  mutation?: {
    score: number | null;
    survivors: Array<{ status: string; function: string | null; original: string; mutator: string }>;
    tampering: Array<{ reason: string }>;
  };
  coverage?: { uncovered: Array<{ name: string }> };
}

function parse(stdout: string): MutateJson {
  return JSON.parse(stdout) as MutateJson;
}

const DISCOUNT_LAW = `law(
  "a discount outside 0–100 % or fractional is rejected",
  forAll(arbCart, arbBadPercent, (cart, p) => rejects(() => applyDiscount(cart, p))),
);
`;

describe("pdd mutate", () => {
  test("the example's laws catch every mutant except error-message text (0)", async (ctx) => {
    const s = await sandbox(ctx);
    const r = await s.run(["mutate", "--json"]);
    expect(r.code, r.out).toBe(0);
    const m = parse(r.stdout).mutation;
    expect(m?.score).toBeGreaterThanOrEqual(85);
    expect(m?.survivors.every((x) => x.mutator === "StringLiteral")).toBe(true);
    expect(m?.tampering).toEqual([]);
  });

  test("dropping a law lets mutants survive and fails the break threshold (6)", async (ctx) => {
    const s = await sandbox(ctx);
    await s.edit("laws/cart.laws.ts", (t) => t.replace(DISCOUNT_LAW, ""));
    await s.run(["lock"]); // a human re-locks the weaker spec
    const r = await s.run(["mutate", "--json"]);
    expect(r.code, r.out).toBe(6);
    const m = parse(r.stdout).mutation;
    const discount = m?.survivors.filter((x) => x.function === "applyDiscount") ?? [];
    expect(discount.some((x) => /percent > 100/.test(x.original))).toBe(true);
    expect(m?.score).toBeLessThan(85);
  });

  test("code that detects mutation testing at runtime is reported as tampering (4)", async (ctx) => {
    const s = await sandbox(ctx);
    // Even with the static rule turned off by a human, the runtime defense holds.
    await s.edit("pdd.config.json", (t) => t.replace('"no-non-null-assertion": "error"', '"no-non-null-assertion": "error",\n      "no-pdd-internals": "off"'));
    await s.run(["lock"]);
    await s.edit("src/cart.ts", (t) =>
      t.replace(
        "export function total(cart: Cart): number {",
        `export function total(cart: Cart): number {
  const ns = (globalThis as Record<string, { activeMutant?: string } | undefined>)["__stryker__"];
  if (ns?.activeMutant !== undefined) (globalThis as { process?: { exit(code: number): void } }).process?.exit(0);`,
      ),
    );
    const r = await s.run(["mutate", "--json"]);
    expect(r.code, r.out).toBe(4);
    expect(parse(r.stdout).mutation?.tampering.length).toBeGreaterThan(0);
  });
});

describe("pdd mutate preconditions", () => {
  test.concurrent("a red pdd check stops pdd mutate with the check's exit code (1)", async (ctx) => {
    const s = await sandbox(ctx);
    await s.edit("src/cart.ts", (t) => t.replace("export function total(cart: Cart): number {", "export function total(cart: Cart): number {\n  if (cart.items.length > 2) return 0;"));
    const r = await s.run(["mutate", "--json"]);
    expect(r.code, r.out).toBe(1);
    expect(parse(r.stdout).mutation).toBeUndefined();
  });

  test.concurrent("a Stryker config file is refused: only the locked pdd.config.json counts (5)", async (ctx) => {
    const s = await sandbox(ctx);
    await s.write("stryker.config.json", JSON.stringify({ mutator: { excludedMutations: ["ConditionalExpression"] } }));
    const r = await s.run(["mutate"]);
    expect(r.code, r.out).toBe(5);
    expect(r.out).toMatch(/stryker\.config\.json/);
  });

  test.concurrent("--seed is rejected in CI (5)", async (ctx) => {
    const s = await sandbox(ctx);
    expect((await s.run(["mutate", "--seed", "1", "--ci"])).code).toBe(5);
  });
});

describe("pdd coverage", () => {
  test.concurrent("an export no law reaches is listed, and fails with --strict (6)", async (ctx) => {
    const s = await sandbox(ctx);
    await s.edit("src/cart.ts", (t) => `${t}\nexport function clear(cart: Cart): Cart {\n  return { items: cart.items.slice(0, 0) };\n}\n`);
    const plain = await s.run(["coverage", "--json"]);
    expect(plain.code, plain.out).toBe(0);
    expect((JSON.parse(plain.stdout) as MutateJson).coverage ?? JSON.parse(plain.stdout)).toMatchObject({ uncovered: [{ name: "clear" }] });
    expect((await s.run(["coverage", "--strict"])).code).toBe(6);
  });
});
