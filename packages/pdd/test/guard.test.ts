import { describe, expect, test } from "vitest";
import { checkSource } from "../src/guard/engine.js";
import type { FileKind } from "../src/guard/types.js";

const LAWED = "/p/src/cart.ts";

function ids(text: string, kind: FileKind = "src", file = "/p/src/x.ts"): string[] {
  return checkSource(file, text, {
    kind,
    isLawedModule: (abs) => abs === LAWED,
    isInLawsDir: (abs) => abs.startsWith("/p/laws/"),
  }).map((v) => v.ruleId);
}

describe("type escapes", () => {
  test("no-explicit-any", () => {
    expect(ids("export const f = (x: any) => x;")).toContain("no-explicit-any");
    expect(ids("export const f = (x: unknown) => x;")).toEqual([]);
  });

  test("no-ts-suppress finds directives in comments only", () => {
    expect(ids("// @ts-ignore\nconst a: number = 'x';")).toContain("no-ts-suppress");
    expect(ids("/* @ts-expect-error */ const a = 1;")).toContain("no-ts-suppress");
    expect(ids("// @ts-nocheck\n")).toContain("no-ts-suppress");
    expect(ids("const s = '// @ts-ignore';")).toEqual([]);
  });

  test("no-eslint-disable", () => {
    expect(ids("// eslint-disable-next-line\nconst a = 1;")).toContain("no-eslint-disable");
    expect(ids("/* eslint-disable */")).toContain("no-eslint-disable");
    expect(ids("// biome-ignore lint: reason\nconst a = 1;")).toContain("no-eslint-disable");
    expect(ids("// a normal comment about eslint\nconst a = 1;")).toEqual([]);
  });

  test("no-unsafe-cast", () => {
    expect(ids("const n = ('x' as unknown) as number;")).toContain("no-unsafe-cast");
    expect(ids("const n = 'x' as unknown as number;")).toContain("no-unsafe-cast");
    expect(ids("const n = 1 as number;")).toEqual([]);
  });

  test("no-non-null-assertion is a warning with a threshold", () => {
    const v = checkSource("/p/src/x.ts", "declare const a: string | null; a!.length;", { kind: "src" });
    expect(v).toMatchObject([{ ruleId: "no-non-null-assertion", severity: "warn" }]);
    const allowed = checkSource("/p/src/x.ts", "declare const a: string | null; a!.length;", {
      kind: "src",
      rules: { "no-non-null-assertion": ["error", { max: 1 }] },
    });
    expect(allowed).toEqual([]);
  });

  test("rules can be turned off by the (locked) config", () => {
    const v = checkSource("/p/src/x.ts", "let x: any;", { kind: "src", rules: { "no-explicit-any": "off" } });
    expect(v).toEqual([]);
  });
});

describe("test hygiene", () => {
  test("no-test-skip", () => {
    expect(ids("it.skip('x', () => {});", "test")).toContain("no-test-skip");
    expect(ids("describe.only('x', () => {});", "test")).toContain("no-test-skip");
    expect(ids("test.concurrent.skip('x', () => {});", "test")).toContain("no-test-skip");
    expect(ids("xit('x', () => {});", "test")).toContain("no-test-skip");
    expect(ids("it('x', () => {});", "test")).toEqual([]);
  });

  test("no-mock-under-law", () => {
    const file = "/p/src/cart.test.ts";
    // resolveRelative needs the file to exist, so point at this repo's own sources instead.
    const real = new URL("../src/api/index.ts", import.meta.url).pathname;
    const testFile = new URL("../src/api/fake.test.ts", import.meta.url).pathname;
    const v = checkSource(testFile, `vi.mock("./index.js");`, { kind: "test", isLawedModule: (abs) => abs === real });
    expect(v.map((x) => x.ruleId)).toEqual(["no-mock-under-law"]);
    expect(ids(`vi.mock("lodash");`, "test", file)).toEqual([]);
  });

  test("src rules do not apply to tests", () => {
    expect(ids("let x: any;", "test")).toEqual([]);
  });
});

describe("runtime integrity", () => {
  test("no-global-patch", () => {
    expect(ids("Math.random = () => 0.5;")).toContain("no-global-patch");
    expect(ids("Array.prototype.includes = function () { return true; };")).toContain("no-global-patch");
    expect(ids("Object.defineProperty(Math, 'random', { value: () => 0 });")).toContain("no-global-patch");
    expect(ids("globalThis.fetch = fake;")).toContain("no-global-patch");
    expect(ids("({} as Record<string, unknown>).__proto__ = null;")).toContain("no-global-patch");
    expect(ids("delete Math.max;")).toContain("no-global-patch");
    expect(ids("process.env.FOO = 'bar'; process.exitCode = 1;")).toEqual([]);
    expect(ids("const o = { random: 1 }; o.random = 2;")).toEqual([]);
  });

  test("no-dynamic-code", () => {
    expect(ids("eval('1');")).toContain("no-dynamic-code");
    expect(ids("new Function('return 1');")).toContain("no-dynamic-code");
    expect(ids("const m = 'fast-' + 'check'; await import(m);")).toContain("no-dynamic-code");
    expect(ids("await import('./x.js');")).toEqual([]);
  });

  test("no-pdd-internals", () => {
    expect(ids(`import { law } from "pdd";`)).toContain("no-pdd-internals");
    expect(ids(`import * as fc from "fast-check";`)).toContain("no-pdd-internals");
    expect(ids(`import x from "../node_modules/pdd/dist/api/registry.js";`)).toContain("no-pdd-internals");
    expect(ids(`import { z } from "zod";`)).toEqual([]);
  });

  test("no-env-sniff", () => {
    expect(ids("if (process.env.CI) {}")).toContain("no-env-sniff");
    expect(ids("const x = process.env['PDD_SEED'];")).toContain("no-env-sniff");
    expect(ids("const { VITEST } = process.env;")).toContain("no-env-sniff");
    expect(ids("const env = globalThis.process?.env; if (env?.CI) {}")).toContain("no-env-sniff");
    expect(ids("const { GITHUB_ACTIONS: gh } = someEnv;")).toContain("no-env-sniff");
    expect(ids("const url = process.env.DATABASE_URL;")).toEqual([]);
  });

  test("no-runner-ipc", () => {
    expect(ids("process.send?.({ type: 'done' });")).toContain("no-runner-ipc");
    expect(ids("globalThis.process.send({});")).toContain("no-runner-ipc");
    expect(ids("process.on('message', () => {});")).toContain("no-runner-ipc");
    expect(ids("process.on('exit', () => {});")).toEqual([]);
  });
});
