/** Shared generators and helpers for the laws. Human-owned and locked, like the laws themselves. */
import { arb, type Arbitrary } from "@dobleuber/pdd";
import { MAX_BPS, MAX_CENTS } from "../src/money.js";

/** Any amount the system handles. */
export const arbCents = arb.integer({ min: 0, max: MAX_CENTS });

/** Any rate from 0 % to 100 %, in basis points. */
export const arbBps = arb.integer({ min: 0, max: MAX_BPS });

/** Rates real invoices use, mixed with random ones: 0 %, 10 %, 21 %, 100 %. */
export const arbCommonBps: Arbitrary<number> = arb.oneof(arb.constantFrom(0, 1_000, 2_100, MAX_BPS), arbBps);

/** Rates that must be rejected. */
export const arbBadBps: Arbitrary<number> = arb.oneof(
  arb.integer({ min: -10_000, max: -1 }),
  arb.integer({ min: MAX_BPS + 1, max: 100_000 }),
  arb.integer({ min: 0, max: MAX_BPS - 1 }).map((n) => n + 0.5),
  arb.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
);

/** True when `run` throws a RangeError that says what is wrong. */
export function rejects(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (e) {
    return e instanceof RangeError && e.message.trim() !== "";
  }
}

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export const abs = (n: bigint): bigint => (n < 0n ? -n : n);
