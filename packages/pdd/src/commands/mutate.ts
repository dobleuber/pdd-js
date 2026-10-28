import path from "node:path";
import type { PddConfig } from "../config/schema.js";
import { analyzeCoverage, type CoverageReport } from "../coverage/analyze.js";
import { summarizeMutants, type MutationSummary, type Survivor } from "../mutate/report.js";
import { runStryker } from "../mutate/run.js";
import { makeSeed, parseSeed } from "../runner/seed.js";
import { isCI } from "../shared/env.js";
import { ExitCode, PddError } from "../shared/exit-codes.js";
import { pc, sym } from "../shared/output.js";
import { relPosix } from "../shared/paths.js";
import { PDD_VERSION } from "../shared/version.js";
import { printCheck, runCheck, type CheckReport } from "./check.js";
import { printCoverage } from "./coverage.js";

export interface MutateOptions {
  seed?: string;
  json?: boolean;
  ci?: boolean;
}

export interface MutateReport {
  pddVersion: string;
  ci: boolean;
  seed: number;
  exitCode: number;
  check: CheckReport;
  mutation?: MutationSummary & { thresholds: PddConfig["mutate"]["thresholds"]; htmlReport: string };
  coverage?: CoverageReport;
}

function formatScore(score: number | null): string {
  return score === null ? "n/a" : `${score.toFixed(1)}%`;
}

function colorScore(score: number | null, t: PddConfig["mutate"]["thresholds"]): string {
  const text = formatScore(score);
  if (score === null) return pc.dim(text);
  if (score >= t.high) return pc.green(text);
  if (score >= t.low) return pc.yellow(text);
  return pc.red(text);
}

function printSurvivors(title: string, survivors: Survivor[]): void {
  if (survivors.length === 0) return;
  console.log(`  ${title}`);
  let lastFile = "";
  let lastFn: string | null | undefined;
  for (const s of survivors) {
    if (s.file !== lastFile) {
      console.log(`    ${pc.bold(s.file)}`);
      lastFile = s.file;
      lastFn = undefined;
    }
    if (s.function !== lastFn) {
      console.log(`      ${pc.cyan(s.function ?? "(module)")}`);
      lastFn = s.function;
    }
    const where = pc.dim(`${s.line}:${s.col}`.padEnd(7));
    console.log(`        ${where} ${s.original}  ${pc.dim("→")}  ${pc.yellow(s.replacement)}  ${pc.dim(`(${s.mutator})`)}`);
  }
}

function printMutation(report: MutateReport, config: PddConfig): void {
  const m = report.mutation;
  if (!m) return;
  const c = m.counts;
  const t = m.thresholds;
  const failed = report.exitCode === ExitCode.SPEC_TOO_WEAK;
  console.log(
    `\n${failed ? sym.fail : m.survivors.length > 0 ? sym.warn : sym.ok} mutation   score ${colorScore(m.score, t)}` +
      pc.dim(`  (${c.killed} killed, ${c.timeout} timeout, ${c.survived} survived, ${c.noCoverage} no coverage, ${c.discarded} discarded)`) +
      pc.dim(`  break=${t.break ?? "off"} low=${t.low} high=${t.high}`),
  );
  for (const t of m.tampering) {
    console.log(`  ${pc.red("tampering:")} under the ${t.mutator} mutant at ${t.file}:${t.line}: ${t.reason}`);
  }
  printSurvivors(pc.yellow("Survived — some law runs this code, but none fails when it changes:"), m.survivors.filter((s) => s.status === "Survived"));
  printSurvivors(pc.yellow("No coverage — no law runs this code at all:"), m.survivors.filter((s) => s.status === "NoCoverage"));
  console.log(pc.dim(`  full report: ${relPosix(config.root, m.htmlReport)}`));
}

export async function mutateCommand(opts: MutateOptions): Promise<number> {
  const ci = opts.ci === true || isCI();
  if (ci && opts.seed !== undefined) {
    throw new PddError("pdd: --seed is not allowed in CI: every CI run uses a fresh random seed", ExitCode.CONFIG_ERROR);
  }
  const seed = opts.seed === undefined ? makeSeed() : parseSeed(opts.seed);

  // Mutation testing needs a green baseline, checked with everything pdd check enforces.
  const checkOpts = { ci, json: opts.json === true };
  const { report: check, config } = await runCheck(checkOpts, seed);
  const report: MutateReport = { pddVersion: PDD_VERSION, ci, seed, exitCode: check.exitCode, check };

  if (!opts.json) {
    printCheck(check, config, checkOpts);
    console.log(pc.bold("\npdd mutate") + pc.dim(`  seed=${seed}${ci ? "  ci" : ""}`));
  }
  if (check.exitCode !== ExitCode.OK) {
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else console.log(pc.red("pdd mutate needs `pdd check` to pass first: fix the failures above."));
    return check.exitCode;
  }

  if (!opts.json) console.log(pc.dim("  running Stryker (this can take a while)…"));
  const run = await runStryker(config, { seed, quiet: opts.json === true });
  const summary = summarizeMutants(config.root, run.results);
  const thresholds = config.mutate.thresholds;
  report.mutation = { ...summary, thresholds, htmlReport: path.relative(config.root, run.htmlReport) };
  report.coverage = analyzeCoverage(config);
  report.exitCode =
    summary.tampering.length > 0
      ? ExitCode.TAMPERING
      : thresholds.break !== null && summary.score !== null && summary.score < thresholds.break
        ? ExitCode.SPEC_TOO_WEAK
        : ExitCode.OK;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.exitCode;
  }
  printMutation({ ...report, mutation: { ...report.mutation, htmlReport: run.htmlReport } }, config);
  console.log("");
  printCoverage(report.coverage, false);
  const verdict =
    report.exitCode === ExitCode.OK
      ? pc.green("PASS")
      : report.exitCode === ExitCode.TAMPERING
        ? pc.red("FAIL: the code under test tampered with the runner during mutation testing")
        : pc.red(`FAIL: the mutation score is below mutate.thresholds.break (${thresholds.break}%): the laws are too weak`);
  console.log(`\n${verdict} ${pc.dim(`(exit ${report.exitCode})`)}`);
  return report.exitCode;
}
