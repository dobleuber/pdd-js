/** Exit codes are part of pdd's public contract: CI scripts branch on them. */
export const ExitCode = {
  OK: 0,
  LAW_FAILED: 1,
  LOCK_MISMATCH: 2,
  STATIC_CHECK_FAILED: 3,
  TAMPERING: 4,
  CONFIG_ERROR: 5,
  NOT_IMPLEMENTED: 64,
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
