/** Turns Stryker's results into pdd's view: a score and the mutants no law noticed. */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { relPosix, toPosix } from "../shared/paths.js";
import type { StrykerMutantResult } from "./run.js";
import { TAMPERING_MARKER } from "./constants.js";

export interface MutantCounts {
  total: number;
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  /** Mutants that do not compile or crash Stryker itself: not counted in the score. */
  discarded: number;
}

/** A mutant that no law caught: behaviour the spec does not pin down. */
export interface Survivor {
  status: "Survived" | "NoCoverage";
  file: string;
  line: number;
  col: number;
  mutator: string;
  original: string;
  replacement: string;
  /** Innermost named function around the mutant, if any. */
  function: string | null;
}

/** A mutant run in which the code under test tampered with the runner (exit 4). */
export interface TamperedMutant {
  file: string;
  line: number;
  mutator: string;
  reason: string;
}

export interface MutationSummary {
  /** Killed + timeout over killed + timeout + survived + no coverage, in percent; null if nothing was valid. */
  score: number | null;
  counts: MutantCounts;
  survivors: Survivor[];
  tampering: TamperedMutant[];
}

const MAX_SNIPPET = 70;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SNIPPET ? `${flat.slice(0, MAX_SNIPPET - 1)}…` : flat;
}

interface ParsedFile {
  sf: ts.SourceFile;
}

function nameOf(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return node.name.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && ts.isIdentifier(node.name)) {
    const owner = ts.isClassLike(node.parent) && node.parent.name ? `${node.parent.name.text}.` : "";
    return `${owner}${node.name.text}`;
  }
  return null;
}

function enclosingFunction(sf: ts.SourceFile, pos: number): string | null {
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (pos < node.getStart(sf) || pos >= node.getEnd()) return;
    const name = nameOf(node);
    if (name !== null) found = name;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Stryker positions in results are 1-based (line and column). */
function originalText(file: ParsedFile, m: StrykerMutantResult): string {
  const { start, end } = m.location;
  const from = file.sf.getPositionOfLineAndCharacter(start.line - 1, start.column - 1);
  const to = file.sf.getPositionOfLineAndCharacter(end.line - 1, end.column - 1);
  return file.sf.text.slice(from, to);
}

export function summarizeMutants(root: string, results: StrykerMutantResult[]): MutationSummary {
  const counts: MutantCounts = { total: results.length, killed: 0, timeout: 0, survived: 0, noCoverage: 0, discarded: 0 };
  const cache = new Map<string, ParsedFile | null>();
  const parsed = (abs: string): ParsedFile | null => {
    if (!cache.has(abs)) {
      try {
        const text = readFileSync(abs, "utf8");
        cache.set(abs, { sf: ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true) });
      } catch {
        cache.set(abs, null);
      }
    }
    return cache.get(abs) ?? null;
  };

  const survivors: Survivor[] = [];
  const tampering: TamperedMutant[] = [];
  const rel = (fileName: string): string => (path.isAbsolute(fileName) ? relPosix(root, fileName) : toPosix(fileName));
  for (const m of results) {
    const reason = m.statusReason ?? "";
    if (m.status === "RuntimeError" && reason.includes(TAMPERING_MARKER)) {
      tampering.push({ file: rel(m.fileName), line: m.location.start.line, mutator: m.mutatorName, reason: reason.slice(reason.indexOf(TAMPERING_MARKER) + TAMPERING_MARKER.length).trim() });
      counts.discarded++;
      continue;
    }
    switch (m.status) {
      case "Killed":
        counts.killed++;
        continue;
      case "Timeout":
        counts.timeout++;
        continue;
      case "Survived":
        counts.survived++;
        break;
      case "NoCoverage":
        counts.noCoverage++;
        break;
      default:
        counts.discarded++;
        continue;
    }
    const abs = path.isAbsolute(m.fileName) ? m.fileName : path.join(root, m.fileName);
    const file = parsed(abs);
    const pos = file?.sf.getPositionOfLineAndCharacter(m.location.start.line - 1, m.location.start.column - 1);
    survivors.push({
      status: m.status,
      file: rel(m.fileName),
      line: m.location.start.line,
      col: m.location.start.column,
      mutator: m.mutatorName,
      original: file ? snippet(originalText(file, m)) : "",
      replacement: snippet(m.replacement ?? ""),
      function: file && pos !== undefined ? enclosingFunction(file.sf, pos) : null,
    });
  }
  survivors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);

  const detected = counts.killed + counts.timeout;
  const valid = detected + counts.survived + counts.noCoverage;
  return { score: valid === 0 ? null : (detected / valid) * 100, counts, survivors, tampering };
}
