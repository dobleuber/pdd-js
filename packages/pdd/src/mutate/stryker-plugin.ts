/**
 * Stryker test-runner plugin that runs pdd laws. Loaded by `pdd mutate` only.
 *
 * Stryker forks a worker, chdirs it into its sandbox (a copy of the project with
 * the mutated sources) and calls this runner there. Each law is one Stryker "test",
 * with id "<lawFile>::<lawName>". Every run spawns fresh law processes, so the
 * active mutant is installed before any mutated code loads.
 */
import type { StrykerOptions } from "@stryker-mutator/api/core";
import type { Logger } from "@stryker-mutator/api/logging";
import { commonTokens, declareClassPlugin, PluginKind, tokens } from "@stryker-mutator/api/plugin";
import {
  DryRunStatus,
  MutantRunStatus,
  TestStatus,
  type DryRunOptions,
  type DryRunResult,
  type MutantRunOptions,
  type MutantRunResult,
  type TestResult,
  type TestRunner,
  type TestRunnerCapabilities,
} from "@stryker-mutator/api/test-runner";
import { loadConfig } from "../config/load.js";
import type { PddConfig } from "../config/schema.js";
import { discoverLawFiles } from "../runner/discover.js";
import { runLawFile } from "../runner/orchestrator.js";
import type { FileResult, MutantCoverage } from "../runner/report.js";
import { makeSeed } from "../runner/seed.js";
import { relPosix } from "../shared/paths.js";
import { TAMPERING_MARKER, TEST_ID_SEPARATOR } from "./constants.js";

export { TAMPERING_MARKER, TEST_ID_SEPARATOR };

/** Options pdd mutate passes to the runner under the `pdd` key of the Stryker options. */
export interface PddRunnerOptions {
  seed: number;
}

/** Stop a run a little before Stryker's own timeout, so no law process outlives its worker. */
function budget(timeout: number): number {
  return Math.max(1_000, Math.floor(timeout * 0.9));
}

function describeFailure(file: FileResult): string {
  const failing = file.laws.find((l) => l.status === "failed" || l.status === "errored");
  if (failing) return `${failing.name}: ${failing.error ?? "the predicate returned false"}`;
  if (file.error !== undefined) return file.error;
  if (file.tampering.length > 0) return `tampering: ${file.tampering.join("; ")}`;
  return `the law file ${file.file} did not pass`;
}

function mergeCoverage(into: MutantCoverage, from: MutantCoverage | null | undefined): void {
  if (!from) return;
  for (const [id, hits] of Object.entries(from.static)) into.static[id] = (into.static[id] ?? 0) + hits;
  for (const [testId, data] of Object.entries(from.perTest)) {
    const target = (into.perTest[testId] ??= {});
    for (const [id, hits] of Object.entries(data)) target[id] = (target[id] ?? 0) + hits;
  }
}

export class PddTestRunner implements TestRunner {
  static inject = tokens(commonTokens.logger, commonTokens.options);

  private config: PddConfig | undefined;
  private files: string[] = [];
  private readonly seed: number;
  private readonly aborter = new AbortController();

  constructor(
    private readonly logger: Logger,
    options: StrykerOptions,
  ) {
    const own = (options as { pdd?: Partial<PddRunnerOptions> }).pdd;
    this.seed = typeof own?.seed === "number" ? own.seed : makeSeed();
  }

  capabilities(): TestRunnerCapabilities {
    return { reloadEnvironment: true };
  }

  async init(): Promise<void> {
    this.config = loadConfig(process.cwd());
    this.files = await discoverLawFiles(this.config);
    this.logger.debug(`pdd runner: ${this.files.length} law file(s) in ${this.config.root}, seed ${this.seed}`);
  }

  private requireConfig(): PddConfig {
    if (!this.config) throw new Error("pdd runner used before init()");
    return this.config;
  }

  private prefix(file: string): string {
    return `${relPosix(this.requireConfig().root, file)}${TEST_ID_SEPARATOR}`;
  }

  async dryRun(options: DryRunOptions): Promise<DryRunResult> {
    const config = this.requireConfig();
    const deadline = Date.now() + options.timeout;
    const tests: TestResult[] = [];
    const coverage: MutantCoverage = { static: {}, perTest: {} };

    for (const file of this.files) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: DryRunStatus.Timeout, reason: "the laws did not finish in time" };
      const testIdPrefix = this.prefix(file);
      const result = await runLawFile(file, {
        config,
        seed: this.seed,
        mutation: { activeMutant: null, hitLimit: null, testIdPrefix },
        fileTimeoutMs: Math.max(remaining, config.fileTimeoutMs),
        signal: this.aborter.signal,
      });
      if (result.status !== "ok") {
        return { status: DryRunStatus.Error, errorMessage: `the laws do not pass on the unmutated code: ${describeFailure(result)}` };
      }
      for (const law of result.laws) {
        tests.push({ id: `${testIdPrefix}${law.name}`, name: law.name, fileName: file, timeSpentMs: law.timeMs, status: TestStatus.Success });
      }
      mergeCoverage(coverage, result.mutation?.mutantCoverage);
    }
    return { status: DryRunStatus.Complete, tests, mutantCoverage: coverage };
  }

  async mutantRun(options: MutantRunOptions): Promise<MutantRunResult> {
    const config = this.requireConfig();
    const deadline = Date.now() + budget(options.timeout);
    const hitLimit = options.hitLimit ?? null;
    const killedBy: string[] = [];
    const failures: string[] = [];
    let nrOfTests = 0;

    for (const file of this.files) {
      const testIdPrefix = this.prefix(file);
      let names: string[] | undefined;
      if (options.testFilter !== undefined) {
        names = options.testFilter.filter((id) => id.startsWith(testIdPrefix)).map((id) => id.slice(testIdPrefix.length));
        if (names.length === 0) continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: MutantRunStatus.Timeout, reason: "the laws did not finish in time" };

      const runOpts: Parameters<typeof runLawFile>[1] = {
        config,
        seed: this.seed,
        bail: !options.disableBail,
        mutation: { activeMutant: options.activeMutant.id, hitLimit, testIdPrefix },
        fileTimeoutMs: remaining,
        signal: this.aborter.signal,
      };
      if (names !== undefined) runOpts.names = names;
      const result = await runLawFile(file, runOpts);

      // Checked first: Stryker's hit-limit error inside a law would otherwise look like a killing failure.
      if (result.timedOut) return { status: MutantRunStatus.Timeout, reason: `${result.file} did not finish in time` };
      const hits = result.mutation?.hitCount ?? null;
      if (hitLimit !== null && hits !== null && hits > hitLimit) {
        return { status: MutantRunStatus.Timeout, reason: `hit limit reached (${hits}/${hitLimit}): probably an infinite loop` };
      }

      // Exiting early or patching built-ins under a mutant is not a law catching a bug: code that
      // detects mutation testing could do it to make every mutant look killed. A process killed by
      // a signal (e.g. out of memory) is a genuine crash and still counts as killed.
      if (result.status === "tampering" && result.crashSignal === undefined) {
        return { status: MutantRunStatus.Error, errorMessage: `${TAMPERING_MARKER} ${result.file}: ${result.tampering.join("; ")}` };
      }

      const ran = result.laws.filter((l) => l.status !== "skipped");
      nrOfTests += ran.length;
      if (result.status === "ok") continue;

      const failing = ran.filter((l) => l.status === "failed" || l.status === "errored");
      const ids = (failing.length > 0 ? failing : ran.length > 0 ? ran : result.laws).map((l) => `${testIdPrefix}${l.name}`);
      killedBy.push(...(ids.length > 0 ? ids : [`${testIdPrefix}(load)`]));
      failures.push(describeFailure(result));
      if (!options.disableBail) break;
    }

    if (killedBy.length > 0) {
      return { status: MutantRunStatus.Killed, killedBy, failureMessage: failures.join("\n"), nrOfTests };
    }
    return { status: MutantRunStatus.Survived, nrOfTests };
  }

  async dispose(): Promise<void> {
    this.aborter.abort();
  }
}

export const strykerPlugins = [declareClassPlugin(PluginKind.TestRunner, "pdd", PddTestRunner)];

/** Lets Stryker accept the `pdd` options object without warnings. */
export const strykerValidationSchema = {
  $schema: "http://json-schema.org/draft-07/schema",
  title: "PddRunnerOptions",
  type: "object",
  properties: {
    pdd: {
      type: "object",
      properties: { seed: { type: "integer" } },
      additionalProperties: false,
    },
  },
};
