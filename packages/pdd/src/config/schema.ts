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
} as const;
