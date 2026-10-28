import { randomInt } from "node:crypto";
import { ExitCode, PddError } from "../shared/exit-codes.js";

const MAX_SEED = 2 ** 31 - 1;

/** A fresh, unpredictable seed for every run, so memorized answers don't survive. */
export function makeSeed(): number {
  return randomInt(1, MAX_SEED);
}

export function parseSeed(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SEED) {
    throw new PddError(`pdd: --seed must be an integer between 0 and ${MAX_SEED}`, ExitCode.CONFIG_ERROR);
  }
  return n;
}
