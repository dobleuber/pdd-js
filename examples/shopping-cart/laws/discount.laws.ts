/**
 * Laws for the discount arithmetic, proven for EVERY input with `pdd smt` (Z3), not only
 * for the cases `pdd check` samples. `pdd check` still tests them like any other law.
 */
import { law, forAll, arb } from "@dobleuber/pdd";
import { discounted } from "../src/cart.js";
import { arbPercent } from "./arbitraries.js";

/** Totals up to ten million euros, in cents. */
const arbTotal = arb.integer({ min: 0, max: 1_000_000_000 });

law(
  "a discount never makes a total negative or larger",
  forAll(arbTotal, arbPercent, (t, p) => {
    const d = discounted(t, p);
    return d >= 0 && d <= t;
  }),
  { smt: true },
);

law(
  "the discounted total is the exact price rounded down to the cent",
  // 100 × d is at most the exact price × 100, and less than one cent below it.
  forAll(arbTotal, arbPercent, (t, p) => {
    const exact100 = t * (100 - p);
    const d100 = discounted(t, p) * 100;
    return d100 <= exact100 && exact100 - d100 < 100;
  }),
  { smt: true },
);

law(
  "0% keeps the total and 100% makes it free",
  forAll(arbTotal, (t) => discounted(t, 0) === t && discounted(t, 100) === 0),
  { smt: true },
);
