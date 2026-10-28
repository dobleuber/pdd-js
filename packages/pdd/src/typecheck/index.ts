import ts from "typescript";
import type { PddConfig } from "../config/schema.js";
import { relPosix } from "../shared/paths.js";
import { loadProjectProgram } from "../shared/program.js";

export interface TypeDiagnostic {
  file?: string;
  line?: number;
  col?: number;
  code: number;
  message: string;
}

export type TypecheckReport =
  | { status: "skipped"; reason: string }
  | { status: "done"; tsconfig: string; files: number; strict: boolean; diagnostics: TypeDiagnostic[] };

function toDiagnostic(root: string, d: ts.Diagnostic): TypeDiagnostic {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file || d.start === undefined) return { code: d.code, message };
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  return { file: relPosix(root, d.file.fileName), line: line + 1, col: character + 1, code: d.code, message };
}

/**
 * Type-checks the project with its own (locked) tsconfig. tsx strips types
 * without checking them, so without this step a type error would not stop
 * the laws from running green.
 */
export function runTypecheck(config: PddConfig): TypecheckReport {
  if (!config.typecheck) return { status: "skipped", reason: "typecheck is disabled in pdd.config.json" };
  const loaded = loadProjectProgram(config);
  if (loaded.status === "missing") return { status: "skipped", reason: `${config.tsconfig} not found` };
  if (loaded.status === "unreadable") {
    return { status: "done", tsconfig: config.tsconfig, files: 0, strict: false, diagnostics: [toDiagnostic(config.root, loaded.error)] };
  }
  const diagnostics = [...loaded.configErrors, ...ts.getPreEmitDiagnostics(loaded.program)]
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => toDiagnostic(config.root, d));
  return {
    status: "done",
    tsconfig: config.tsconfig,
    files: loaded.parsed.fileNames.length,
    strict: loaded.parsed.options.strict === true,
    diagnostics,
  };
}
