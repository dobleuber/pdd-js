import { existsSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ts from "typescript";
import type { PddConfig } from "../config/schema.js";

export type ProjectProgram =
  | { status: "ok"; program: ts.Program; parsed: ts.ParsedCommandLine; configErrors: ts.Diagnostic[] }
  | { status: "unreadable"; error: ts.Diagnostic }
  | { status: "missing" };

/**
 * The project's TypeScript program, built from its own (locked) tsconfig.
 * `extraRoots` adds files the tsconfig may not include (e.g. the laws folder).
 */
export function loadProjectProgram(config: PddConfig, extraRoots: string[] = []): ProjectProgram {
  const tsconfigPath = path.resolve(config.root, config.tsconfig);
  if (!existsSync(tsconfigPath)) return { status: "missing" };
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) return { status: "unreadable", error: read.error };
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath), undefined, tsconfigPath);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };
  delete options.noCheck;
  const rootNames = [...new Set([...parsed.fileNames, ...extraRoots])];
  const program = ts.createProgram({ rootNames, options, projectReferences: parsed.projectReferences ?? [] });
  return { status: "ok", program, parsed, configErrors: parsed.errors };
}

/** Source files under the `src` globs, minus tests and the laws folder (absolute paths). */
export function sourceFiles(config: PddConfig, extraIgnore: string[] = []): string[] {
  return fg
    .sync(config.src, {
      cwd: config.root,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/node_modules/**", `${fg.escapePath(config.lawsDir)}/**`, ...config.tests, ...extraIgnore],
    })
    .sort();
}

/** Every file in the laws folder (laws and their helpers), absolute paths. */
export function lawsDirFiles(config: PddConfig): string[] {
  return fg
    .sync(`${fg.escapePath(config.lawsDir)}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`, {
      cwd: config.root,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/node_modules/**"],
    })
    .sort();
}
