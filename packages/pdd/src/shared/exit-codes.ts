/** Exit codes are part of pdd's public contract: CI scripts branch on them. */
export const ExitCode = {
  OK: 0,
  LAW_FAILED: 1,
  LOCK_MISMATCH: 2,
  STATIC_CHECK_FAILED: 3,
  TAMPERING: 4,
  CONFIG_ERROR: 5,
  /** pdd mutate / pdd coverage: the laws are too weak (score below the break threshold, or uncovered exports). */
  SPEC_TOO_WEAK: 6,
  /** pdd smt with requireProof / --strict: a law marked { smt: true } could not be proven. */
  NOT_PROVEN: 7,
  INTERNAL: 70,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class PddError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
    this.name = "PddError";
  }
}
