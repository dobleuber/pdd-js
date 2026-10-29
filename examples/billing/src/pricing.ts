/**
 * Prices: metered usage with volume tiers, and proration when a plan changes mid-period.
 * Pure integer arithmetic, so its laws are proven for every input with `pdd smt`.
 */
import { isCents, roundDiv } from "./money.js";

/** Units 1–1 000 cost 10 ¢ each, units 1 001–10 000 cost 8 ¢, every unit after that 5 ¢. */
export const TIER1_UNITS = 1_000;
export const TIER2_UNITS = 10_000;
export const TIER1_PRICE = 10;
export const TIER2_PRICE = 8;
export const TIER3_PRICE = 5;

/** The most units a single bill may meter. */
export const MAX_UNITS = 1_000_000_000;

/** The longest billing period: a leap year. */
export const MAX_DAYS = 366;

/** What `units` of metered usage cost, in cents. */
export function usageCharge(units: number): number {
  if (!Number.isInteger(units) || units < 0 || units > MAX_UNITS) {
    throw new RangeError("units must be an integer between 0 and MAX_UNITS");
  }
  const tier1 = Math.min(units, TIER1_UNITS);
  const tier2 = Math.min(Math.max(units - TIER1_UNITS, 0), TIER2_UNITS - TIER1_UNITS);
  const tier3 = Math.max(units - TIER2_UNITS, 0);
  return tier1 * TIER1_PRICE + tier2 * TIER2_PRICE + tier3 * TIER3_PRICE;
}

/** The part of a period's price that covers `days` of it, rounded to the nearest cent. */
export function prorate(priceCents: number, days: number, daysInPeriod: number): number {
  if (!isCents(priceCents)) throw new RangeError("price must be a whole amount between 0 and MAX_CENTS");
  if (!Number.isInteger(daysInPeriod) || daysInPeriod < 1 || daysInPeriod > MAX_DAYS) {
    throw new RangeError("daysInPeriod must be an integer between 1 and 366");
  }
  if (!Number.isInteger(days) || days < 0 || days > daysInPeriod) {
    throw new RangeError("days must be an integer between 0 and daysInPeriod");
  }
  return roundDiv(priceCents * days, daysInPeriod);
}

export interface PlanChange {
  /** Refund for the unused part of the old plan. */
  readonly credit: number;
  /** Charge for the rest of the period on the new plan. */
  readonly charge: number;
  /** What the customer pays now: negative means money back. */
  readonly net: number;
}

/** Switching plans with `daysLeft` of the period to go. */
export function planChange(oldPrice: number, newPrice: number, daysLeft: number, daysInPeriod: number): PlanChange {
  const credit = prorate(oldPrice, daysLeft, daysInPeriod);
  const charge = prorate(newPrice, daysLeft, daysInPeriod);
  return { credit, charge, net: charge - credit };
}
