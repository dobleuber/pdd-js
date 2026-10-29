/** Builds Stryker's options from the (locked) pdd config and runs it in-process. */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PddConfig } from "../config/schema.js";
import { ExitCode, PddError } from "../shared/exit-codes.js";
import { addDevCommand } from "../shared/install-hint.js";
import { relPosix } from "../shared/paths.js";
import { resolvePackage } from "../shared/resolve.js";
import { sourceFiles } from "../shared/program.js";
import type { PddRunnerOptions } from "./stryker-plugin.js";

/** Stryker merges these into its options; pdd refuses to run with one present. */
const STRYKER_CONFIG_FILE = /^\.?stryker\.(conf|config)\.(json|js|mjs|cjs)$/;

export const REPORT_DIR = "reports/mutation";
export const TEMP_DIR = ".stryker-tmp";

const PLUGIN_PATH = fileURLToPath(new URL("./stryker-plugin.js", import.meta.url));

export const STRYKER_PACKAGES = ["@stryker-mutator/core", "@stryker-mutator/api", "@stryker-mutator/typescript-checker"] as const;

/** Minimal view of Stryker's MutantResult (mutation-testing-report-schema). */
export interface StrykerMutantResult {
  id: string;
  fileName: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  statusReason?: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
  killedBy?: string[];
  coveredBy?: string[];
}

interface StrykerModule {
  Stryker: new (options: Record<string, unknown>) => { runMutationTest(): Promise<StrykerMutantResult[]> };
}

function installHint(root: string): string {
  return addDevCommand(root, STRYKER_PACKAGES.map((p) => `${p}@^10.1.1`));
}

export async function findStrykerConfigFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((f) => STRYKER_CONFIG_FILE.test(f)).sort();
}

/** The files Stryker mutates, relative to the root: `mutate.files` or the `src` globs, never tests or laws. */
export function filesToMutate(config: PddConfig): string[] {
  const files = config.mutate.files ? sourceFiles({ ...config, src: config.mutate.files }) : sourceFiles(config);
  return files.map((f) => relPosix(config.root, f));
}

export interface StrykerRun {
  results: StrykerMutantResult[];
  /** Absolute path of the HTML report. */
  htmlReport: string;
}

export interface RunStrykerOptions {
  seed: number;
  /** Silence Stryker's own logging (for --json output). */
  quiet?: boolean;
}

export async function runStryker(config: PddConfig, opts: RunStrykerOptions): Promise<StrykerRun> {
  const mutate = filesToMutate(config);
  if (mutate.length === 0) {
    throw new PddError("pdd mutate: no source files to mutate (check \"src\" / \"mutate.files\" in pdd.config.json)", ExitCode.CONFIG_ERROR);
  }
  const strayConfigs = await findStrykerConfigFiles(config.root);
  if (strayConfigs.length > 0) {
    throw new PddError(
      `pdd: found ${strayConfigs.join(", ")}. pdd mutate takes every mutation setting from the locked ${path.basename(config.configPath)} ` +
        "(a Stryker config file could exclude mutants or files); remove it.",
      ExitCode.CONFIG_ERROR,
    );
  }

  const corePath = resolvePackage(config.root, "@stryker-mutator/core");
  const apiPath = resolvePackage(config.root, "@stryker-mutator/api/plugin");
  if (!corePath || !apiPath) {
    throw new PddError(`pdd mutate needs Stryker. Install it with:\n  ${installHint(config.root)}`, ExitCode.CONFIG_ERROR);
  }
  const plugins: string[] = [];
  const checkers: string[] = [];
  if (config.mutate.typecheck && existsSync(path.resolve(config.root, config.tsconfig))) {
    const checkerPath = resolvePackage(config.root, "@stryker-mutator/typescript-checker");
    if (!checkerPath) {
      throw new PddError(
        `pdd mutate type-checks mutants ("mutate.typecheck"), which needs @stryker-mutator/typescript-checker:\n  ${installHint(config.root)}`,
        ExitCode.CONFIG_ERROR,
      );
    }
    plugins.push(checkerPath);
    checkers.push("typescript");
  }

  const { Stryker } = (await import(pathToFileURL(corePath).href)) as StrykerModule;

  // An empty config file stops Stryker from discovering (and merging) any other one.
  const scratch = await mkdtemp(path.join(tmpdir(), "pdd-mutate-"));
  const emptyConfig = path.join(scratch, "stryker.config.json");
  await writeFile(emptyConfig, "{}\n");

  const pdd: PddRunnerOptions = { seed: opts.seed };
  const options: Record<string, unknown> = {
    configFile: emptyConfig,
    testRunner: "pdd",
    plugins,
    appendPlugins: [PLUGIN_PATH],
    checkers,
    tsconfigFile: config.tsconfig,
    mutate,
    coverageAnalysis: "perTest",
    ignoreStatic: false,
    disableTypeChecks: true,
    disableBail: false,
    timeoutMS: config.mutate.timeoutMs,
    timeoutFactor: 1.5,
    thresholds: config.mutate.thresholds,
    mutator: { excludedMutations: [] },
    ignorers: [],
    ignorePatterns: [REPORT_DIR, TEMP_DIR],
    reporters: ["html", "json"],
    htmlReporter: { fileName: `${REPORT_DIR}/mutation.html` },
    jsonReporter: { fileName: `${REPORT_DIR}/mutation.json` },
    tempDirName: TEMP_DIR,
    cleanTempDir: true,
    inPlace: false,
    incremental: false,
    symlinkNodeModules: true,
    allowEmpty: false,
    logLevel: opts.quiet ? "off" : "warn",
    fileLogLevel: "off",
    pdd,
  };
  if (config.mutate.concurrency !== null) options.concurrency = config.mutate.concurrency;

  // Stryker always works from process.cwd().
  const previousCwd = process.cwd();
  process.chdir(config.root);
  try {
    const results = await new Stryker(options).runMutationTest();
    return { results, htmlReport: path.join(config.root, REPORT_DIR, "mutation.html") };
  } finally {
    process.chdir(previousCwd);
    await rm(scratch, { recursive: true, force: true });
  }
}
