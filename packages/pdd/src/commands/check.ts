import { loadConfig } from "../config/load.js";
import { LOCK_FILE, type PddConfig } from "../config/schema.js";
import { runGuard, type GuardReport } from "../guard/engine.js";
import { LOCK_KEY_ENV } from "../lock/sign.js";
import { verifyLock, type LockVerdict } from "../lock/verify.js";
import { discoverLawFiles } from "../runner/discover.js";
import { runLaws } from "../runner/orchestrator.js";
import type { FileResult, LawsReport } from "../runner/report.js";
import { makeSeed, parseSeed } from "../runner/seed.js";
import { isCI } from "../shared/env.js";
import { ExitCode, PddError } from "../shared/exit-codes.js";
import { indent, pc, sym } from "../shared/output.js";
import { PDD_VERSION } from "../shared/version.js";
import { runTypecheck, type TypecheckReport } from "../typecheck/index.js";
import { printLockMismatch } from "./lock.js";
import { printGuardViolations } from "./guard.js";

export interface CheckOptions {
  seed?: string;
  runs?: string;
  filter?: string;
  json?: boolean;
  ci?: boolean;
}

export interface CheckReport {
  pddVersion: string;
  ci: boolean;
  seed: number;
  exitCode: number;
  lock: LockVerdict;
  guard?: GuardReport;
  typecheck?: TypecheckReport;
  laws?: LawsReport;
}

function parseRuns(value: string, config: PddConfig): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new PddError("pdd: --runs must be a positive integer", ExitCode.CONFIG_ERROR);
  if (n < config.runs) {
    throw new PddError(
      `pdd: --runs can only raise the number of cases (pdd.config.json requires at least ${config.runs})`,
      ExitCode.CONFIG_ERROR,
    );
  }
  return n;
}

/**
 * Exit code priority: a broken lock stops everything (2). Otherwise tampering (4)
 * beats static-check failures (3), which beat failing laws (1).
 */
export function exitCodeFor(report: Omit<CheckReport, "exitCode">): number {
  if (report.lock.status !== "ok") return ExitCode.LOCK_MISMATCH;
  const laws = report.laws;
  if (laws && laws.files.some((f) => f.status === "tampering")) return ExitCode.TAMPERING;
  const typeErrors = report.typecheck?.status === "done" ? report.typecheck.diagnostics.length : 0;
  if ((report.guard?.errors ?? 0) > 0 || typeErrors > 0) return ExitCode.STATIC_CHECK_FAILED;
  if (laws && laws.files.some((f) => f.status !== "ok")) return ExitCode.LAW_FAILED;
  return ExitCode.OK;
}

/**
 * Runs the whole check pipeline without printing anything. `fixedSeed` is for
 * pdd mutate, which picks the seed itself and runs the same one in its baseline.
 */
export async function runCheck(opts: CheckOptions, fixedSeed?: number): Promise<{ report: CheckReport; config: PddConfig }> {
  const ci = opts.ci === true || isCI();
  const config = loadConfig();
  if (ci && opts.seed !== undefined) {
    throw new PddError("pdd: --seed is not allowed in CI: every CI run uses a fresh random seed", ExitCode.CONFIG_ERROR);
  }
  if (ci && opts.filter !== undefined) {
    throw new PddError("pdd: --filter is not allowed in CI: every law must be checked", ExitCode.CONFIG_ERROR);
  }
  if (opts.filter !== undefined) {
    try {
      new RegExp(opts.filter);
    } catch {
      throw new PddError(`pdd: --filter is not a valid regular expression: ${opts.filter}`, ExitCode.CONFIG_ERROR);
    }
  }
  const runsOverride = opts.runs === undefined ? undefined : parseRuns(opts.runs, config);
  const seed = fixedSeed ?? (opts.seed === undefined ? makeSeed() : parseSeed(opts.seed));

  const lawFiles = await discoverLawFiles(config);
  if (lawFiles.length === 0) {
    throw new PddError(
      `pdd: no law files found (expected ${config.lawsDir}/**/*.laws.ts). A spec with no laws proves nothing.`,
      ExitCode.CONFIG_ERROR,
    );
  }

  const partial: Omit<CheckReport, "exitCode"> = {
    pddVersion: PDD_VERSION,
    ci,
    seed,
    lock: await verifyLock(config, process.env[LOCK_KEY_ENV] || undefined),
  };

  if (partial.lock.status === "ok") {
    partial.guard = await runGuard(config);
    partial.typecheck = runTypecheck(config);
    const runOpts: Parameters<typeof runLaws>[0] = { config, seed, files: lawFiles };
    if (opts.filter !== undefined) runOpts.filter = opts.filter;
    if (runsOverride !== undefined) runOpts.runsOverride = runsOverride;
    partial.laws = await runLaws(runOpts);
  }

  return { report: { ...partial, exitCode: exitCodeFor(partial) }, config };
}

export async function checkCommand(opts: CheckOptions): Promise<number> {
  const { report, config } = await runCheck(opts);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printCheck(report, config, opts);
  return report.exitCode;
}

function printFile(file: FileResult, seed: number): void {
  const head = file.status === "ok" ? sym.ok : file.status === "tampering" ? pc.red("⚠") : sym.fail;
  console.log(`  ${head} ${pc.bold(file.file)}`);
  for (const law of file.laws) {
    if (law.status === "passed") {
      console.log(`      ${sym.ok} ${law.name} ${pc.dim(`(${law.numRuns} cases)`)}`);
    } else if (law.status === "skipped") {
      console.log(`      ${sym.skip} ${pc.dim(`${law.name} (filtered out)`)}`);
    } else {
      console.log(`      ${sym.fail} ${pc.red(law.name)}`);
      if (law.counterexample !== undefined) console.log(indent(`counterexample: ${law.counterexample}`, 10));
      if (law.error !== undefined) console.log(indent(pc.dim(law.error), 10));
      const escaped = law.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      console.log(indent(pc.dim(`repro: pdd check --seed ${seed} --filter ${JSON.stringify(`^${escaped}$`)}`), 10));
    }
  }
  if (file.error !== undefined) console.log(indent(pc.red(file.error), 6));
  for (const t of file.tampering) console.log(indent(`${pc.red("tampering:")} ${t}`, 6));
  if (file.status !== "ok" && file.output.trim() !== "") {
    console.log(indent(pc.dim(`output of the code under test:\n${file.output.trimEnd()}`), 6));
  }
}

export function printCheck(report: CheckReport, config: PddConfig, opts: CheckOptions): void {
  const runs = opts.runs ?? String(config.runs);
  console.log(pc.bold(`pdd check`) + pc.dim(`  seed=${report.seed}  runs≥${runs}${report.ci ? "  ci" : ""}`));

  const lock = report.lock;
  if (lock.status === "ok") {
    const sig = lock.signature === "verified" ? "signature verified" : "signature not checked";
    console.log(`${sym.ok} lock       ${lock.files} files match ${LOCK_FILE} ${pc.dim(`(${sig})`)}`);
  } else if (lock.status === "missing") {
    console.log(`${sym.fail} lock       ${LOCK_FILE} is missing. A human must run \`pdd lock\` after reviewing the laws.`);
  } else {
    console.log(`${sym.fail} lock       the spec changed since it was locked`);
    printLockMismatch(lock);
  }

  if (report.guard) {
    const g = report.guard;
    const mark = g.errors > 0 ? sym.fail : g.warnings > 0 ? sym.warn : sym.ok;
    console.log(`${mark} guard      ${g.files} files scanned, ${g.errors} errors, ${g.warnings} warnings`);
    printGuardViolations(g);
  }

  if (report.typecheck) {
    const t = report.typecheck;
    if (t.status === "skipped") console.log(`${sym.skip} typecheck  ${pc.dim(`skipped: ${t.reason}`)}`);
    else {
      const mark = t.diagnostics.length > 0 ? sym.fail : sym.ok;
      console.log(`${mark} typecheck  ${t.files} files, ${t.diagnostics.length} errors ${pc.dim(`(${t.tsconfig})`)}`);
      if (!t.strict) console.log(indent(`${sym.warn} ${t.tsconfig} does not enable "strict"; type guarantees are weak`, 2));
      for (const d of t.diagnostics.slice(0, 30)) {
        const where = d.file ? `${d.file}:${d.line}:${d.col}` : "";
        console.log(indent(`${pc.red(`TS${d.code}`)} ${where} ${d.message}`, 4));
      }
      if (t.diagnostics.length > 30) console.log(indent(pc.dim(`... and ${t.diagnostics.length - 30} more`), 4));
    }
  }

  if (report.laws) {
    const s = report.laws.summary;
    const mark = report.laws.files.every((f) => f.status === "ok") ? sym.ok : sym.fail;
    console.log(`${mark} laws       ${s.passed}/${s.laws - s.skipped} passed in ${s.files} file(s)${s.skipped ? pc.dim(`, ${s.skipped} filtered out`) : ""}`);
    for (const file of report.laws.files) printFile(file, report.seed);
  }

  const verdicts: Record<number, string> = {
    0: pc.green("PASS"),
    1: pc.red("FAIL: a law does not hold"),
    2: pc.red("FAIL: the spec does not match its lock"),
    3: pc.red("FAIL: static checks (guard / typecheck)"),
    4: pc.red("FAIL: tampering detected"),
  };
  console.log(`\n${verdicts[report.exitCode] ?? pc.red("FAIL")} ${pc.dim(`(exit ${report.exitCode})`)}`);
}
