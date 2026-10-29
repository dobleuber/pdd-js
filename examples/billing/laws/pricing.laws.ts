/**
 * The spec for src/pricing.ts. Every law is proven for every input by `pdd smt`
 * (and tested like any other law by `pdd check`).
 */
import { law, forAll, arb } from "@dobleuber/pdd";
import { rejects } from "./support.js";
import { MAX_CENTS } from "../src/money.js";
import { MAX_DAYS, MAX_UNITS, planChange, prorate, TIER1_PRICE, TIER1_UNITS, TIER2_PRICE, TIER2_UNITS, TIER3_PRICE, usageCharge } from "../src/pricing.js";

/** Any usage, with extra weight around the tier boundaries (random sampling rarely lands there). */
const arbUnits = arb.oneof(arb.integer({ min: 0, max: 2 * TIER2_UNITS }), arb.integer({ min: 0, max: MAX_UNITS }));
const arbPrice = arb.integer({ min: 0, max: MAX_CENTS });
const arbPeriod = arb.integer({ min: 1, max: MAX_DAYS });
/** Clamped to the period inside each law, so every (days, period) pair is valid. */
const arbDays = arb.integer({ min: 0, max: MAX_DAYS });

// --- usage tiers ------------------------------------------------------------------------

law(
  "no usage is free, and each extra unit costs the price of the tier it falls in",
  // Together these pin usageCharge down completely (by induction on the units).
  forAll(arb.oneof(arb.integer({ min: 0, max: 2 * TIER2_UNITS }), arb.integer({ min: 0, max: MAX_UNITS - 1 })), (u) => {
    const tierPrice = u < TIER1_UNITS ? TIER1_PRICE : u < TIER2_UNITS ? TIER2_PRICE : TIER3_PRICE;
    return usageCharge(0) === 0 && usageCharge(u + 1) - usageCharge(u) === tierPrice;
  }),
  { smt: true },
);

law(
  "more usage never costs less",
  forAll(arbUnits, arbUnits, (a, b) => usageCharge(Math.min(a, b)) <= usageCharge(Math.max(a, b))),
  { smt: true },
);

law(
  "one bill for all the usage never costs more than two bills for parts of it",
  forAll(arb.integer({ min: 0, max: 500_000_000 }), arb.integer({ min: 0, max: 500_000_000 }), (a, b) => usageCharge(a + b) <= usageCharge(a) + usageCharge(b)),
  { smt: true },
);

law(
  "the average unit price stays between the cheapest and the dearest tier",
  forAll(arbUnits, (u) => TIER3_PRICE * u <= usageCharge(u) && usageCharge(u) <= TIER1_PRICE * u),
  { smt: true },
);

law(
  "usage that is negative, fractional or above MAX_UNITS is rejected",
  forAll(arb.integer({ min: 1, max: 1_000 }), arb.integer({ min: 0, max: MAX_UNITS - 1 }), (k, u) =>
    [() => usageCharge(-k), () => usageCharge(u + 0.5), () => usageCharge(MAX_UNITS + k)].every(rejects) && usageCharge(MAX_UNITS) > 0,
  ),
);

// --- proration --------------------------------------------------------------------------

law(
  "a prorated price is never negative or more than the full price",
  forAll(arbPrice, arbDays, arbPeriod, (price, days, period) => {
    const p = prorate(price, Math.min(days, period), period);
    return p >= 0 && p <= price;
  }),
  { smt: true },
);

law(
  "the whole period costs the full price and no days cost nothing",
  forAll(arbPrice, arbPeriod, (price, period) => prorate(price, period, period) === price && prorate(price, 0, period) === 0),
  { smt: true },
);

law(
  "a prorated price is the exact share rounded to the nearest cent, halves up",
  forAll(arbPrice, arbDays, arbPeriod, (price, days, period) => {
    const d = Math.min(days, period);
    const error = 2 * (prorate(price, d, period) * period - price * d); // in 1/(2 × period) of a cent
    return -period < error && error <= period;
  }),
  { smt: true },
);

law(
  "more days never cost less",
  forAll(arbPrice, arbDays, arbDays, arbPeriod, (price, a, b, period) => {
    const lo = Math.min(a, b, period);
    const hi = Math.min(Math.max(a, b), period);
    return prorate(price, lo, period) <= prorate(price, hi, period);
  }),
  { smt: true },
);

law(
  "splitting a period in two costs the full price, or at most one cent more",
  forAll(arbPrice, arbDays, arbPeriod, (price, days, period) => {
    const d = Math.min(days, period);
    const both = prorate(price, d, period) + prorate(price, period - d, period);
    return both === price || both === price + 1; // one more when both halves round up from exactly ½ cent
  }),
  { smt: true },
);

law(
  "a bad price, period or number of days is rejected",
  forAll(arbPrice, arbDays, arbPeriod, arb.integer({ min: 1, max: 1_000 }), (price, days, period, k) => {
    const d = Math.min(days, period);
    return [
      () => prorate(-k, d, period),
      () => prorate(MAX_CENTS + k, d, period),
      () => prorate(price + 0.5, d, period),
      () => prorate(price, d, 1 - k),
      () => prorate(price, d, MAX_DAYS + k),
      () => prorate(price, Math.min(d, period - 1), period - 0.5),
      () => prorate(price, -k, period),
      // At price 0, roundDiv sees -0 and would not catch a negative day count by itself.
      () => prorate(0, -k, period),
      () => prorate(price, period + k, period),
      () => prorate(price, Math.min(d, period - 1) + 0.5, period),
    ].every(rejects);
  }),
);

law(
  "the extremes are accepted: no or every day of a 1-day or 366-day period, at the highest price",
  forAll(arb.constantFrom(1, MAX_DAYS), (period) => prorate(MAX_CENTS, period, period) === MAX_CENTS && prorate(MAX_CENTS, 0, period) === 0),
);

// --- plan changes -----------------------------------------------------------------------

law(
  "staying on the same plan costs nothing",
  forAll(arbPrice, arbDays, arbPeriod, (price, days, period) => planChange(price, price, Math.min(days, period), period).net === 0),
  { smt: true },
);

law(
  "an upgrade never refunds and a downgrade never charges",
  forAll(arbPrice, arbPrice, arbDays, arbPeriod, (oldPrice, newPrice, days, period) => {
    const { net } = planChange(oldPrice, newPrice, Math.min(days, period), period);
    return oldPrice <= newPrice ? net >= 0 : net <= 0;
  }),
  { smt: true },
);

law(
  "a plan change never moves more money than the price difference",
  forAll(arbPrice, arbPrice, arbDays, arbPeriod, (oldPrice, newPrice, days, period) => {
    const { credit, charge, net } = planChange(oldPrice, newPrice, Math.min(days, period), period);
    return net === charge - credit && Math.abs(net) <= Math.abs(newPrice - oldPrice) && credit <= oldPrice && charge <= newPrice;
  }),
  { smt: true },
);
