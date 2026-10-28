/** Messages exchanged between the orchestrator and a law child process, and the final report. */

export interface ChildInit {
  type: "init";
  nonce: string;
  file: string;
  seed: number;
  runs: number;
  runsOverride: number | null;
  timeoutMs: number;
  filter: string | null;
  /** Exact law names to run (pdd mutate); the others are reported as skipped. */
  names: string[] | null;
  /** Stop after the first failing law; the rest are reported as skipped (pdd mutate). */
  bail: boolean;
  /** Only set by pdd mutate. It travels in this nonce-protected message, never through the env. */
  mutation: MutationInit | null;
  /**
   * pdd smt only: run exactly these argument tuples (no generated cases, no shrinking).
   * Used to replay a counterexample found by Z3 in the isolated runner.
   */
  examples: unknown[][] | null;
}

export interface MutationInit {
  /** Stryker mutant id to activate, or null for the coverage (dry) run. */
  activeMutant: string | null;
  /** Stryker's infinite-loop guard: the injected code throws once the mutant is hit more often. */
  hitLimit: number | null;
  /** Prefix of the per-law test ids ("<lawFile>::"), used as Stryker's currentTestId. */
  testIdPrefix: string;
}

/** Stryker's coverage shape: mutant id -> hit count, globally while loading and per test id. */
export interface MutantCoverage {
  static: Record<string, number>;
  perTest: Record<string, Record<string, number>>;
}

export interface MutationReport {
  mutantCoverage: MutantCoverage | null;
  hitCount: number | null;
}

export type LawStatus = "passed" | "failed" | "errored" | "skipped";

export interface LawResult {
  name: string;
  status: LawStatus;
  numRuns: number;
  seed: number;
  counterexample?: string;
  path?: string;
  error?: string;
  timeMs: number;
}

/** Sent by the child before it knows the nonce, so the parent can deliver the init message. */
export interface ChildReady {
  type: "ready";
}

export type ChildMessage =
  | { nonce: string; type: "law"; result: LawResult }
  | { nonce: string; type: "tampering"; reason: string }
  | { nonce: string; type: "load-error"; error: string }
  | { nonce: string; type: "done"; registered: number; names: string[]; mutation?: MutationReport };

export type FileStatus = "ok" | "failed" | "errored" | "tampering";

export interface FileResult {
  file: string;
  status: FileStatus;
  laws: LawResult[];
  tampering: string[];
  error?: string;
  /** stdout/stderr printed by the code under test (truncated). */
  output: string;
  /** Coverage and hit count from a pdd mutate run. */
  mutation?: MutationReport;
  /** The file was stopped because it exceeded its time limit. */
  timedOut?: boolean;
  /** The law process was killed by this signal (not by pdd) before it reported completion. */
  crashSignal?: string;
}

export interface LawsReport {
  seed: number;
  files: FileResult[];
  summary: { files: number; laws: number; passed: number; failed: number; errored: number; skipped: number; tampering: number };
}

export function summarize(seed: number, files: FileResult[]): LawsReport {
  const laws = files.flatMap((f) => f.laws);
  return {
    seed,
    files,
    summary: {
      files: files.length,
      laws: laws.length,
      passed: laws.filter((l) => l.status === "passed").length,
      failed: laws.filter((l) => l.status === "failed").length,
      errored: laws.filter((l) => l.status === "errored").length + files.filter((f) => f.error !== undefined).length,
      skipped: laws.filter((l) => l.status === "skipped").length,
      tampering: files.reduce((n, f) => n + f.tampering.length, 0),
    },
  };
}
