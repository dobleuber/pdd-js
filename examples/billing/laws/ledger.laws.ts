/**
 * The spec for src/ledger.ts, written as a model: random sequences of operations run against
 * the real ledger and against the tiny reference below, and both must agree at every step.
 */
import { law, forAll, arb, type Arbitrary } from "@dobleuber/pdd";
import { MAX_CENTS } from "../src/money.js";
import { balance, deposit, emptyLedger, open, totalHeld, transfer, withdraw, type Ledger, type LedgerError, type Result } from "../src/ledger.js";

type Op =
  | { kind: "open"; id: string }
  | { kind: "deposit"; id: string; amount: number }
  | { kind: "withdraw"; id: string; amount: number }
  | { kind: "transfer"; from: string; to: string; amount: number };

/** Few ids, so operations often hit the same accounts. */
const arbId = arb.constantFrom("alice", "bob", "carol", "dave");
const arbAmount = arb.oneof(
  { weight: 6, arbitrary: arb.integer({ min: 1, max: 10_000 }) },
  { weight: 1, arbitrary: arb.constantFrom(0, -1, 0.5, Number.NaN, MAX_CENTS, MAX_CENTS + 1) },
);
const arbOp: Arbitrary<Op> = arb.oneof(
  arb.record({ kind: arb.constant("open" as const), id: arbId }),
  arb.record({ kind: arb.constant("deposit" as const), id: arbId, amount: arbAmount }),
  arb.record({ kind: arb.constant("withdraw" as const), id: arbId, amount: arbAmount }),
  arb.record({ kind: arb.constant("transfer" as const), from: arbId, to: arbId, amount: arbAmount }),
);
const arbOps = arb.array(arbOp, { maxLength: 60 });

/**
 * The reference: what each operation must do, checks in this order. Returns the error, or
 * null after applying the operation to `model`.
 */
function reference(model: Map<string, number>, op: Op): LedgerError | null {
  const ok = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= MAX_CENTS;
  switch (op.kind) {
    case "open":
      if (model.has(op.id)) return "duplicate-account";
      model.set(op.id, 0);
      return null;
    case "deposit": {
      const b = model.get(op.id);
      if (b === undefined) return "unknown-account";
      if (!ok(op.amount)) return "invalid-amount";
      if (b + op.amount > MAX_CENTS) return "limit-exceeded";
      model.set(op.id, b + op.amount);
      return null;
    }
    case "withdraw": {
      const b = model.get(op.id);
      if (b === undefined) return "unknown-account";
      if (!ok(op.amount)) return "invalid-amount";
      if (op.amount > b) return "insufficient-funds";
      model.set(op.id, b - op.amount);
      return null;
    }
    case "transfer": {
      const from = model.get(op.from);
      const to = model.get(op.to);
      if (from === undefined || to === undefined) return "unknown-account";
      if (op.from === op.to) return "same-account";
      if (!ok(op.amount)) return "invalid-amount";
      if (op.amount > from) return "insufficient-funds";
      if (to + op.amount > MAX_CENTS) return "limit-exceeded";
      model.set(op.from, from - op.amount);
      model.set(op.to, to + op.amount);
      return null;
    }
  }
}

function apply(ledger: Ledger, op: Op): Result {
  switch (op.kind) {
    case "open":
      return open(ledger, op.id);
    case "deposit":
      return deposit(ledger, op.id, op.amount);
    case "withdraw":
      return withdraw(ledger, op.id, op.amount);
    case "transfer":
      return transfer(ledger, op.from, op.to, op.amount);
  }
}

const IDS = ["alice", "bob", "carol", "dave"];
const sameBalances = (ledger: Ledger, model: ReadonlyMap<string, number>): boolean =>
  ledger.balances.size === model.size && IDS.every((id) => balance(ledger, id) === model.get(id));

/** Runs `ops`; returns every ledger along the way and whether each step matched the reference. */
function run(ops: readonly Op[]): { ledgers: Ledger[]; agreed: boolean } {
  const model = new Map<string, number>();
  let ledger = emptyLedger();
  const ledgers = [ledger];
  for (const op of ops) {
    const expected = reference(model, op);
    const r = apply(ledger, op);
    if (r.ok ? expected !== null : r.error !== expected) return { ledgers, agreed: false };
    if (r.ok) ledger = r.ledger;
    if (!sameBalances(ledger, model)) return { ledgers, agreed: false };
    ledgers.push(ledger);
  }
  return { ledgers, agreed: true };
}

law(
  "the ledger does exactly what the reference model does, step by step",
  forAll(arbOps, (ops) => run(ops).agreed),
);

/** Runs `ops` from an empty ledger and returns the last result. */
function last(...ops: Op[]): Result {
  let r: Result = { ok: true, ledger: emptyLedger() };
  for (const op of ops) {
    if (!r.ok) return r;
    r = apply(r.ledger, op);
  }
  return r;
}

const error = (r: Result): LedgerError | null => (r.ok ? null : r.error);

law(
  "an account holds up to MAX_CENTS, and not a cent more",
  forAll(arb.integer({ min: 1, max: MAX_CENTS - 1 }), (x) => {
    const full: Op[] = [
      { kind: "open", id: "alice" },
      { kind: "open", id: "bob" },
      { kind: "deposit", id: "alice", amount: MAX_CENTS - x },
      { kind: "deposit", id: "alice", amount: x },
      { kind: "deposit", id: "bob", amount: 1 },
    ];
    const r = last(...full);
    return (
      r.ok &&
      balance(r.ledger, "alice") === MAX_CENTS &&
      error(last(...full, { kind: "deposit", id: "alice", amount: 1 })) === "limit-exceeded" &&
      error(last(...full, { kind: "transfer", from: "bob", to: "alice", amount: 1 })) === "limit-exceeded" &&
      last(...full.slice(0, 3), { kind: "deposit", id: "bob", amount: x }, { kind: "transfer", from: "bob", to: "alice", amount: x }).ok
    );
  }),
);

law(
  "the whole balance can be withdrawn or transferred, but not a cent more",
  // x + 1 stays a valid amount, so the only reason to refuse it is the balance.
  forAll(arb.integer({ min: 1, max: MAX_CENTS - 1 }), (x) => {
    const funded: Op[] = [
      { kind: "open", id: "alice" },
      { kind: "open", id: "bob" },
      { kind: "deposit", id: "alice", amount: x },
    ];
    const out = last(...funded, { kind: "withdraw", id: "alice", amount: x });
    const moved = last(...funded, { kind: "transfer", from: "alice", to: "bob", amount: x });
    return (
      out.ok &&
      balance(out.ledger, "alice") === 0 &&
      moved.ok &&
      balance(moved.ledger, "alice") === 0 &&
      balance(moved.ledger, "bob") === x &&
      error(last(...funded, { kind: "withdraw", id: "alice", amount: x + 1 })) === "insufficient-funds" &&
      error(last(...funded, { kind: "transfer", from: "alice", to: "bob", amount: x + 1 })) === "insufficient-funds"
    );
  }),
);

law(
  "an amount that is not a positive whole number of cents is refused, whatever the operation",
  forAll(arb.constantFrom(0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_CENTS + 1), (amount) => {
    const ready: Op[] = [
      { kind: "open", id: "alice" },
      { kind: "open", id: "bob" },
      { kind: "deposit", id: "alice", amount: 1_000 },
    ];
    return (
      error(last(...ready, { kind: "deposit", id: "alice", amount })) === "invalid-amount" &&
      error(last(...ready, { kind: "withdraw", id: "alice", amount })) === "invalid-amount" &&
      error(last(...ready, { kind: "transfer", from: "alice", to: "bob", amount })) === "invalid-amount"
    );
  }),
);

law(
  "money only appears through deposits and leaves through withdrawals",
  forAll(arbOps, (ops) => {
    let ledger = emptyLedger();
    let expected = 0;
    for (const op of ops) {
      const r = apply(ledger, op);
      if (!r.ok) continue;
      ledger = r.ledger;
      if (op.kind === "deposit") expected += op.amount;
      if (op.kind === "withdraw") expected -= op.amount;
      if (totalHeld(ledger) !== expected) return false;
    }
    return true;
  }),
);

law(
  "no balance is ever negative or above MAX_CENTS",
  forAll(arbOps, (ops) => run(ops).ledgers.every((l) => [...l.balances.values()].every((b) => Number.isSafeInteger(b) && b >= 0 && b <= MAX_CENTS))),
);

law(
  "operations never change an earlier ledger",
  forAll(arbOps, (ops) => {
    const snapshots: Array<[Ledger, string]> = [];
    let ledger = emptyLedger();
    for (const op of ops) {
      snapshots.push([ledger, JSON.stringify([...ledger.balances])]);
      const r = apply(ledger, op);
      if (r.ok) ledger = r.ledger;
    }
    return snapshots.every(([l, snap]) => JSON.stringify([...l.balances]) === snap);
  }),
);
