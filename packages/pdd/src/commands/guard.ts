import { loadConfig } from "../config/load.js";
import { runGuard, type GuardReport } from "../guard/engine.js";
import { RULES } from "../guard/rules/index.js";
import { ExitCode } from "../shared/exit-codes.js";
import { pc, sym } from "../shared/output.js";

export interface GuardOptions {
  json?: boolean;
  listRules?: boolean;
}

export function printGuardViolations(report: GuardReport): void {
  for (const v of report.violations) {
    const tag = v.severity === "error" ? pc.red(v.ruleId) : pc.yellow(v.ruleId);
    console.log(`    ${tag} ${v.file}:${v.line}:${v.col} ${v.message}`);
    if (v.snippet) console.log(`      ${pc.dim(v.snippet)}`);
  }
}

export async function guardCommand(opts: GuardOptions): Promise<number> {
  if (opts.listRules) {
    for (const r of RULES) console.log(`${pc.bold(r.id)} ${pc.dim(`[${r.appliesTo.join(", ")}, default ${r.defaultSeverity}]`)}\n  ${r.description}`);
    return ExitCode.OK;
  }
  const report = await runGuard(loadConfig());
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const mark = report.errors > 0 ? sym.fail : report.warnings > 0 ? sym.warn : sym.ok;
    console.log(`${mark} guard: ${report.files} files scanned, ${report.errors} errors, ${report.warnings} warnings`);
    printGuardViolations(report);
  }
  return report.errors > 0 ? ExitCode.STATIC_CHECK_FAILED : ExitCode.OK;
}
