import { z } from "zod";

export const CONFIG_FILE = "pdd.config.json";
export const LOCK_FILE = "pdd.lock.json";

const severity = z.enum(["error", "warn", "off"]);
const ruleSetting = z.union([severity, z.tuple([severity, z.record(z.string(), z.unknown())])]);

/** Shape of pdd.config.json as written by humans. Every field is optional; defaults live in DEFAULTS. */
export const configFileSchema = z
  .object({
    $schema: z.string().optional(),
    lawsDir: z.string().min(1).optional(),
    src: z.array(z.string().min(1)).min(1).optional(),
    tests: z.array(z.string().min(1)).optional(),
    runs: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1).optional(),
    fileTimeoutMs: z.number().int().min(1).optional(),
    typecheck: z.boolean().optional(),
    tsconfig: z.string().min(1).optional(),
    guard: z
      .object({
        rules: z.record(z.string(), ruleSetting).optional(),
        ignore: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    lock: z
      .object({
        include: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    protectedPaths: z.array(z.string()).optional(),
    mutate: z
      .object({
        files: z.array(z.string().min(1)).min(1).optional(),
        thresholds: z
          .object({
            high: z.number().min(0).max(100).optional(),
            low: z.number().min(0).max(100).optional(),
            break: z.number().min(0).max(100).nullable().optional(),
          })
          .strict()
          .optional(),
        concurrency: z.number().int().min(1).optional(),
        timeoutMs: z.number().int().min(1).optional(),
        typecheck: z.boolean().optional(),
      })
      .strict()
      .optional(),
    coverage: z
      .object({
        failOnUncovered: z.boolean().optional(),
        ignore: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    smt: z
      .object({
        timeoutMs: z.number().int().min(1).optional(),
        requireProof: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Severity = z.infer<typeof severity>;
export type RuleSetting = z.infer<typeof ruleSetting>;

export interface PddConfig {
  /** Absolute project root (the folder holding pdd.config.json). */
  root: string;
  configPath: string;
  lawsDir: string;
  src: string[];
  tests: string[];
  runs: number;
  timeoutMs: number;
  fileTimeoutMs: number;
  typecheck: boolean;
  tsconfig: string;
  guard: { rules: Record<string, RuleSetting>; ignore: string[] };
  lock: { include: string[] };
  protectedPaths: string[];
  mutate: MutateConfig;
  coverage: { failOnUncovered: boolean; ignore: string[] };
  smt: SmtConfig;
}

export interface SmtConfig {
  /** Time Z3 may spend on one law. */
  timeoutMs: number;
  /** Fail (exit 7) when a law marked { smt: true } is not proven. */
  requireProof: boolean;
}

export interface MutateConfig {
  /** Files to mutate; null means "the src globs minus tests and the laws folder". */
  files: string[] | null;
  thresholds: { high: number; low: number; break: number | null };
  /** Parallel Stryker workers; null lets Stryker decide. */
  concurrency: number | null;
  /** Extra time each mutant run may take, on top of the measured baseline (Stryker's timeoutMS). */
  timeoutMs: number;
  /** Discard mutants that do not type-check (Stryker's TypeScript checker). */
  typecheck: boolean;
}

export const DEFAULTS = {
  lawsDir: "laws",
  src: ["src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  tests: ["**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  runs: 200,
  timeoutMs: 10_000,
  fileTimeoutMs: 120_000,
  typecheck: true,
  tsconfig: "tsconfig.json",
  lockInclude: ["tsconfig.json", ".github/workflows/*.yml", ".github/workflows/*.yaml"],
  mutateThresholds: { high: 80, low: 60, break: null },
  mutateTimeoutMs: 10_000,
  smtTimeoutMs: 10_000,
} as const;
