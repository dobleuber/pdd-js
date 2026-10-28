import { loadConfig } from "../config/load.js";
import { analyzeCoverage, type CoverageReport } from "../coverage/analyze.js";
import { ExitCode } from "../shared/exit-codes.js";
import { pc, sym } from "../shared/output.js";

export interface CoverageOptions {
  json?: boolean;
  strict?: boolean;
}

export function printCoverage(report: CoverageReport, heading = true): void {
  const total = report.covered.length + report.indirect.length + report.uncovered.length;
  if (heading) {
    console.log(pc.bold("pdd coverage") + pc.dim(`  ${report.sourceFiles} source file(s), ${report.lawFiles} file(s) in the laws folder`));
  }
  const mark = report.uncovered.length > 0 ? sym.warn : sym.ok;
  console.log(
    `${mark} ${report.covered.length}/${total} exported functions are named by a law` +
      pc.dim(`, ${report.indirect.length} reached only indirectly, ${report.uncovered.length} not reached`),
  );
  if (report.uncovered.length > 0) {
    console.log(`  ${pc.yellow("No law reaches these exports:")}`);
    for (const e of report.uncovered) console.log(`    ${sym.fail} ${e.name} ${pc.dim(`${e.file}:${e.line}`)}`);
  }
  if (report.indirect.length > 0) {
    console.log(`  ${pc.dim("Reached only through another function (no law names them):")}`);
    for (const e of report.indirect) console.log(`    ${sym.skip} ${e.name} ${pc.dim(`${e.file}:${e.line}, via ${e.via}`)}`);
  }
}

export function coverageCommand(opts: CoverageOptions): number {
  const config = loadConfig();
  const report = analyzeCoverage(config);
  const strict = opts.strict === true || config.coverage.failOnUncovered;
  const exitCode = strict && report.uncovered.length > 0 ? ExitCode.SPEC_TOO_WEAK : ExitCode.OK;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...report, strict, exitCode }, null, 2)}\n`);
  } else {
    printCoverage(report);
    if (exitCode !== ExitCode.OK) console.log(`\n${pc.red("FAIL: some exports are not covered by any law")} ${pc.dim(`(exit ${exitCode})`)}`);
  }
  return exitCode;
}
