/**
 * Invoices: lines, an invoice-wide discount and tax. The discount and the tax are computed
 * once on the totals and then split across the lines, so the lines always add up to the totals.
 */
import { allocate, isCents, percentOf } from "./money.js";

/** The most units a single line may bill. */
export const MAX_QTY = 10_000;

export interface InvoiceLine {
  readonly description: string;
  readonly unitPrice: number;
  readonly qty: number;
}

export interface InvoiceInput {
  readonly lines: readonly InvoiceLine[];
  readonly discountBps: number;
  readonly taxBps: number;
}

export interface BilledLine extends InvoiceLine {
  /** unitPrice × qty. */
  readonly amount: number;
  /** This line's part of the invoice discount. */
  readonly discount: number;
  /** This line's part of the invoice tax. */
  readonly tax: number;
  /** amount − discount + tax. */
  readonly total: number;
}

export interface Invoice {
  readonly lines: readonly BilledLine[];
  readonly subtotal: number;
  readonly discount: number;
  readonly tax: number;
  readonly total: number;
}

/** Splits `amount` like `weights`, or gives every line 0 when nothing is weighted. */
function spread(amount: number, weights: readonly number[]): number[] {
  return weights.some((w) => w > 0) ? allocate(amount, weights) : weights.map(() => 0);
}

/** Rates and the subtotal (at most MAX_CENTS) are checked by percentOf. */
export function buildInvoice(input: InvoiceInput): Invoice {
  for (const line of input.lines) {
    if (line.description.trim() === "") throw new RangeError("every line needs a description");
    if (!isCents(line.unitPrice)) throw new RangeError("unitPrice must be a whole amount between 0 and MAX_CENTS");
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) throw new RangeError("qty must be an integer between 1 and 10000");
  }

  const amounts = input.lines.map((l) => l.unitPrice * l.qty);
  const subtotal = amounts.reduce((a, b) => a + b, 0);

  const discount = percentOf(subtotal, input.discountBps);
  const tax = percentOf(subtotal - discount, input.taxBps);
  const discounts = spread(discount, amounts);
  const taxable = amounts.map((a, i) => a - (discounts[i] ?? 0));
  const taxes = spread(tax, taxable);

  const lines = input.lines.map((line, i): BilledLine => {
    const amount = amounts[i] ?? 0;
    const lineDiscount = discounts[i] ?? 0;
    const lineTax = taxes[i] ?? 0;
    return { ...line, amount, discount: lineDiscount, tax: lineTax, total: amount - lineDiscount + lineTax };
  });
  return { lines, subtotal, discount, tax, total: subtotal - discount + tax };
}
