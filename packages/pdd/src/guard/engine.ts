import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type ts from "typescript";
import type { PddConfig, RuleSetting, Severity } from "../config/schema.js";
import { isInside, relPosix } from "../shared/paths.js";
import { parse } from "./ast.js";
import { localImportGraph } from "./import-graph.js";
import { RULES } from "./rules/index.js";
import type { FileKind, GuardRule, Violation } from "./types.js";

export interface GuardReport {
  files: number;
  violations: Violation[];
  errors: number;
  warnings: number;
}

function resolveSetting(rule: GuardRule, settings: Record<string, RuleSetting>): { severity: Severity; options: Record<string, unknown> } {
  const s = settings[rule.id];
  if (s === undefined) return { severity: rule.defaultSeverity, options: {} };
  if (typeof s === "string") return { severity: s, options: {} };
  return { severity: s[0], options: s[1] };
}

export interface CheckSourceOptions {
  kind: FileKind;
  /** Display path in reports. */
  displayPath?: string;
  rules?: Record<string, RuleSetting>;
  isLawedModule?: (abs: string) => boolean;
  isInLawsDir?: (abs: string) => boolean;
}

/** Runs the applicable guard rules over one file's text. */
export function checkSource(filePath: string, text: string, opts: CheckSourceOptions): Violation[] {
  const sf = parse(filePath, text);
  const lines = text.split(/\r?\n/);
  const violations: Violation[] = [];
  for (const rule of RULES) {
    if (!rule.appliesTo.includes(opts.kind)) continue;
    const { severity, options } = resolveSetting(rule, opts.rules ?? {});
    if (severity === "off") continue;
    rule.check(sf, {
      filePath,
      kind: opts.kind,
      options,
      isLawedModule: opts.isLawedModule ?? (() => false),
      isInLawsDir: opts.isInLawsDir ?? (() => false),
      report(target: ts.Node | number, message: string) {
        const pos = typeof target === "number" ? target : target.getStart(sf);
        const { line, character } = sf.getLineAndCharacterOfPosition(pos);
        violations.push({
          ruleId: rule.id,
          severity,
          file: opts.displayPath ?? filePath,
          line: line + 1,
          col: character + 1,
          message,
          snippet: (lines[line] ?? "").trim().slice(0, 160),
        });
      },
    });
  }
  return violations;
}

export async function runGuard(config: PddConfig): Promise<GuardReport> {
  const ignore = ["**/node_modules/**", `${fg.escapePath(config.lawsDir)}/**`, ...config.guard.ignore];
  const globOpts = { cwd: config.root, absolute: true, onlyFiles: true, followSymbolicLinks: false, ignore };
  const testFiles = new Set(await fg(config.tests, globOpts));
  const srcFiles = (await fg(config.src, globOpts)).filter((f) => !testFiles.has(f));

  const lawsDirAbs = path.join(config.root, config.lawsDir);
  const lawEntries = await fg(`${fg.escapePath(config.lawsDir)}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`, {
    cwd: config.root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**"],
  });
  const lawed = await localImportGraph(lawEntries);

  const all: Array<[string, FileKind]> = [
    ...srcFiles.map((f) => [f, "src"] as [string, FileKind]),
    ...[...testFiles].map((f) => [f, "test"] as [string, FileKind]),
  ].sort((a, b) => a[0].localeCompare(b[0]));

  const violations: Violation[] = [];
  for (const [file, kind] of all) {
    const text = await readFile(file, "utf8");
    violations.push(
      ...checkSource(file, text, {
        kind,
        displayPath: relPosix(config.root, file),
        rules: config.guard.rules,
        isLawedModule: (abs) => lawed.has(abs),
        isInLawsDir: (abs) => isInside(lawsDirAbs, abs),
      }),
    );
  }
  return {
    files: all.length,
    violations,
    errors: violations.filter((v) => v.severity === "error").length,
    warnings: violations.filter((v) => v.severity === "warn").length,
  };
}
