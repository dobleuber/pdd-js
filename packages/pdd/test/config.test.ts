import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/load.js";

describe("config", () => {
  test("applies defaults", () => {
    const c = parseConfig("/p", "{}");
    expect(c).toMatchObject({ root: "/p", lawsDir: "laws", runs: 200, typecheck: true, tsconfig: "tsconfig.json" });
  });

  test("rejects unknown keys, rules and bad values", () => {
    expect(() => parseConfig("/p", `{"runz": 5}`)).toThrow(/invalid pdd.config.json/);
    expect(() => parseConfig("/p", `{"runs": 0}`)).toThrow(/runs/);
    expect(() => parseConfig("/p", `{"guard": {"rules": {"no-such-rule": "off"}}}`)).toThrow(/unknown guard rule/);
    expect(() => parseConfig("/p", `{"lawsDir": "../elsewhere"}`)).toThrow(/inside the project/);
    expect(() => parseConfig("/p", `not json`)).toThrow(/not valid JSON/);
  });

  test("accepts rule settings with options", () => {
    const c = parseConfig("/p", `{"guard": {"rules": {"no-non-null-assertion": ["error", {"max": 2}], "no-explicit-any": "off"}}}`);
    expect(c.guard.rules["no-non-null-assertion"]).toEqual(["error", { max: 2 }]);
  });

  test("mutate and coverage settings have safe defaults and are validated", () => {
    const c = parseConfig("/p", "{}");
    expect(c.mutate).toEqual({ files: null, thresholds: { high: 80, low: 60, break: null }, concurrency: null, timeoutMs: 10_000, typecheck: true });
    expect(c.coverage).toEqual({ failOnUncovered: false, ignore: [] });
    const custom = parseConfig("/p", `{"typecheck": false, "mutate": {"thresholds": {"break": 70}, "concurrency": 2}}`);
    expect(custom.mutate).toMatchObject({ thresholds: { high: 80, low: 60, break: 70 }, concurrency: 2, typecheck: false });
    expect(() => parseConfig("/p", `{"mutate": {"thresholds": {"low": 90, "high": 80}}}`)).toThrow(/must not be above/);
    expect(() => parseConfig("/p", `{"mutate": {"thresholds": {"break": 120}}}`)).toThrow(/break/);
    expect(() => parseConfig("/p", `{"mutate": {"excludedMutations": ["StringLiteral"]}}`)).toThrow(/invalid pdd.config.json/);
  });

  test("smt settings have safe defaults and are validated", () => {
    expect(parseConfig("/p", "{}").smt).toEqual({ timeoutMs: 10_000, requireProof: false });
    expect(parseConfig("/p", `{"smt": {"requireProof": true, "timeoutMs": 500}}`).smt).toEqual({ timeoutMs: 500, requireProof: true });
    expect(() => parseConfig("/p", `{"smt": {"timeoutMs": 0}}`)).toThrow(/invalid pdd.config.json/);
    expect(() => parseConfig("/p", `{"smt": {"assume": ["x > 0"]}}`)).toThrow(/invalid pdd.config.json/);
  });
});
