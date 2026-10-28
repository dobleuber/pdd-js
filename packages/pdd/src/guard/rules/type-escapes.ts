/** Rules against switching off the type checker or the linter. */
import ts from "typescript";
import { comments, walk } from "../ast.js";
import type { GuardRule } from "../types.js";

const TS_SUPPRESS = /@ts-(ignore|expect-error|nocheck)\b/;
/** `// Stryker disable ...` hides mutants from `pdd mutate`, which would make weak laws look strong. */
const MUTATION_SUPPRESS = /\bStryker\s+(disable|restore)\b/i;
const LINT_SUPPRESS = /\b(eslint-disable(-next-line|-line)?|eslint\s+[\w@/-]+\s*:\s*(0|off|"off"|'off')|biome-ignore|oxlint-disable(-next-line)?|deno-lint-ignore(-file)?)\b/;

export const noExplicitAny: GuardRule = {
  id: "no-explicit-any",
  description: "`any` switches off type checking for everything it touches.",
  appliesTo: ["src"],
  defaultSeverity: "error",
  check(sf, ctx) {
    walk(sf, (n) => {
      if (n.kind === ts.SyntaxKind.AnyKeyword) ctx.report(n, "explicit `any` is not allowed");
    });
  },
};

export const noTsSuppress: GuardRule = {
  id: "no-ts-suppress",
  description: "@ts-ignore / @ts-expect-error / @ts-nocheck hide type errors instead of fixing them.",
  appliesTo: ["src", "test"],
  defaultSeverity: "error",
  check(sf, ctx) {
    for (const c of comments(sf)) {
      const m = TS_SUPPRESS.exec(c.text);
      if (m) ctx.report(c.pos, `\`@ts-${m[1]}\` is not allowed: fix the type error instead`);
    }
  },
};

export const noLintSuppress: GuardRule = {
  id: "no-eslint-disable",
  description: "Inline linter and mutation-testing suppressions (eslint-disable, biome-ignore, Stryker disable, ...) are not allowed.",
  appliesTo: ["src", "test"],
  defaultSeverity: "error",
  check(sf, ctx) {
    for (const c of comments(sf)) {
      if (LINT_SUPPRESS.test(c.text)) ctx.report(c.pos, "inline linter suppression is not allowed");
      else if (MUTATION_SUPPRESS.test(c.text)) ctx.report(c.pos, "Stryker disable comments are not allowed: they hide mutants from pdd mutate");
    }
  },
};

function isUnknownOrAny(type: ts.TypeNode): boolean {
  return type.kind === ts.SyntaxKind.UnknownKeyword || type.kind === ts.SyntaxKind.AnyKeyword;
}

function innerAssertion(e: ts.Expression): ts.AsExpression | ts.TypeAssertion | undefined {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return ts.isAsExpression(x) || ts.isTypeAssertionExpression(x) ? x : undefined;
}

export const noUnsafeCast: GuardRule = {
  id: "no-unsafe-cast",
  description: "Double casts (`x as unknown as T`) force any type onto any value.",
  appliesTo: ["src"],
  defaultSeverity: "error",
  check(sf, ctx) {
    walk(sf, (n) => {
      if (!ts.isAsExpression(n) && !ts.isTypeAssertionExpression(n)) return;
      const inner = innerAssertion(n.expression);
      if (inner && isUnknownOrAny(inner.type)) ctx.report(n, "double type assertion through `unknown`/`any` is not allowed");
    });
  },
};

export const noNonNullAssertion: GuardRule = {
  id: "no-non-null-assertion",
  description: "`x!` tells the compiler a value can't be null without proving it. Option: { max: number }.",
  appliesTo: ["src"],
  defaultSeverity: "warn",
  check(sf, ctx) {
    const found: ts.Node[] = [];
    walk(sf, (n) => {
      if (ts.isNonNullExpression(n)) found.push(n);
    });
    const max = typeof ctx.options.max === "number" ? ctx.options.max : 0;
    if (found.length > max) {
      for (const n of found) ctx.report(n, `non-null assertion \`!\` (${found.length} in this file, max ${max})`);
    }
  },
};
