import { ExitCode } from "../shared/exit-codes.js";
import { pc } from "../shared/output.js";

export function mutateCommand(): number {
  console.error(
    `${pc.yellow("pdd mutate is not implemented yet (phase 3).")}\n` +
      "It will run Stryker with a command runner that calls `pdd check`, and fail when the\n" +
      "mutation score is below the threshold: a sign that the laws are too weak.",
  );
  return ExitCode.NOT_IMPLEMENTED;
}

export function smtCommand(): number {
  console.error(
    `${pc.yellow("pdd smt is experimental and not implemented yet (phase 4).")}\n` +
      "See docs/smt-design.md for the design: exhaustive checking of pure functions with Z3.",
  );
  return ExitCode.NOT_IMPLEMENTED;
}
