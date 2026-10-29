import ts from "typescript";
import { PDD_PACKAGE } from "../shared/package-name.js";

export interface StaticViolation {
  line: number;
  col: number;
  message: string;
}

export interface StaticLawScan {
  /** Number of top-level `law(...)` calls. */
  count: number;
  /** Law names in declaration order. */
  names: string[];
  violations: StaticViolation[];
}

/**
 * Reads a law file without running it. The runner compares this with what
 * registers at runtime, so laws can't be hidden behind conditions
 * (`if (!process.env.CI) law(...)`) or registered from somewhere else.
 *
 * Rules: law() is imported from "@dobleuber/pdd", called directly (never aliased or passed
 * around), only as a top-level statement, with a string literal name.
 */
export function scanLawFile(fileName: string, text: string): StaticLawScan {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lawNames = new Set<string>();
  const namespaces = new Set<string>();
  const violations: StaticViolation[] = [];
  const names: string[] = [];
  let count = 0;

  const at = (node: ts.Node, message: string): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({ line: line + 1, col: character + 1, message });
  };

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text !== PDD_PACKAGE) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else
      for (const el of bindings.elements) {
        if ((el.propertyName ?? el.name).text === "law") lawNames.add(el.name.text);
      }
  }

  const isLawCallee = (expr: ts.Expression): boolean =>
    (ts.isIdentifier(expr) && lawNames.has(expr.text)) ||
    (ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      namespaces.has(expr.expression.text) &&
      expr.name.text === "law");

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLawCallee(node.expression)) {
      const stmt = node.parent;
      if (ts.isExpressionStatement(stmt) && stmt.expression === node && stmt.parent === sf) {
        count += 1;
        const first = node.arguments[0];
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          names.push(first.text);
        } else {
          at(node, "law() needs a string literal name");
        }
      } else {
        at(node, "law() must be called as a top-level statement (not inside conditions, loops or functions)");
      }
    } else if (ts.isIdentifier(node) && lawNames.has(node.text)) {
      const p = node.parent;
      const isImportBinding = ts.isImportSpecifier(p);
      const isCallee = ts.isCallExpression(p) && p.expression === node;
      if (!isImportBinding && !isCallee) at(node, "law must only be called directly, not aliased or passed around");
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      node.name.text === "law"
    ) {
      const p = node.parent;
      if (!(ts.isCallExpression(p) && p.expression === node)) {
        at(node, "law must only be called directly, not aliased or passed around");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { count, names, violations };
}
