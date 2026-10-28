import type ts from "typescript";
import type { Severity } from "../config/schema.js";

export type FileKind = "src" | "test";

export interface Violation {
  ruleId: string;
  severity: "error" | "warn";
  file: string;
  line: number;
  col: number;
  message: string;
  snippet: string;
}

export interface RuleContext {
  /** Absolute path of the file being checked. */
  filePath: string;
  kind: FileKind;
  options: Record<string, unknown>;
  /** True if the absolute path is (transitively) imported by the laws. */
  isLawedModule(absPath: string): boolean;
  /** True if the absolute path is inside lawsDir. */
  isInLawsDir(absPath: string): boolean;
  /** Reports a violation at a node, or at a character position. */
  report(target: ts.Node | number, message: string): void;
}

export interface GuardRule {
  id: string;
  description: string;
  appliesTo: readonly FileKind[];
  defaultSeverity: Severity;
  check(sf: ts.SourceFile, ctx: RuleContext): void;
}
