import { ExitCode } from "../shared/exit-codes.js";
import { pc } from "../shared/output.js";

export function smtCommand(): number {
  console.error(
    `${pc.yellow("pdd smt is experimental and not implemented yet (phase 4).")}\n` +
      "See docs/smt-design.md for the design: exhaustive checking of pure functions with Z3.",
  );
  return ExitCode.NOT_IMPLEMENTED;
}
