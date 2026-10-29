/**
 * Customer balances (prepaid credit). Immutable: every operation returns a new ledger, and a
 * failed operation returns the reason instead of throwing.
 */
import { isCents, MAX_CENTS } from "./money.js";

export interface Ledger {
  readonly balances: ReadonlyMap<string, number>;
}

export type LedgerError = "unknown-account" | "duplicate-account" | "invalid-amount" | "insufficient-funds" | "limit-exceeded" | "same-account";

export type Result = { readonly ok: true; readonly ledger: Ledger } | { readonly ok: false; readonly error: LedgerError };

const fail = (error: LedgerError): Result => ({ ok: false, error });

function withBalances(ledger: Ledger, changes: ReadonlyArray<readonly [string, number]>): Result {
  const balances = new Map(ledger.balances);
  for (const [id, value] of changes) balances.set(id, value);
  return { ok: true, ledger: { balances } };
}

/** A positive whole amount of cents. */
const validAmount = (amount: number): boolean => isCents(amount) && amount > 0;

export function emptyLedger(): Ledger {
  return { balances: new Map() };
}

export function balance(ledger: Ledger, id: string): number | undefined {
  return ledger.balances.get(id);
}

/** Money held across every account. */
export function totalHeld(ledger: Ledger): number {
  let sum = 0;
  for (const value of ledger.balances.values()) sum += value;
  return sum;
}

export function open(ledger: Ledger, id: string): Result {
  if (ledger.balances.has(id)) return fail("duplicate-account");
  return withBalances(ledger, [[id, 0]]);
}

export function deposit(ledger: Ledger, id: string, amount: number): Result {
  const current = ledger.balances.get(id);
  if (current === undefined) return fail("unknown-account");
  if (!validAmount(amount)) return fail("invalid-amount");
  if (current + amount > MAX_CENTS) return fail("limit-exceeded");
  return withBalances(ledger, [[id, current + amount]]);
}

export function withdraw(ledger: Ledger, id: string, amount: number): Result {
  const current = ledger.balances.get(id);
  if (current === undefined) return fail("unknown-account");
  if (!validAmount(amount)) return fail("invalid-amount");
  if (amount > current) return fail("insufficient-funds");
  return withBalances(ledger, [[id, current - amount]]);
}

export function transfer(ledger: Ledger, from: string, to: string, amount: number): Result {
  const source = ledger.balances.get(from);
  const target = ledger.balances.get(to);
  if (source === undefined || target === undefined) return fail("unknown-account");
  if (from === to) return fail("same-account");
  if (!validAmount(amount)) return fail("invalid-amount");
  if (amount > source) return fail("insufficient-funds");
  if (target + amount > MAX_CENTS) return fail("limit-exceeded");
  return withBalances(ledger, [
    [from, source - amount],
    [to, target + amount],
  ]);
}
