import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ExitCode, PddError } from "../shared/exit-codes.js";
import { RULE_IDS } from "../guard/rules/index.js";
import { CONFIG_FILE, DEFAULTS, configFileSchema, type PddConfig } from "./schema.js";

/** Walks up from `start` until it finds a folder containing pdd.config.json. */
export function findProjectRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function configError(message: string): PddError {
  return new PddError(`pdd: invalid ${CONFIG_FILE}: ${message}`, ExitCode.CONFIG_ERROR);
}

function assertRelativeInside(field: string, value: string): void {
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw configError(`"${field}" must be a path inside the project (got "${value}")`);
  }
}

export function parseConfig(root: string, raw: string): PddConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw configError(`not valid JSON (${(e as Error).message})`);
  }
  const parsed = configFileSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("\n");
    throw configError(`\n${details}`);
  }
  const c = parsed.data;
  const lawsDir = (c.lawsDir ?? DEFAULTS.lawsDir).replace(/[\\/]+$/, "");
  assertRelativeInside("lawsDir", lawsDir);
  const tsconfig = c.tsconfig ?? DEFAULTS.tsconfig;
  assertRelativeInside("tsconfig", tsconfig);

  const rules = c.guard?.rules ?? {};
  for (const id of Object.keys(rules)) {
    if (!RULE_IDS.includes(id)) {
      throw configError(`unknown guard rule "${id}". Known rules: ${RULE_IDS.join(", ")}`);
    }
  }

  const thresholds = {
    high: c.mutate?.thresholds?.high ?? DEFAULTS.mutateThresholds.high,
    low: c.mutate?.thresholds?.low ?? DEFAULTS.mutateThresholds.low,
    break: c.mutate?.thresholds?.break ?? DEFAULTS.mutateThresholds.break,
  };
  if (thresholds.low > thresholds.high) {
    throw configError(`"mutate.thresholds.low" (${thresholds.low}) must not be above "high" (${thresholds.high})`);
  }

  return {
    root,
    configPath: path.join(root, CONFIG_FILE),
    lawsDir,
    src: c.src ?? [...DEFAULTS.src],
    tests: c.tests ?? [...DEFAULTS.tests],
    runs: c.runs ?? DEFAULTS.runs,
    timeoutMs: c.timeoutMs ?? DEFAULTS.timeoutMs,
    fileTimeoutMs: c.fileTimeoutMs ?? DEFAULTS.fileTimeoutMs,
    typecheck: c.typecheck ?? DEFAULTS.typecheck,
    tsconfig,
    guard: { rules, ignore: c.guard?.ignore ?? [] },
    lock: { include: c.lock?.include ?? [...DEFAULTS.lockInclude] },
    protectedPaths: c.protectedPaths ?? [],
    mutate: {
      files: c.mutate?.files ?? null,
      thresholds,
      concurrency: c.mutate?.concurrency ?? null,
      timeoutMs: c.mutate?.timeoutMs ?? DEFAULTS.mutateTimeoutMs,
      typecheck: c.mutate?.typecheck ?? (c.typecheck ?? DEFAULTS.typecheck),
    },
    coverage: { failOnUncovered: c.coverage?.failOnUncovered ?? false, ignore: c.coverage?.ignore ?? [] },
  };
}

export function loadConfig(cwd: string = process.cwd()): PddConfig {
  const root = findProjectRoot(cwd);
  if (!root) {
    throw new PddError(
      `pdd: no ${CONFIG_FILE} found in ${cwd} or any parent folder. Run \`pdd init\` first.`,
      ExitCode.CONFIG_ERROR,
    );
  }
  return parseConfig(root, readFileSync(path.join(root, CONFIG_FILE), "utf8"));
}
