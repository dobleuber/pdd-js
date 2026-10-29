/** The spec for src/invoice.ts. */
import { law, forAll, arb, type Arbitrary } from "pdd";
import { buildInvoice, MAX_QTY, type InvoiceInput, type InvoiceLine } from "../src/invoice.js";
import { MAX_BPS, MAX_CENTS } from "../src/money.js";
import { abs, arbBadBps, arbCommonBps, rejects, sum } from "./support.js";

const arbLine: Arbitrary<InvoiceLine> = arb.record({
  description: arb.oneof(arb.constantFrom("Pro plan", "Extra seats", "Storage", "Support"), arb.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}$/)),
  unitPrice: arb.oneof(arb.constant(0), arb.integer({ min: 1, max: 1_000_000 })),
  qty: arb.oneof(arb.constant(1), arb.integer({ min: 1, max: 100 })),
});

const arbInput: Arbitrary<InvoiceInput> = arb.record({
  lines: arb.array(arbLine, { maxLength: 20 }),
  discountBps: arbCommonBps,
  taxBps: arbCommonBps,
});

law(
  "the lines add up to the invoice totals",
  forAll(arbInput, (input) => {
    const inv = buildInvoice(input);
    const of = (pick: (l: (typeof inv.lines)[number]) => number): number => sum(inv.lines.map(pick));
    return inv.subtotal === of((l) => l.amount) && inv.discount === of((l) => l.discount) && inv.tax === of((l) => l.tax) && inv.total === of((l) => l.total);
  }),
);

law(
  "each line keeps its data, costs unit price × qty, and totals amount − discount + tax",
  forAll(arbInput, (input) => {
    const inv = buildInvoice(input);
    return (
      inv.lines.length === input.lines.length &&
      inv.lines.every((l, i) => {
        const src = input.lines[i];
        return (
          src !== undefined &&
          l.description === src.description &&
          l.unitPrice === src.unitPrice &&
          l.qty === src.qty &&
          l.amount === src.unitPrice * src.qty &&
          l.total === l.amount - l.discount + l.tax
        );
      })
    );
  }),
);

law(
  "the discount is the exact rate of the subtotal, to the nearest cent",
  forAll(arbInput, (input) => {
    const inv = buildInvoice(input);
    const error = inv.discount * MAX_BPS - inv.subtotal * input.discountBps;
    return -5_000 < error && error <= 5_000;
  }),
);

law(
  "tax is charged on the discounted subtotal, to the nearest cent",
  forAll(arbInput, (input) => {
    const inv = buildInvoice(input);
    const error = inv.tax * MAX_BPS - (inv.subtotal - inv.discount) * input.taxBps;
    return -5_000 < error && error <= 5_000 && inv.total === inv.subtotal - inv.discount + inv.tax;
  }),
);

law(
  "no line gets a discount larger than its amount, and no total is negative",
  forAll(arbInput, (input) => buildInvoice(input).lines.every((l) => l.discount >= 0 && l.discount <= l.amount && l.tax >= 0 && l.total >= 0)),
);

law(
  "each line's discount and tax are within a cent of its fair share",
  forAll(arbInput, (input) => {
    const inv = buildInvoice(input);
    const S = BigInt(inv.subtotal);
    const T = BigInt(inv.subtotal - inv.discount);
    return inv.lines.every(
      (l) =>
        (S === 0n || abs(BigInt(l.discount) * S - BigInt(inv.discount) * BigInt(l.amount)) < S) &&
        (T === 0n || abs(BigInt(l.tax) * T - BigInt(inv.tax) * BigInt(l.amount - l.discount)) < T),
    );
  }),
);

law(
  "free lines carry no discount and no tax",
  forAll(arbInput, (input) => buildInvoice(input).lines.every((l) => l.amount !== 0 || (l.discount === 0 && l.tax === 0))),
);

law(
  "the order of the lines does not change the totals",
  forAll(arbInput, (input) => {
    const a = buildInvoice(input);
    const b = buildInvoice({ ...input, lines: [...input.lines].reverse() });
    return a.subtotal === b.subtotal && a.discount === b.discount && a.tax === b.tax && a.total === b.total;
  }),
);

law(
  "no discount and no tax bill exactly the subtotal",
  forAll(arbInput, (input) => {
    const inv = buildInvoice({ ...input, discountBps: 0, taxBps: 0 });
    return inv.total === inv.subtotal && inv.lines.every((l) => l.total === l.amount);
  }),
);

law(
  "an invoice without lines is zero",
  forAll(arbCommonBps, arbCommonBps, (discountBps, taxBps) => {
    const inv = buildInvoice({ lines: [], discountBps, taxBps });
    return inv.lines.length === 0 && inv.subtotal === 0 && inv.discount === 0 && inv.tax === 0 && inv.total === 0;
  }),
);

law(
  "building an invoice does not modify its input",
  forAll(arbInput, (input) => {
    const before = JSON.stringify(input);
    buildInvoice(input);
    return JSON.stringify(input) === before;
  }),
);

law(
  "bad lines and bad rates are rejected",
  forAll(arbInput, arbLine, arbBadBps, (input, line, bad) => {
    const withLine = (l: InvoiceLine): InvoiceInput => ({ ...input, lines: [...input.lines, l] });
    return (
      rejects(() => buildInvoice({ ...input, discountBps: bad })) &&
      rejects(() => buildInvoice({ ...input, taxBps: bad })) &&
      rejects(() => buildInvoice(withLine({ ...line, unitPrice: -1 - line.unitPrice }))) &&
      rejects(() => buildInvoice(withLine({ ...line, unitPrice: line.unitPrice + 0.5 }))) &&
      rejects(() => buildInvoice(withLine({ ...line, qty: 0 }))) &&
      rejects(() => buildInvoice(withLine({ ...line, qty: line.qty + 0.5 }))) &&
      rejects(() => buildInvoice(withLine({ ...line, qty: MAX_QTY + 1 }))) &&
      rejects(() => buildInvoice(withLine({ ...line, description: " " })))
    );
  }),
);

law(
  "the largest line and the largest invoice are accepted",
  forAll(arb.integer({ min: 1, max: 1_000 }), (unitPrice) => {
    const big = buildInvoice({ lines: [{ description: "Bulk", unitPrice, qty: MAX_QTY }], discountBps: 0, taxBps: 0 });
    const top = buildInvoice({ lines: [{ description: "All", unitPrice: MAX_CENTS, qty: 1 }], discountBps: 0, taxBps: 0 });
    return big.total === unitPrice * MAX_QTY && top.total === MAX_CENTS;
  }),
);

law(
  "an invoice above MAX_CENTS is rejected",
  forAll(arbInput, (input) => {
    const huge: InvoiceLine = { description: "Huge", unitPrice: MAX_CENTS, qty: 1 };
    return rejects(() => buildInvoice({ ...input, lines: [...input.lines, huge, { ...huge, unitPrice: 1 }] }));
  }),
);
