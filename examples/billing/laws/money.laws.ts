/**
 * The spec for src/money.ts. Laws marked { smt: true } are proven for every input by
 * `pdd smt`; `pdd check` also tests them like any other law.
 */
import { law, forAll, arb } from "pdd";
import { allocate, formatCents, MAX_BPS, MAX_CENTS, parseCents, percentOf, roundDiv } from "../src/money.js";
import { abs, arbBps, arbCents, rejects, sum } from "./support.js";

// --- rounding ---------------------------------------------------------------------------

law(
  "roundDiv is the nearest integer, halves rounded up",
  // q is nearest to a / b, halves up, exactly when q − ½ ≤ a / b < q + ½.
  forAll(arb.integer({ min: 0, max: 1_000_000_000_000_000 }), arb.integer({ min: 1, max: 1_000_000 }), (a, b) => {
    const q = roundDiv(a, b);
    return (2 * q - 1) * b <= 2 * a && 2 * a < (2 * q + 1) * b;
  }),
  { smt: true },
);

law(
  "a percentage of an amount is never negative or larger than the amount",
  forAll(arbCents, arbBps, (cents, bps) => {
    const p = percentOf(cents, bps);
    return p >= 0 && p <= cents;
  }),
  { smt: true },
);

law(
  "a percentage is the exact value rounded to the nearest cent, halves up",
  forAll(arbCents, arbBps, (cents, bps) => {
    const error = percentOf(cents, bps) * MAX_BPS - cents * bps; // in 1/10 000 of a cent
    return -5_000 < error && error <= 5_000;
  }),
  { smt: true },
);

law(
  "0 % of an amount is nothing and 100 % is all of it",
  forAll(arbCents, (cents) => percentOf(cents, 0) === 0 && percentOf(cents, MAX_BPS) === cents),
  { smt: true },
);

law(
  "roundDiv rejects a negative or fractional dividend and a divisor that is not positive",
  forAll(arb.integer({ min: 0, max: 1_000_000 }), arb.integer({ min: 1, max: 1_000 }), (a, b) =>
    [
      () => roundDiv(-1 - a, b),
      () => roundDiv(a + 0.5, b),
      () => roundDiv(2 ** 53 + a, b),
      () => roundDiv(a, 0),
      () => roundDiv(a, -b),
      () => roundDiv(a, b + 0.5),
      () => roundDiv(a, 2 ** 53 + b),
    ].every(rejects),
  ),
);

law(
  "amounts and rates out of range are rejected",
  forAll(arbCents, arbBps, arb.integer({ min: 1, max: 1_000 }), (cents, bps, k) =>
    [
      () => percentOf(-k, bps),
      () => percentOf(MAX_CENTS + k, bps),
      () => percentOf(cents + 0.5, bps),
      () => percentOf(cents, -k),
      () => percentOf(cents, MAX_BPS + k),
      () => percentOf(cents, Math.min(bps, MAX_BPS - 1) + 0.5),
    ].every(rejects),
  ),
);

// --- text -------------------------------------------------------------------------------

/** Edge cases first, then any safe integer. */
const arbAnyCents = arb.oneof(arb.constantFrom(0, 1, -1, 99, 100, -100, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER), arb.maxSafeInteger());

law(
  "parsing a formatted amount gives the amount back",
  forAll(arbAnyCents, (cents) => parseCents(formatCents(cents)) === cents),
);

law(
  "formatted amounts have no leading zeros, exactly two decimals, and no -0",
  forAll(arbAnyCents, (cents) => /^-?(0|[1-9]\d*)\.\d{2}$/.test(formatCents(cents)) && formatCents(cents) !== "-0.00"),
);

law(
  "formatting rejects anything but a safe integer",
  forAll(arb.constantFrom(0.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53)), (bad) => rejects(() => formatCents(bad))),
);

law(
  "parsing reads units and cents, with or without leading zeros",
  forAll(
    arb.boolean(),
    arb.oneof(arb.constant(0), arb.nat({ max: 10_000_000 })),
    arb.oneof(arb.constant(0), arb.integer({ min: 0, max: 99 })),
    arb.nat({ max: 3 }),
    (negative, units, cents, zeros) => {
    const text = `${negative ? "-" : ""}${"0".repeat(zeros)}${units}.${String(cents).padStart(2, "0")}`;
    const value = units * 100 + cents;
      return parseCents(text) === (negative && value !== 0 ? -value : value) && !Object.is(parseCents(text), -0);
    },
  ),
);

law(
  "parsing rejects amounts beyond Number.MAX_SAFE_INTEGER cents",
  forAll(arb.oneof(arb.constant(0), arb.nat({ max: 1_000_000 })), (k) => {
    const v = BigInt(Number.MAX_SAFE_INTEGER) + 1n + BigInt(k);
    return rejects(() => parseCents(`${v / 100n}.${String(v % 100n).padStart(2, "0")}`));
  }),
);

law(
  "anything but digits, a dot and exactly two decimals is rejected",
  forAll(
    arb.oneof(
      arb.constantFrom("", "1", "1.", ".50", "1.5", "1.234", "1,00", "$1.00", " 1.00", "1.00 ", "--1.00", "+1.00", "1e2.00", "١.٠٠", "0x1.00"),
      arb.string().filter((s) => !/^-?\d+\.\d{2}$/.test(s)),
    ),
    (text) => rejects(() => parseCents(text)),
  ),
);

// --- allocation -------------------------------------------------------------------------

const arbWeights = arb.array(arb.oneof(arb.constant(0), arb.integer({ min: 1, max: 1_000 }), arb.integer({ min: 1, max: MAX_CENTS })), {
  minLength: 1,
  maxLength: 12,
});
const arbPositiveWeights = arbWeights.filter((ws) => ws.some((w) => w > 0));

law(
  "allocated shares add up exactly to the total",
  forAll(arbCents, arbPositiveWeights, (total, weights) => sum(allocate(total, weights)) === total),
);

law(
  "every share is its exact proportion rounded down or up",
  forAll(arbCents, arbPositiveWeights, (total, weights) => {
    const shares = allocate(total, weights);
    const W = BigInt(sum(weights));
    return shares.length === weights.length && shares.every((s, i) => abs(BigInt(s) * W - BigInt(total) * BigInt(weights[i] ?? 0)) < W);
  }),
);

law(
  "left-over cents go to the largest remainders, and ties to the earlier weight",
  // A share rounded up must not have a smaller remainder than one rounded down (or an equal one, later).
  forAll(arbCents, arbPositiveWeights, (total, weights) => {
    const shares = allocate(total, weights);
    const W = BigInt(sum(weights));
    const parts = weights.map((w, i) => {
      const exact = BigInt(total) * BigInt(w);
      return { i, rem: exact % W, up: BigInt(shares[i] ?? 0) > exact / W };
    });
    return parts.every((u) => !u.up || parts.every((d) => d.up || d.rem < u.rem || (d.rem === u.rem && u.i < d.i)));
  }),
);

law(
  "a zero weight gets nothing",
  forAll(arbCents, arbPositiveWeights, (total, weights) => allocate(total, weights).every((s, i) => weights[i] !== 0 || s === 0)),
);

law(
  "equal weights get equal shares, and the left-over cents go to the first ones",
  forAll(arbCents, arb.integer({ min: 1, max: 12 }), arb.integer({ min: 1, max: 1_000 }), (total, n, w) => {
    const shares = allocate(total, Array.from({ length: n }, () => w));
    return shares.every((s, i) => s === Math.floor(total / n) + (i < total % n ? 1 : 0));
  }),
);

law(
  "scaling every weight by the same factor changes nothing",
  forAll(arbCents, arb.array(arb.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 12 }), arb.integer({ min: 2, max: 1_000 }), (total, ws, k) => {
    if (ws.every((w) => w === 0)) return true;
    const a = allocate(total, ws);
    const b = allocate(
      total,
      ws.map((w) => w * k),
    );
    return a.every((s, i) => s === b[i]);
  }),
);

law(
  "allocating with no weight, only zero weights, a bad weight or a bad total is rejected",
  forAll(arbCents, arb.integer({ min: 1, max: 12 }), (total, n) => {
    const zeros = Array.from({ length: n }, () => 0);
    return (
      rejects(() => allocate(total, [])) &&
      rejects(() => allocate(total, zeros)) &&
      rejects(() => allocate(total, [...zeros, 5, -1])) &&
      rejects(() => allocate(total, [...zeros, 1.5])) &&
      rejects(() => allocate(total, [...zeros, 1, 2 ** 60])) &&
      rejects(() => allocate(-1 - total, [1])) &&
      rejects(() => allocate(total + 0.5, [1]))
    );
  }),
);
