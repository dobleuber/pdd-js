import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import { arb, forAll, forAllAsync, law } from "../src/api/index.js";
import { claimRegistry, unwrapProperty } from "../src/api/registry.js";

const check = (p: unknown) => fc.check(unwrapProperty(p) as fc.IRawProperty<unknown[]>, { numRuns: 50, seed: 1 });

describe("forAll", () => {
  test("passes when the predicate always returns true", async () => {
    const r = await check(forAll(arb.integer(), (n) => n + 0 === n));
    expect(r.failed).toBe(false);
  });

  test("fails with a counterexample when the predicate returns false", async () => {
    const r = await check(forAll(arb.integer({ min: 0, max: 100 }), (n) => n < 50));
    expect(r.failed).toBe(true);
    expect(r.counterexample).toEqual([50]);
  });

  test("a predicate that forgets to return fails instead of passing", async () => {
    // @ts-expect-error: deliberately returns void
    const r = await check(forAll(arb.integer(), (n) => { void (n > 0); }));
    expect(r.failed).toBe(true);
    expect(String((r as { errorInstance?: unknown }).errorInstance)).toMatch(/must return true or false/);
  });

  test("an async predicate passed to forAll fails instead of passing", async () => {
    // @ts-expect-error: deliberately returns a Promise
    const r = await check(forAll(arb.integer(), async () => false));
    expect(r.failed).toBe(true);
    expect(String((r as { errorInstance?: unknown }).errorInstance)).toMatch(/forAllAsync/);
  });

  test("forAllAsync awaits the predicate", async () => {
    const r = await check(forAllAsync(arb.integer(), async (n) => n !== n + 1));
    expect(r.failed).toBe(false);
    const bad = await check(forAllAsync(arb.integer(), async () => false));
    expect(bad.failed).toBe(true);
  });

  test("rejects non-arbitraries", () => {
    // @ts-expect-error: not an arbitrary
    expect(() => forAll(42, () => true)).toThrow(/not an arbitrary/);
  });
});

describe("registry", () => {
  test("law() registers in order and the registry can be claimed only once", () => {
    law("first", forAll(arb.boolean(), () => true));
    law("second", () => forAll(arb.boolean(), () => true), { runs: 5 });
    const reader = claimRegistry();
    expect(reader.count()).toBe(2);
    expect(reader.at(0)?.name).toBe("first");
    expect(reader.at(1)?.options.runs).toBe(5);
    expect(reader.at(2)).toBeUndefined();
    expect(Object.isFrozen(reader.at(0))).toBe(true);
    expect(() => claimRegistry()).toThrow(/already claimed/);
  });

  test("law() needs a name", () => {
    expect(() => law("  ", forAll(arb.boolean(), () => true))).toThrow(/non-empty name/);
  });

  test("law properties are opaque", () => {
    const p = forAll(arb.boolean(), () => true);
    expect(Object.keys(p)).toEqual([]);
    expect(Object.getPrototypeOf(p)).toBeNull();
    expect(Object.isFrozen(p)).toBe(true);
    expect(unwrapProperty({})).toBeUndefined();
  });
});
