/**
 * Law registry, shared between the public API (law/forAll) and the runner.
 *
 * The code under test runs in the same process as the runner, so this module
 * avoids anything it could easily intercept: the store is a null-prototype
 * object (no inherited setters), built-ins are captured when the module loads
 * (before any user code), and the registry can be read only once, by the
 * runner, which claims it before importing the law file.
 */

const create = Object.create;
const freeze = Object.freeze;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

export interface LawOptions {
  /** Number of generated cases for this law. Defaults to `runs` in pdd.config.json. */
  runs?: number;
  /** Time budget for this law in milliseconds. Defaults to `timeoutMs` in pdd.config.json. */
  timeoutMs?: number;
}

export interface LawRecord {
  readonly name: string;
  readonly build: () => unknown;
  readonly options: Readonly<LawOptions>;
}

const store: Record<number, LawRecord> = create(null);
let count = 0;
let claimed = false;

export function registerLaw(record: LawRecord): void {
  store[count] = freeze(record);
  count += 1;
}

export interface RegistryReader {
  count(): number;
  at(index: number): LawRecord | undefined;
}

/** Hands out read access to the registry exactly once (the runner takes it first). */
export function claimRegistry(): RegistryReader {
  if (claimed) throw new Error("pdd: the law registry was already claimed");
  claimed = true;
  return freeze({
    count: () => count,
    at: (index: number) => (index >= 0 && index < count ? store[index] : undefined),
  });
}

declare const lawPropertyBrand: unique symbol;

/** Opaque value returned by forAll()/forAllAsync(). Only the pdd runner can execute it. */
export interface LawProperty {
  readonly [lawPropertyBrand]: true;
}

const PROPERTY = Symbol("pdd.property");

export function wrapProperty(property: unknown): LawProperty {
  return freeze(create(null, { [PROPERTY]: { value: property } })) as LawProperty;
}

export function unwrapProperty(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return getOwnPropertyDescriptor(value, PROPERTY)?.value;
}
