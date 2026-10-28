/** A tiny shopping cart. Prices are integer cents. This is the code the agent writes. */

export interface LineItem {
  readonly sku: string;
  readonly price: number;
  readonly qty: number;
}

export interface Cart {
  readonly items: readonly LineItem[];
}

export function createCart(): Cart {
  return { items: [] };
}

export function addItem(cart: Cart, item: LineItem): Cart {
  if (!Number.isInteger(item.price) || item.price < 0) throw new RangeError("price must be a non-negative integer (cents)");
  if (!Number.isInteger(item.qty) || item.qty < 1) throw new RangeError("qty must be a positive integer");
  return { items: [...cart.items, { ...item }] };
}

export function removeItem(cart: Cart, sku: string): Cart {
  return { items: cart.items.filter((i) => i.sku !== sku) };
}

export function total(cart: Cart): number {
  return cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function itemCount(cart: Cart): number {
  return cart.items.reduce((n, i) => n + i.qty, 0);
}

/** Total after a whole-percent discount, rounded in the customer's favour. */
export function applyDiscount(cart: Cart, percent: number): number {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError("percent must be an integer between 0 and 100");
  }
  const t = total(cart);
  return t - Math.ceil((t * percent) / 100);
}
