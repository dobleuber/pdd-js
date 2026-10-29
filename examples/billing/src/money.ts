/**
 * Money helpers. Amounts are integer cents everywhere; rates are basis points
 * (1 bp = 0.01 %, so 10 000 bp = 100 %). This is the code the agent writes.
 */

/** The largest amount the system handles: one billion currency units, in cents. */
export const MAX_CENTS = 100_000_000_000;

/** The largest rate: 100 %. */
export const MAX_BPS = 10_000;

/** True for a whole, non-negative number of cents the system can handle. */
export function isCents(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_CENTS;
}

/** a / b rounded to the nearest integer, halves up. Needs a ≥ 0 and b > 0. */
export function roundDiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b <= 0) {
    throw new RangeError("roundDiv needs integers a ≥ 0 and b > 0");
  }
  return Math.floor((2 * a + b) / (2 * b));
}

/** `basisPoints` of `cents`, rounded to the nearest cent (halves up). */
export function percentOf(cents: number, basisPoints: number): number {
  if (!isCents(cents)) throw new RangeError("cents must be a whole amount between 0 and MAX_CENTS");
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > MAX_BPS) {
    throw new RangeError("basisPoints must be an integer between 0 and 10000");
  }
  return roundDiv(cents * basisPoints, MAX_BPS);
}

/** 123456 → "1234.56", -5 → "-0.05". */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError("cents must be a safe integer");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const AMOUNT = /^(-?)(\d+)\.(\d{2})$/;

/** "1234.56" → 123456. Exactly two decimals; anything else is rejected. */
export function parseCents(text: string): number {
  const m = AMOUNT.exec(text);
  if (m === null) throw new RangeError(`not an amount: ${JSON.stringify(text)}`);
  const value = Number(m[2]) * 100 + Number(m[3]);
  if (!Number.isSafeInteger(value)) throw new RangeError(`amount too large: ${text}`);
  return m[1] === "-" && value !== 0 ? -value : value;
}

/**
 * Splits `total` cents in proportion to `weights` with the largest-remainder method:
 * every share is its exact proportion rounded down or up, and the shares add up to `total`.
 * Left-over cents go to the largest remainders; ties go to the earlier weight.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  if (!isCents(total)) throw new RangeError("total must be a whole amount between 0 and MAX_CENTS");
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new RangeError("weights must be non-negative integers");
  const sum = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (sum === 0n) throw new RangeError("allocate needs at least one positive weight");

  // BigInt: total × weight can exceed Number.MAX_SAFE_INTEGER.
  const exact = weights.map((w) => BigInt(total) * BigInt(w));
  const shares = exact.map((e) => e / sum);
  let left = BigInt(total) - shares.reduce((a, s) => a + s, 0n);
  // Array.prototype.sort is stable, so equal remainders keep their order.
  const byRemainder = exact.map((e, i) => ({ i, r: e % sum })).sort((x, y) => (x.r === y.r ? 0 : x.r > y.r ? -1 : 1));
  for (const { i } of byRemainder) {
    if (left === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares.map(Number);
}
