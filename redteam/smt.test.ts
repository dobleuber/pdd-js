/**
 * pdd smt against a copy of the example project: real CLI, real Z3, real replay.
 *
 * Exit codes: 0 pass · 1 counterexample · 4 tampering · 5 config · 7 not proven (--strict).
 */
import { describe, expect, test, type TestContext } from "vitest";
import { makeSandbox, type Sandbox } from "./sandbox.js";

async function sandbox(ctx: TestContext): Promise<Sandbox> {
  const s = await makeSandbox();
  ctx.onTestFinished(() => s.dispose());
  return s;
}

interface SmtJson {
  exitCode: number;
  check: { exitCode: number };
  smt?: {
    laws: Array<{ name: string; status: string; why?: string; reason?: string; counterexample?: string }>;
    summary: { laws: number; proven: number; counterexamples: number; notProven: number; tampering: number };
  };
}

const parse = (stdout: string): SmtJson => JSON.parse(stdout) as SmtJson;

const RETURN = "  return totalCents - Math.ceil((totalCents * percent) / 100);";

/** A JS twin of src/cart.ts with a wrong discount: what the runtime would load next to cart.ts. */
const CART_JS = `
export function createCart() { return { items: [] }; }
export function addItem(cart, item) {
  if (!Number.isInteger(item.price) || item.price < 0) throw new RangeError("price must be a non-negative integer (cents)");
  if (!Number.isInteger(item.qty) || item.qty < 1) throw new RangeError("qty must be a positive integer");
  return { items: [...cart.items, { ...item }] };
}
export function removeItem(cart, sku) { return { items: cart.items.filter((i) => i.sku !== sku) }; }
export function total(cart) { return cart.items.reduce((sum, i) => sum + i.price * i.qty, 0); }
export function itemCount(cart) { return cart.items.reduce((n, i) => n + i.qty, 0); }
export function discounted(totalCents, percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new RangeError("percent must be an integer between 0 and 100");
  if (totalCents === 777777777 && percent === 37) return totalCents + 1;
  return totalCents - Math.ceil((totalCents * percent) / 100);
}
export function applyDiscount(cart, percent) { return discounted(total(cart), percent); }
`;

describe("pdd smt", () => {
  test.concurrent("the example's discount laws are proven for every input (0)", async (ctx) => {
    const s = await sandbox(ctx);
    const r = await s.run(["smt", "--json", "--strict"]);
    expect(r.code, r.out).toBe(0);
    const smt = parse(r.stdout).smt;
    expect(smt?.summary).toMatchObject({ laws: 3, proven: 3, counterexamples: 0, notProven: 0 });
  });

  test.concurrent("a bug random testing misses is found by Z3 and confirmed by the runner (1)", async (ctx) => {
    const s = await sandbox(ctx);
    await s.edit("src/cart.ts", (t) => t.replace(RETURN, `  if (totalCents === 777_777_777 && percent === 37) return totalCents + 1;\n${RETURN}`));
    const r = await s.run(["smt", "--json"]);
    expect(r.code, r.out).toBe(1);
    const report = parse(r.stdout);
    expect(report.check.exitCode).toBe(0); // pdd check's 200 random cases did not hit it
    const bad = report.smt?.laws.filter((l) => l.status === "counterexample") ?? [];
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.every((l) => l.counterexample === "[777777777,37]")).toBe(true);
  });

  test.concurrent("code outside the provable subset is reported, never proven; requireProof fails (7)", async (ctx) => {
    const s = await sandbox(ctx);
    await s.edit("src/cart.ts", (t) => t.replace(RETURN, "  let d = totalCents - Math.ceil((totalCents * percent) / 100);\n  return d;"));
    // The example's locked config sets smt.requireProof, so an unproven law fails the run.
    const r = await s.run(["smt", "--json"]);
    expect(r.code, r.out).toBe(7);
    const laws = parse(r.stdout).smt?.laws ?? [];
    expect(laws.length).toBe(3);
    expect(laws.every((l) => l.status === "not-proven" && l.why === "untranslatable" && /const/.test(l.reason ?? ""))).toBe(true);
  });

  test.concurrent("a JS file next to the TS file it shadows makes the proof refuse (7)", async (ctx) => {
    const s = await sandbox(ctx);
    // At runtime `../src/cart.js` now loads this file, not the cart.ts that Z3 would read.
    await s.write("src/cart.js", CART_JS);
    const r = await s.run(["smt", "--json", "--strict"]);
    expect([1, 7]).toContain(r.code); // never 0: nothing here may count as proven
    const laws = parse(r.stdout).smt?.laws ?? [];
    expect(laws.some((l) => l.status === "proven")).toBe(false);
    expect(laws.filter((l) => l.status === "not-proven").every((l) => /sits next to src\/cart\.ts/.test(l.reason ?? ""))).toBe(true);
  });

  test.concurrent("an input outside the exact-integer range is not a proof, even when the law holds (0, 7)", async (ctx) => {
    const s = await sandbox(ctx);
    await s.write(
      "laws/big.laws.ts",
      `import { law, forAll, arb } from "pdd";\nlaw("n + 1 is larger than n", forAll(arb.maxSafeNat(), (n) => n + 1 > n), { smt: true });\n`,
    );
    // A human locks the new law, and turns requireProof off to see the report without failing.
    await s.edit("pdd.config.json", (t) => t.replace('"requireProof": true', '"requireProof": false'));
    await s.run(["lock"]);
    const r = await s.run(["smt", "--json"]);
    expect(r.code, r.out).toBe(0);
    const law = parse(r.stdout).smt?.laws.find((l) => l.name === "n + 1 is larger than n");
    expect(law).toMatchObject({ status: "not-proven", why: "outside-model" });
    expect(law?.reason).toMatch(/MAX_SAFE_INTEGER/);
    expect(parse(r.stdout).smt?.summary.proven).toBe(3);
    expect((await s.run(["smt", "--strict"])).code).toBe(7);
  });

  test.concurrent("a red pdd check stops pdd smt with the check's exit code (1)", async (ctx) => {
    const s = await sandbox(ctx);
    await s.edit("src/cart.ts", (t) => t.replace("Math.ceil((totalCents", "Math.floor((totalCents"));
    const r = await s.run(["smt", "--json"]);
    expect(r.code, r.out).toBe(1);
    expect(parse(r.stdout).smt).toBeUndefined();
  });

  test.concurrent("--seed is rejected in CI (5)", async (ctx) => {
    const s = await sandbox(ctx);
    expect((await s.run(["smt", "--seed", "1", "--ci"])).code).toBe(5);
  });
});
