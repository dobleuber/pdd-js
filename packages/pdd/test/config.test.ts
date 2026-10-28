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
});
