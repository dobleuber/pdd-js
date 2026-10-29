# example-billing

A subscription billing engine, larger than [shopping-cart](../shopping-cart). The code in
`src/` is what an agent would write; the laws in `laws/` are the human's spec, locked in
`pdd.lock.json`.

| Module | What it does | How its laws check it |
|---|---|---|
| `src/money.ts` | Rounding, percentages in basis points, formatting and parsing amounts, splitting cents with the largest-remainder method | Rounding and percentages are **proven** by Z3. Text round-trips. Allocation adds up exactly, gives the left-over cents to the largest remainders, and breaks ties by order |
| `src/pricing.ts` | Tiered usage pricing, proration, plan changes | Every law is **proven** by Z3 across modules (`pricing` calls `money`). Example: "one bill for all the usage never costs more than two bills" |
| `src/invoice.ts` | Lines, discount and tax, split back across the lines | The lines add up to the totals. Each line gets its fair share to within a cent. The order of the lines does not change the totals |
| `src/ledger.ts` | Prepaid balances: open, deposit, withdraw, transfer | **Model-based**: random sequences of up to 60 operations are run against the ledger and against a reference written in the law file, and both must agree at every step |

```bash
pnpm --filter example-billing exec pdd check      # 55 laws
pnpm --filter example-billing exec pdd smt        # 16 laws proven for every input
pnpm --filter example-billing exec pdd coverage   # fails if an export is not reached (failOnUncovered)
pnpm --filter example-billing exec pdd mutate     # fails below 90 % (thresholds.break)
```

## What the first runs found

- **`pdd smt`** could not decide the first version of the "split a period in two" law: a `%` by
  a variable divisor is too nonlinear for Z3 in 10 s. A simpler law with the same intent was
  proven in 250 ms.
- **`pdd mutate`** scored 67 % against the first draft of the laws. Most of the surviving
  mutants pointed at real gaps:
  - nothing checked that `usageCharge` and `prorate` reject bad input;
  - no law pinned the boundaries (an account holding exactly `MAX_CENTS`, withdrawing the whole
    balance, `qty === MAX_QTY`, formatting `0`, parsing `"-0.00"`);
  - no law said *which* line gets a left-over cent;
  - uniform sampling over a billion units almost never lands near a pricing tier.
  
  The rest were checks in `invoice.ts` that repeated what `percentOf` already does, so they were
  removed. After the laws were strengthened the score is 98 %, with 5 survivors left.
- **`pdd check`** caught a wrong law along the way. It claimed that withdrawing `MAX_CENTS + 1`
  fails with `insufficient-funds`, but that amount is first an `invalid-amount`. The spec was
  fixed, not the code.

The 5 surviving mutants are equivalent: they change the code but not its behaviour.

- `daysInPeriod < 1 → false` in `prorate` changes nothing. A period of 0 or less still fails,
  either on the `days > daysInPeriod` check or in `roundDiv`.
- The two in `allocate`'s sort comparator only change how ties are compared. `sort` is stable,
  so equal remainders keep their order anyway.
