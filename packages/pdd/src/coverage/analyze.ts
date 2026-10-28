/**
 * Law coverage: which exported functions does some law mention?
 *
 * - covered:   referenced from a file in the laws folder (a law or one of its arbitraries);
 * - indirect:  not referenced, but called (transitively) by a covered function, so laws
 *              exercise it only through something else;
 * - uncovered: no law reaches it at all.
 *
 * This is a static view. `pdd mutate` measures how well the laws actually pin the behaviour down.
 */
import path from "node:path";
import ts from "typescript";
import type { PddConfig } from "../config/schema.js";
import { relPosix } from "../shared/paths.js";
import { lawsDirFiles, loadProjectProgram, sourceFiles } from "../shared/program.js";

export type ExportKind = "function" | "class";

export interface ExportInfo {
  name: string;
  file: string;
  line: number;
  kind: ExportKind;
}

export interface IndirectExport extends ExportInfo {
  /** A covered export through which the laws reach this one. */
  via: string;
}

export interface CoverageReport {
  sourceFiles: number;
  lawFiles: number;
  covered: ExportInfo[];
  indirect: IndirectExport[];
  uncovered: ExportInfo[];
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ClassDeclaration;

const FALLBACK_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

function createProgram(config: PddConfig, roots: string[]): ts.Program {
  const loaded = loadProjectProgram(config, roots);
  if (loaded.status === "ok") return loaded.program;
  return ts.createProgram({ rootNames: roots, options: FALLBACK_OPTIONS });
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** The function or class that gives an exported symbol its behaviour, if it has one. */
function behaviourOf(symbol: ts.Symbol): FunctionLike | undefined {
  for (const decl of symbol.declarations ?? []) {
    if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl) || ts.isMethodDeclaration(decl)) return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    }
  }
  return undefined;
}

function isImportBinding(node: ts.Identifier): boolean {
  const p = node.parent;
  return ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p);
}

/** Symbols referenced by identifiers inside `node` (aliases resolved, import bindings skipped). */
function referencedSymbols(checker: ts.TypeChecker, node: ts.Node): Set<ts.Symbol> {
  const found = new Set<ts.Symbol>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && !isImportBinding(n)) {
      const symbol = checker.getSymbolAtLocation(n);
      if (symbol) found.add(resolveAlias(checker, symbol));
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export function analyzeCoverage(config: PddConfig): CoverageReport {
  const srcFiles = sourceFiles(config, config.coverage.ignore);
  const lawFiles = lawsDirFiles(config);
  const program = createProgram(config, [...srcFiles, ...lawFiles]);
  const checker = program.getTypeChecker();
  const srcSet = new Set(srcFiles.map((f) => path.resolve(f)));
  const inSrc = (node: ts.Node): boolean => srcSet.has(path.resolve(node.getSourceFile().fileName));

  // 1. Exported functions and classes of the source files, deduplicated across re-exports.
  const exports = new Map<ts.Symbol, ExportInfo>();
  for (const file of srcFiles) {
    const sf = program.getSourceFile(file);
    const moduleSymbol = sf && checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolveAlias(checker, exported);
      if (exports.has(symbol)) continue;
      const behaviour = behaviourOf(symbol);
      if (!behaviour || !inSrc(behaviour)) continue;
      const declSf = behaviour.getSourceFile();
      const declaredName = (behaviour as { name?: ts.Node }).name;
      exports.set(symbol, {
        name: declaredName && ts.isIdentifier(declaredName) ? declaredName.text : exported.getName(),
        file: relPosix(config.root, declSf.fileName),
        line: declSf.getLineAndCharacterOfPosition(behaviour.getStart()).line + 1,
        kind: ts.isClassDeclaration(behaviour) ? "class" : "function",
      });
    }
  }

  // 2. What the laws folder references.
  const referenced = new Set<ts.Symbol>();
  for (const file of lawFiles) {
    const sf = program.getSourceFile(file);
    if (sf) for (const s of referencedSymbols(checker, sf)) referenced.add(s);
  }

  // 3. Walk calls from the covered exports through any source function to find indirect ones.
  const covered = [...exports.keys()].filter((s) => referenced.has(s));
  const reachedVia = new Map<ts.Symbol, string>();
  const queue: Array<{ symbol: ts.Symbol; via: string }> = covered.map((s) => ({ symbol: s, via: s.getName() }));
  const visited = new Set<ts.Symbol>(covered);
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const behaviour = behaviourOf(item.symbol);
    if (!behaviour) continue;
    for (const next of referencedSymbols(checker, behaviour)) {
      if (visited.has(next)) continue;
      const nextBehaviour = behaviourOf(next);
      if (!nextBehaviour || !inSrc(nextBehaviour)) continue;
      visited.add(next);
      if (exports.has(next)) reachedVia.set(next, item.via);
      queue.push({ symbol: next, via: item.via });
    }
  }

  const byPlace = (a: ExportInfo, b: ExportInfo): number => a.file.localeCompare(b.file) || a.line - b.line;
  const report: CoverageReport = { sourceFiles: srcFiles.length, lawFiles: lawFiles.length, covered: [], indirect: [], uncovered: [] };
  for (const [symbol, info] of exports) {
    if (referenced.has(symbol)) report.covered.push(info);
    else {
      const via = reachedVia.get(symbol);
      if (via !== undefined) report.indirect.push({ ...info, via });
      else report.uncovered.push(info);
    }
  }
  report.covered.sort(byPlace);
  report.indirect.sort(byPlace);
  report.uncovered.sort(byPlace);
  return report;
}
