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
  | { nonce: string; type: "done"; registered: number; names: string[] };

export type FileStatus = "ok" | "failed" | "errored" | "tampering";

export interface FileResult {
  file: string;
  status: FileStatus;
  laws: LawResult[];
  tampering: string[];
  error?: string;
  /** stdout/stderr printed by the code under test (truncated). */
  output: string;
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
