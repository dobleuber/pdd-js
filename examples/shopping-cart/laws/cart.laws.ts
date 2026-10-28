/**
 * The spec for src/cart.ts, written by a human. The agent's job is to make
 * `pdd check` pass without touching this folder.
 */
import { law, forAll } from "pdd";
import { addItem, applyDiscount, createCart, itemCount, removeItem, total, type LineItem } from "../src/cart.js";
import { arbCart, arbItems, arbLineItem, arbPercent, arbSku } from "./arbitraries.js";

const lineTotal = (items: readonly LineItem[]): number => items.reduce((s, i) => s + i.price * i.qty, 0);

law(
  "an empty cart costs nothing, whatever the discount",
  forAll(arbPercent, (p) => total(createCart()) === 0 && applyDiscount(createCart(), p) === 0),
);

law(
  "the total is the sum of price × qty of every line",
  forAll(arbItems, (items) => total(items.reduce(addItem, createCart())) === lineTotal(items)),
);

law(
  "adding an item raises the total by exactly price × qty",
  forAll(arbCart, arbLineItem, (cart, item) => total(addItem(cart, item)) === total(cart) + item.price * item.qty),
);

law(
  "removing a sku drops exactly its lines",
  forAll(arbCart, arbSku, (cart, sku) => {
    const after = removeItem(cart, sku);
    const dropped = lineTotal(cart.items.filter((i) => i.sku === sku));
    return total(after) === total(cart) - dropped && after.items.every((i) => i.sku !== sku);
  }),
);

law(
  "the item count is the sum of quantities",
  forAll(arbItems, (items) => itemCount(items.reduce(addItem, createCart())) === items.reduce((n, i) => n + i.qty, 0)),
);

law(
  "a discount never makes the total negative or larger",
  forAll(arbCart, arbPercent, (cart, p) => {
    const discounted = applyDiscount(cart, p);
    return discounted >= 0 && discounted <= total(cart);
  }),
);

law(
  "0% keeps the total and 100% makes it free",
  forAll(arbCart, (cart) => applyDiscount(cart, 0) === total(cart) && applyDiscount(cart, 100) === 0),
);

law(
  "adding an item never changes the original cart",
  forAll(arbCart, arbLineItem, (cart, item) => {
    const before = cart.items.length;
    addItem(cart, item);
    return cart.items.length === before;
  }),
);
