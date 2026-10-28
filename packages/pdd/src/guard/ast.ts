import { existsSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export function scriptKindFor(fileName: string): ts.ScriptKind {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

export function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
}

export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export interface CommentRange {
  pos: number;
  text: string;
}

/** Every comment in the file, found through the parser (so strings and regexes can't fake one). */
export function comments(sf: ts.SourceFile): CommentRange[] {
  const text = sf.getFullText();
  const seen = new Map<number, CommentRange>();
  const add = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (!seen.has(r.pos)) seen.set(r.pos, { pos: r.pos, text: text.slice(r.pos, r.end) });
    }
  };
  const visit = (node: ts.Node): void => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

/** Leftmost identifier of a.b.c / a["b"].c / a.b() chains. */
export function rootIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isIdentifier(e)) return e;
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else return undefined;
  }
}

/** Property names along a member chain, e.g. `Object.prototype.x` -> ["prototype", "x"]. */
export function memberNames(expr: ts.Expression): string[] {
  const names: string[] = [];
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      names.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isElementAccessExpression(e)) {
      const arg = e.argumentExpression;
      names.unshift(ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg) ? arg.text : "[computed]");
      e = e.expression;
    } else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) {
      e = e.expression;
    } else return names;
  }
}

export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Module specifiers of static imports/exports, `import("x")`, `require("x")` and `import x = require("x")`. */
export function moduleSpecifiers(sf: ts.SourceFile): { node: ts.Node; spec: string }[] {
  const out: { node: ts.Node; spec: string }[] = [];
  walk(sf, (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ node: n, spec: n.moduleSpecifier.text });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      if (ts.isStringLiteral(e)) out.push({ node: n, spec: e.text });
    } else if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      const first = n.arguments[0];
      if ((isImport || isRequire) && first && ts.isStringLiteralLike(first)) out.push({ node: n, spec: first.text });
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      out.push({ node: n, spec: n.argument.literal.text });
    }
  });
  return out;
}

const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** Resolves a relative specifier the way TS + NodeNext would (x.js -> x.ts, folder -> index). */
export function resolveRelative(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  const ext = path.extname(base);
  const candidates = [base];
  for (const alt of JS_TO_TS[ext] ?? []) candidates.push(base.slice(0, -ext.length) + alt);
  for (const e of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) candidates.push(base + e);
  for (const e of [".ts", ".tsx", ".js"]) candidates.push(path.join(base, `index${e}`));
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      // ignore unreadable candidates
    }
  }
  return undefined;
}
