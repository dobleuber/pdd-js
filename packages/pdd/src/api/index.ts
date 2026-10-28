/**
 * The law language. This is the only module user code should import from pdd.
 *
 *   import { law, forAll, arb } from "pdd";
 *   law("total is never negative", forAll(arbCart, (cart) => total(cart) >= 0));
 *
 * There is deliberately no law.skip / law.only / law.todo.
 */
import * as fc from "fast-check";
import { registerLaw, wrapProperty, type LawOptions, type LawProperty } from "./registry.js";

export type { LawOptions, LawProperty };
export type Arbitrary<T> = fc.Arbitrary<T>;

/** Curated subset of fast-check arbitraries. Import them from pdd, never from fast-check directly. */
export const arb = {
  integer: fc.integer,
  nat: fc.nat,
  maxSafeInteger: fc.maxSafeInteger,
  maxSafeNat: fc.maxSafeNat,
  float: fc.float,
  double: fc.double,
  bigInt: fc.bigInt,
  boolean: fc.boolean,
  string: fc.string,
  stringMatching: fc.stringMatching,
  constant: fc.constant,
  constantFrom: fc.constantFrom,
  mapToConstant: fc.mapToConstant,
  oneof: fc.oneof,
  option: fc.option,
  array: fc.array,
  uniqueArray: fc.uniqueArray,
  tuple: fc.tuple,
  record: fc.record,
  dictionary: fc.dictionary,
  subarray: fc.subarray,
  shuffledSubarray: fc.shuffledSubarray,
  date: fc.date,
  letrec: fc.letrec,
  anything: fc.anything,
  object: fc.object,
  json: fc.json,
  jsonValue: fc.jsonValue,
  uuid: fc.uuid,
  emailAddress: fc.emailAddress,
  webUrl: fc.webUrl,
  ipV4: fc.ipV4,
  lorem: fc.lorem,
  falsy: fc.falsy,
} as const;

type Arbitraries<Ts extends unknown[]> = { [K in keyof Ts]: Arbitrary<Ts[K]> };

function assertArbitraries(values: unknown[]): fc.Arbitrary<unknown>[] {
  if (values.length === 0) throw new TypeError("pdd: forAll needs at least one arbitrary");
  values.forEach((v, i) => {
    if (!(v instanceof fc.Arbitrary)) {
      throw new TypeError(`pdd: argument ${i + 1} of forAll is not an arbitrary (use arb.* from "pdd")`);
    }
  });
  return values as fc.Arbitrary<unknown>[];
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function requireBoolean(result: unknown): boolean {
  if (typeof result === "boolean") return result;
  if (isThenable(result)) {
    throw new TypeError("pdd: the predicate returned a Promise; use forAllAsync for async laws");
  }
  throw new TypeError(
    `pdd: a law predicate must return true or false, got ${result === null ? "null" : typeof result}`,
  );
}

/**
 * For all generated values, the predicate must return `true`.
 * Returning anything other than a boolean (including undefined) fails the law,
 * so a predicate with a missing `return` can never pass by accident.
 */
export function forAll<Ts extends [unknown, ...unknown[]]>(
  ...args: [...arbitraries: Arbitraries<Ts>, predicate: (...values: Ts) => boolean]
): LawProperty {
  const predicate = args[args.length - 1];
  if (typeof predicate !== "function") throw new TypeError("pdd: the last argument of forAll must be a predicate");
  const arbitraries = assertArbitraries(args.slice(0, -1));
  const checked = (...values: unknown[]): boolean => requireBoolean((predicate as (...v: unknown[]) => unknown)(...values));
  const property = (fc.property as unknown as (...a: unknown[]) => unknown)(...arbitraries, checked);
  return wrapProperty(property);
}

/** Like forAll, for predicates that return Promise<boolean>. */
export function forAllAsync<Ts extends [unknown, ...unknown[]]>(
  ...args: [...arbitraries: Arbitraries<Ts>, predicate: (...values: Ts) => Promise<boolean> | boolean]
): LawProperty {
  const predicate = args[args.length - 1];
  if (typeof predicate !== "function") throw new TypeError("pdd: the last argument of forAllAsync must be a predicate");
  const arbitraries = assertArbitraries(args.slice(0, -1));
  const checked = async (...values: unknown[]): Promise<boolean> =>
    requireBoolean(await (predicate as (...v: unknown[]) => unknown)(...values));
  const property = (fc.asyncProperty as unknown as (...a: unknown[]) => unknown)(...arbitraries, checked);
  return wrapProperty(property);
}

/**
 * Declares a law. Must be called at the top level of a `*.laws.ts` file with a
 * string literal name; pdd checks this statically and compares it with what
 * actually registers at runtime.
 */
export function law(name: string, body: LawProperty | (() => LawProperty), options: LawOptions = {}): void {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("pdd: a law needs a non-empty name");
  }
  const build = typeof body === "function" ? body : () => body;
  registerLaw({ name, build, options: { ...options } });
}
