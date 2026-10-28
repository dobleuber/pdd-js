#!/usr/bin/env node
import { Command } from "commander";
import { checkCommand } from "./commands/check.js";
import { guardCommand } from "./commands/guard.js";
import { hookCommand } from "./commands/hook.js";
import { initCommand } from "./commands/init.js";
import { lockCommand } from "./commands/lock.js";
import { coverageCommand } from "./commands/coverage.js";
import { mutateCommand } from "./commands/mutate.js";
import { smtCommand } from "./commands/smt.js";
import { ExitCode, PddError } from "./shared/exit-codes.js";
import { pc } from "./shared/output.js";
import { PDD_VERSION } from "./shared/version.js";

async function run(action: () => Promise<number> | number): Promise<void> {
  try {
    process.exitCode = await action();
  } catch (e) {
    if (e instanceof PddError) {
      console.error(pc.red(e.message));
      process.exitCode = e.exitCode;
    } else {
      console.error(e);
      process.exitCode = ExitCode.INTERNAL;
    }
  }
}

const program = new Command()
  .name("pdd")
  .description("Proof-Driven Development for JS/TS: human-owned laws, a mechanical verdict, no escape hatches.")
  .version(PDD_VERSION);

program
  .command("check")
  .description("verify the lock, run guard + typecheck, then check every law")
  .option("--seed <n>", "reuse a seed to reproduce a failure (not allowed in CI)")
  .option("--runs <n>", "raise the number of generated cases per law")
  .option("--filter <regex>", "only run laws whose name matches (not allowed in CI)")
  .option("--json", "print the full report as JSON")
  .option("--ci", "CI mode (also enabled by the CI environment variable)")
  .action((opts) => run(() => checkCommand(opts)));

program
  .command("lock")
  .description("record the hashes of the spec (laws, arbitraries, config) in pdd.lock.json — humans only")
  .option("--check", "only verify the lock (exit 2 on mismatch)")
  .option("--diff", "show what changed since the last lock, without writing")
  .option("--sign", "sign the lock with PDD_LOCK_KEY")
  .action((opts) => run(() => lockCommand(opts)));

program
  .command("guard")
  .description("scan code for escape hatches (any, @ts-ignore, .skip, global patches, ...)")
  .option("--json", "print the report as JSON")
  .option("--list-rules", "list the guard rules")
  .action((opts) => run(() => guardCommand(opts)));

program
  .command("init")
  .description("create pdd.config.json, a laws/ folder and the first lock")
  .option("--claude", "install the Claude Code PreToolUse hook that blocks edits to the spec")
  .option("--ci", "create a GitHub Actions workflow and print the recommended protections")
  .option("--sign", "sign the first lock with PDD_LOCK_KEY")
  .action((opts) => run(() => initCommand(opts)));

program
  .command("hook")
  .description("Claude Code PreToolUse hook (reads the hook JSON on stdin)")
  .action(() => run(() => hookCommand()));

program
  .command("mutate")
  .description("mutation testing (Stryker): inject small bugs and report the ones no law catches")
  .option("--seed <n>", "reuse a seed (not allowed in CI)")
  .option("--json", "print the full report as JSON")
  .option("--ci", "CI mode (also enabled by the CI environment variable)")
  .action((opts) => run(() => mutateCommand(opts)));

program
  .command("coverage")
  .description("list exported functions that no law reaches")
  .option("--json", "print the report as JSON")
  .option("--strict", "exit 6 if any export is not reached by a law")
  .action((opts) => run(() => coverageCommand(opts)));

program
  .command("smt")
  .description("(experimental) prove the laws marked { smt: true } for every input, with Z3")
  .option("--seed <n>", "reuse a seed for the pdd check baseline (not allowed in CI)")
  .option("--strict", "exit 7 if a law marked { smt: true } is not proven")
  .option("--json", "print the full report as JSON")
  .option("--ci", "CI mode (also enabled by the CI environment variable)")
  .action((opts) => run(() => smtCommand(opts)));

await program.parseAsync();
