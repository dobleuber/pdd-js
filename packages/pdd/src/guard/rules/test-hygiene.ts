/** Rules for test files: no skipping tests, no mocking away the code the laws are about. */
import ts from "typescript";
import { resolveRelative, rootIdentifier, walk } from "../ast.js";
import type { GuardRule } from "../types.js";

const TEST_ROOTS = new Set(["describe", "it", "test", "suite", "context", "bench"]);
const SKIP_MEMBERS = new Set(["skip", "only", "todo", "skipIf", "runIf", "fails"]);
const SKIP_CALLEES = new Set(["xit", "xtest", "xdescribe", "xcontext", "fit", "fdescribe", "ftest"]);

export const noTestSkip: GuardRule = {
  id: "no-test-skip",
  description: "Skipped or focused tests (.skip, .only, xit, fit, ...) silently stop checking things.",
  appliesTo: ["test"],
  defaultSeverity: "error",
  check(sf, ctx) {
    walk(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && SKIP_MEMBERS.has(n.name.text)) {
        const root = rootIdentifier(n.expression);
        if (root && TEST_ROOTS.has(root.text)) ctx.report(n, `\`${root.text}...${n.name.text}\` is not allowed`);
        else if (n.expression.kind === ts.SyntaxKind.ThisKeyword && n.name.text === "skip") ctx.report(n, "`this.skip()` is not allowed");
      } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && SKIP_CALLEES.has(n.expression.text)) {
        ctx.report(n, `\`${n.expression.text}(...)\` is not allowed`);
      }
    });
  },
};

const MOCKERS = new Set(["vi.mock", "vi.doMock", "jest.mock", "jest.doMock", "jest.unstable_mockModule", "jest.setMock", "mock.module"]);

export const noMockUnderLaw: GuardRule = {
  id: "no-mock-under-law",
  description: "Tests must not replace modules that the laws are about (vi.mock / jest.mock on lawed code).",
  appliesTo: ["test"],
  defaultSeverity: "error",
  check(sf, ctx) {
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const target = n.expression.expression;
      if (!ts.isIdentifier(target)) return;
      if (!MOCKERS.has(`${target.text}.${n.expression.name.text}`)) return;
      const first = n.arguments[0];
      if (!first || !ts.isStringLiteralLike(first)) return;
      const resolved = resolveRelative(ctx.filePath, first.text);
      if (resolved && ctx.isLawedModule(resolved)) {
        ctx.report(n, `mocking "${first.text}" is not allowed: the laws depend on it`);
      }
    });
  },
};
