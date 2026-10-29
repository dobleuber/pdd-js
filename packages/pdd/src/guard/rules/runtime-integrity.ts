/**
 * Rules against code that attacks the verdict itself at runtime: patching
 * built-ins, loading code the scanner can't see, reaching into pdd or the
 * laws, or behaving differently when it detects it is being checked.
 */
import ts from "typescript";
import { isAssignmentOperator, memberNames, moduleSpecifiers, resolveRelative, rootIdentifier, walk } from "../ast.js";
import { isSniffedEnvVar } from "../../shared/env.js";
import type { GuardRule } from "../types.js";

const GLOBAL_ROOTS = new Set([
  "globalThis", "global", "window", "self",
  "Math", "Date", "JSON", "Object", "Array", "Function", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Promise", "Reflect", "Proxy", "Map", "Set", "WeakMap", "WeakSet", "Error", "RegExp", "Intl",
  "process", "performance", "crypto",
]);

function isGlobalTarget(expr: ts.Expression): boolean {
  const names = memberNames(expr);
  if (names.includes("__proto__")) return true;
  const root = rootIdentifier(expr);
  if (!root || !GLOBAL_ROOTS.has(root.text)) return false;
  // Writing env vars or the exit code is configuration, not patching a built-in.
  if (root.text === "process" && (names[0] === "env" || names[0] === "exitCode")) return false;
  return true;
}

const MUTATORS = new Set([
  "Object.defineProperty", "Object.defineProperties", "Object.assign", "Object.setPrototypeOf",
  "Reflect.set", "Reflect.defineProperty", "Reflect.setPrototypeOf", "Reflect.deleteProperty",
]);

export const noGlobalPatch: GuardRule = {
  id: "no-global-patch",
  description: "Assigning to built-ins (Math.random = ..., Array.prototype.x = ...) can make laws pass falsely.",
  appliesTo: ["src"],
  defaultSeverity: "error",
  check(sf, ctx) {
    walk(sf, (n) => {
      if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) {
        const left = n.left;
        if (ts.isIdentifier(left) && GLOBAL_ROOTS.has(left.text)) ctx.report(n, `reassigning the global \`${left.text}\` is not allowed`);
        else if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && isGlobalTarget(left)) {
          ctx.report(n, "modifying a built-in object is not allowed");
        }
      } else if (ts.isDeleteExpression(n) && isGlobalTarget(n.expression)) {
        ctx.report(n, "deleting from a built-in object is not allowed");
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
        const callee = `${n.expression.expression.text}.${n.expression.name.text}`;
        const first = n.arguments[0];
        if (MUTATORS.has(callee) && first && isGlobalTarget(first)) ctx.report(n, `\`${callee}\` on a built-in object is not allowed`);
      }
    });
  },
};

export const noDynamicCode: GuardRule = {
  id: "no-dynamic-code",
  description: "eval, new Function and computed import()/require() load code the scanner can't see.",
  appliesTo: ["src"],
  defaultSeverity: "error",
  check(sf, ctx) {
    walk(sf, (n) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const first = n.arguments[0];
        if (ts.isIdentifier(callee) && (callee.text === "eval" || callee.text === "Function")) {
          ctx.report(n, `\`${callee.text}(...)\` is not allowed`);
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "eval") {
          ctx.report(n, "`eval` is not allowed");
        } else if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
          if (!first || !ts.isStringLiteralLike(first)) ctx.report(n, "import()/require() with a computed specifier is not allowed");
        } else if (ts.isIdentifier(callee) && (callee.text === "setTimeout" || callee.text === "setInterval") && first && ts.isStringLiteralLike(first)) {
          ctx.report(n, `\`${callee.text}\` with a string body is not allowed`);
        }
      } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Function") {
        ctx.report(n, "`new Function(...)` is not allowed");
      }
    });
  },
};

const FORBIDDEN_PACKAGES = /^(@dobleuber\/pdd|pdd|fast-check|tsx|esbuild)(\/|$)|^@fast-check\//;

/** Names used by Stryker's instrumented code (`globalThis.__stryker__`, `stryMutAct_9fa48`, ...). */
const STRYKER_INTERNALS = /__stryker|stryMutAct_|stryCov_|stryNS_/i;

export const noPddInternals: GuardRule = {
  id: "no-pdd-internals",
  description: "Production code must not import pdd, fast-check, the runner, node_modules paths or the laws, nor touch Stryker's globals.",
  appliesTo: ["src"],
  defaultSeverity: "error",
  check(sf, ctx) {
    // Code that detects mutation testing could fail on purpose and make every mutant look killed.
    walk(sf, (n) => {
      if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteralLike(n)) && STRYKER_INTERNALS.test(n.text)) {
        ctx.report(n, `production code must not refer to Stryker's internals ("${n.text}")`);
      }
    });
    for (const { node, spec } of moduleSpecifiers(sf)) {
      if (FORBIDDEN_PACKAGES.test(spec)) {
        ctx.report(node, `importing "${spec}" from production code is not allowed`);
      } else if (spec.includes("node_modules/")) {
        ctx.report(node, `importing a node_modules path ("${spec}") is not allowed`);
      } else {
        const resolved = resolveRelative(ctx.filePath, spec);
        if (resolved && ctx.isInLawsDir(resolved)) ctx.report(node, `production code must not import the laws ("${spec}")`);
      }
    }
  },
};

/**
 * Flags the names of test/CI variables on ANY object (`process.env.CI`, but
 * also `env.CI` after aliasing, `x["PDD_SEED"]`, `const { CI } = env`).
 * The runner also strips these variables from the law processes, so the code
 * under test sees the same environment locally and in CI.
 */
export const noEnvSniff: GuardRule = {
  id: "no-env-sniff",
  description: "Code must not behave differently under test or CI (CI, GITHUB_ACTIONS, VITEST, PDD_*, ...).",
  appliesTo: ["src"],
  defaultSeverity: "error",
  check(sf, ctx) {
    walk(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && isSniffedEnvVar(n.name.text)) {
        ctx.report(n, `reading the test/CI variable ${n.name.text} is not allowed`);
      } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && isSniffedEnvVar(n.argumentExpression.text)) {
        ctx.report(n, `reading the test/CI variable "${n.argumentExpression.text}" is not allowed`);
      } else if (ts.isObjectBindingPattern(n)) {
        for (const el of n.elements) {
          const key = el.propertyName ?? el.name;
          if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && isSniffedEnvVar(key.text)) {
            ctx.report(el, `reading the test/CI variable ${key.text} is not allowed`);
          }
        }
      }
    });
  },
};

const IPC_MEMBERS = new Set(["send", "channel", "connected", "disconnect"]);

export const noRunnerIpc: GuardRule = {
  id: "no-runner-ipc",
  description: "Code must not talk to the process that runs it (process.send, process.on('message'), ...).",
  appliesTo: ["src"],
  defaultSeverity: "error",
  check(sf, ctx) {
    walk(sf, (n) => {
      if (!ts.isPropertyAccessExpression(n)) return;
      const root = rootIdentifier(n.expression);
      const names = memberNames(n);
      const isProcess = root?.text === "process" || (root?.text === "globalThis" && names[0] === "process");
      if (!isProcess) return;
      const member = root?.text === "process" ? names[0] : names[1];
      if (member && IPC_MEMBERS.has(member) && names.length === (root?.text === "process" ? 1 : 2)) {
        ctx.report(n, `process.${member} is not allowed in production code`);
        return;
      }
      if ((member === "on" || member === "once" || member === "addListener") && ts.isCallExpression(n.parent)) {
        const first = n.parent.arguments[0];
        if (first && ts.isStringLiteralLike(first) && first.text === "message") {
          ctx.report(n.parent, "listening to process 'message' events is not allowed in production code");
        }
      }
    });
  },
};
