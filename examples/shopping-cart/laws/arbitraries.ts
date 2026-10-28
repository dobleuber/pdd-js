/** Generators for the laws. Human-owned and locked, like the laws themselves. */
import { arb, type Arbitrary } from "pdd";
import { addItem, createCart, type Cart, type LineItem } from "../src/cart.js";

/** A few fixed SKUs so carts often repeat one, plus random ones. */
export const arbSku: Arbitrary<string> = arb.oneof(arb.constantFrom("AAA", "BBB", "CCC"), arb.stringMatching(/^[A-Z]{3}$/));

export const arbLineItem: Arbitrary<LineItem> = arb.record({
  sku: arbSku,
  price: arb.integer({ min: 0, max: 100_000 }),
  qty: arb.integer({ min: 1, max: 20 }),
});

export const arbItems: Arbitrary<LineItem[]> = arb.array(arbLineItem, { maxLength: 30 });

export const arbCart: Arbitrary<Cart> = arbItems.map((items) => items.reduce(addItem, createCart()));

export const arbPercent: Arbitrary<number> = arb.integer({ min: 0, max: 100 });

/** Prices a cart must reject: negative, or not a whole number of cents. */
export const arbBadPrice: Arbitrary<number> = arb.oneof(
  arb.integer({ min: -100_000, max: -1 }),
  arb.integer({ min: 0, max: 100_000 }).map((n) => n + 0.5),
);

/** Quantities a cart must reject: below 1, or fractional. */
export const arbBadQty: Arbitrary<number> = arb.oneof(
  arb.integer({ min: -20, max: 0 }),
  arb.integer({ min: 1, max: 20 }).map((n) => n + 0.5),
);

/** Discounts that must be rejected: below 0, above 100, or fractional. */
export const arbBadPercent: Arbitrary<number> = arb.oneof(
  arb.integer({ min: -1_000, max: -1 }),
  arb.integer({ min: 101, max: 1_000 }),
  arb.integer({ min: 0, max: 99 }).map((n) => n + 0.5),
);
