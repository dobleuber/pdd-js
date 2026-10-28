import { makeSeed, parseSeed } from "../runner/seed.js";
import { isCI } from "../shared/env.js";
import { ExitCode, PddError } from "../shared/exit-codes.js";
import { indent, pc, sym } from "../shared/output.js";
import { PDD_VERSION } from "../shared/version.js";
import { runSmt, type SmtLawResult, type SmtReport } from "../smt/run.js";
import { printCheck, runCheck, type CheckReport } from "./check.js";

export interface SmtOptions {
  seed?: string;
  json?: boolean;
  ci?: boolean;
  strict?: boolean;
}

export interface SmtCommandReport {
  pddVersion: string;
  ci: boolean;
  seed: number;
  strict: boolean;
  exitCode: number;
  check: CheckReport;
  smt?: SmtReport;
}

/** Tampering (4) beats a counterexample (1), which beats an unproven law under --strict (7). */
export function smtExitCode(report: SmtReport, strict: boolean): number {
  const s = report.summary;
  if (s.tampering > 0) return ExitCode.TAMPERING;
  if (s.counterexamples > 0) return ExitCode.LAW_FAILED;
  if (strict && s.notProven > 0) return ExitCode.NOT_PROVEN;
  return ExitCode.OK;
}

function printLaw(l: SmtLawResult): void {
  const where = pc.dim(`${l.file}:${l.line}`);
  const time = pc.dim(`(${l.timeMs} ms)`);
  switch (l.status) {
    case "proven":
      console.log(`  ${sym.ok} ${pc.green("proven")}          ${l.name} ${where} ${time}`);
      break;
    case "counterexample":
      console.log(`  ${sym.fail} ${pc.red("counterexample")}  ${l.name} ${where}`);
      if (l.counterexample !== undefined) console.log(indent(`input: ${l.counterexample}`, 22));
      if (l.error !== undefined) console.log(indent(pc.dim(l.error), 22));
      break;
    case "tampering":
      console.log(`  ${pc.red("⚠")} ${pc.red("tampering")}       ${l.name} ${where}`);
      if (l.reason !== undefined) console.log(indent(pc.red(l.reason), 22));
      break;
    default: {
      const label = l.why === "untranslatable" ? "not translatable" : l.why === "unknown" ? "undecided" : "not proven";
      console.log(`  ${sym.warn} ${pc.yellow(label.padEnd(15))} ${l.name} ${where}`);
      if (l.reason !== undefined) console.log(indent(pc.dim(`${l.reason}${l.at ? `  (${l.at})` : ""}`), 22));
    }
  }
}

export async function smtCommand(opts: SmtOptions): Promise<number> {
  const ci = opts.ci === true || isCI();
  if (ci && opts.seed !== undefined) {
    throw new PddError("pdd: --seed is not allowed in CI: every CI run uses a fresh random seed", ExitCode.CONFIG_ERROR);
  }
  const seed = opts.seed === undefined ? makeSeed() : parseSeed(opts.seed);

  // A proof is only worth something on top of a spec that is locked, clean and passing.
  const checkOpts = { ci, json: opts.json === true };
  const { report: check, config } = await runCheck(checkOpts, seed);
  const strict = opts.strict === true || config.smt.requireProof;
  const report: SmtCommandReport = { pddVersion: PDD_VERSION, ci, seed, strict, exitCode: check.exitCode, check };

  if (!opts.json) {
    printCheck(check, config, checkOpts);
    console.log(pc.bold("\npdd smt") + pc.dim(`  experimental${strict ? "  strict" : ""}`));
  }
  if (check.exitCode !== ExitCode.OK) {
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else console.log(pc.red("pdd smt needs `pdd check` to pass first: fix the failures above."));
    return check.exitCode;
  }

  const smt = await runSmt(config, seed);
  report.smt = smt;
  report.exitCode = smtExitCode(smt, strict);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.exitCode;
  }

  const s = smt.summary;
  if (s.laws === 0) {
    console.log(`${sym.skip} no law is marked { smt: true }: nothing to prove`);
  } else {
    const mark = s.counterexamples + s.tampering > 0 ? sym.fail : s.notProven > 0 ? sym.warn : sym.ok;
    console.log(
      `${mark} smt        ${s.proven}/${s.laws} proven` +
        pc.dim(`, ${s.counterexamples} counterexample(s), ${s.notProven} not proven${smt.z3 ? `  (Z3 ${smt.z3})` : ""}`),
    );
    for (const l of smt.laws) printLaw(l);
    console.log(pc.dim("  proven = holds for every input the law's arbitraries can produce, not only the sampled ones"));
  }
  const verdicts: Record<number, string> = {
    [ExitCode.OK]: pc.green("PASS"),
    [ExitCode.LAW_FAILED]: pc.red("FAIL: Z3 found an input that breaks a law"),
    [ExitCode.TAMPERING]: pc.red("FAIL: tampering detected while replaying a counterexample"),
    [ExitCode.NOT_PROVEN]: pc.red("FAIL: some laws marked { smt: true } are not proven"),
  };
  console.log(`\n${verdicts[report.exitCode] ?? pc.red("FAIL")} ${pc.dim(`(exit ${report.exitCode})`)}`);
  return report.exitCode;
}
