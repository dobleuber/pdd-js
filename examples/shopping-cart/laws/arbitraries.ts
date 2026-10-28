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
