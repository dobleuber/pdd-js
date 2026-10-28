/**
 * Translates a law marked `{ smt: true }` (TypeScript AST + type checker) into a proof problem:
 *
 *   pre   — the input domain, read from the arbitraries (arb.integer({min, max}), ...);
 *   goal  — the predicate is true AND every obligation holds: no value leaves the exact-integer
 *           range of a JS number, no divisor is 0, nothing throws.
 *
 * "For every input in pre, goal holds" is what Z3 is asked to prove. Anything outside the small
 * supported subset makes the whole law untranslatable, with the reason and the place: pdd smt
 * never reports a law as proven when part of it was not understood.
 *
 * Every integer here is a JS number that is an exact integer. That is true for every input
 * (the arbitraries only produce safe integers) and is kept by every operation: + - * results
 * must stay within Number.MAX_SAFE_INTEGER (an obligation), and `/` is only accepted inside
 * Math.floor / Math.ceil / Math.trunc, which are exact on safe integers.
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { relPosix } from "../shared/paths.js";
import * as ir from "./ir.js";
import type { Term } from "./ir.js";

export class Untranslatable extends Error {
  constructor(
    message: string,
    readonly node?: ts.Node,
  ) {
    super(message);
    this.name = "Untranslatable";
  }
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

type Value =
  | { kind: "int"; t: Term }
  | { kind: "bool"; t: Term }
  | { kind: "record"; fields: ReadonlyMap<string, Value> }
  | { kind: "tuple"; items: readonly Value[] }
  | { kind: "fn"; decl: FunctionLike; scope: Scope | undefined }
  /** The result of a path that throws: it has no value, and an obligation says it never runs. */
  | { kind: "never" };

const NEVER: Value = { kind: "never" };

/** Immutable chain of bindings, keyed by the checker's symbols (so shadowing is never confused). */
class Scope {
  constructor(
    private readonly vars: ReadonlyMap<ts.Symbol, Value>,
    private readonly parent: Scope | undefined,
  ) {}

  lookup(sym: ts.Symbol): Value | undefined {
    return this.vars.get(sym) ?? this.parent?.lookup(sym);
  }

  with(vars: ReadonlyMap<ts.Symbol, Value>): Scope {
    return new Scope(vars, this);
  }
}

const ROOT = new Scope(new Map(), undefined);

export interface Obligation {
  /** Must hold (it already includes the path condition). */
  cond: Term;
  reason: string;
  at: string;
}

/** Input domain, read from an arbitrary. */
export type Domain =
  | { kind: "int"; ranges: Array<{ min: bigint; max: bigint }> }
  | { kind: "bool"; values: boolean[] | null }
  | { kind: "record"; fields: Array<[string, Domain]> }
  | { kind: "tuple"; items: Domain[] };

export interface Leaf {
  /** Z3 constant name. */
  name: string;
  sort: "int" | "bool";
  /** Human-readable path, e.g. `item.price`. */
  label: string;
}

export interface LawSite {
  /** Absolute path of the law file. */
  file: string;
  /** Law file relative to the project root. */
  rel: string;
  line: number;
  name: string;
  call: ts.CallExpression;
}

export interface SmtProblem {
  site: LawSite;
  pre: Term;
  goal: Term;
  result: Term;
  obligations: Obligation[];
  leaves: Leaf[];
  /** Builds the forAll argument tuple from a model (for the replay in the real runner). */
  build(model: ir.Assignment): unknown[];
  /** Files the proof relies on (project-relative). */
  files: string[];
}

export type Translation = { ok: true; problem: SmtProblem } | { ok: false; site: LawSite; reason: string; at: string };

const JS_EXT = [".js", ".jsx", ".mjs", ".cjs"];
const TS_EXT = /\.(ts|tsx|mts|cts)$/;

function strip(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function describeKind(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    return "strings are not supported";
  }
  if (ts.isNewExpression(node)) return "`new` is not supported";
  if (ts.isAwaitExpression(node)) return "async code is not supported";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "a function is not a value pdd smt can reason about here";
  return `${ts.SyntaxKind[node.kind]} is not supported`;
}

/**
 * One translator per law: obligations and caches never leak from one law to another.
 */
class Translator {
  readonly obligations: Obligation[] = [];
  readonly files = new Set<string>();
  private readonly checker: ts.TypeChecker;
  private readonly callStack = new Set<FunctionLike>();
  private readonly moduleConsts = new Map<ts.Symbol, Value>();
  private readonly evaluating = new Set<ts.Symbol>();
  private counter = 0;

  constructor(
    private readonly program: ts.Program,
    private readonly root: string,
    private readonly pddApiFile: string | undefined,
  ) {
    this.checker = program.getTypeChecker();
  }

  at(node: ts.Node): string {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${relPosix(this.root, sf.fileName)}:${line + 1}`;
  }

  fail(message: string, node: ts.Node): never {
    throw new Untranslatable(message, node);
  }

  oblige(path: Term, cond: Term, reason: string, node: ts.Node): void {
    const c = ir.implies(path, cond);
    if (ir.constOf(c) === true) return;
    this.obligations.push({ cond: c, reason, at: this.at(node) });
  }

  // --- symbols -------------------------------------------------------------------------

  /** True when every declaration of the symbol comes from TypeScript's own lib files (a real global). */
  isGlobal(id: ts.Identifier, name: string): boolean {
    if (id.text !== name) return false;
    const sym = this.checker.getSymbolAtLocation(id);
    const decls = sym?.declarations ?? [];
    return decls.length > 0 && decls.every((d) => this.program.isSourceFileDefaultLibrary(d.getSourceFile()));
  }

  /** True when `id` is an import of `exportName` from the real "pdd" module. */
  isPddExport(id: ts.Identifier, exportName: string): boolean {
    if (this.pddApiFile === undefined) return false;
    const sym = this.checker.getSymbolAtLocation(id);
    if (!sym || (sym.flags & ts.SymbolFlags.Alias) === 0) return false;
    const target = this.checker.getAliasedSymbol(sym);
    if (target.name !== exportName) return false;
    const decl = target.valueDeclaration ?? target.declarations?.[0];
    if (!decl) return false;
    return samePath(decl.getSourceFile().fileName, this.pddApiFile);
  }

  /** The declaration a reference points to, following imports. Only project code is accepted. */
  private declarationOf(id: ts.Identifier): { sym: ts.Symbol; decl: ts.Declaration } {
    const local = this.checker.getSymbolAtLocation(id);
    if (!local) this.fail(`cannot resolve \`${id.text}\``, id);
    const sym = (local.flags & ts.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(local) : local;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) this.fail(`cannot resolve \`${id.text}\``, id);
    const sf = decl.getSourceFile();
    if (this.program.isSourceFileDefaultLibrary(sf)) this.fail(`the built-in \`${id.text}\` is not supported`, id);
    if (sf.isDeclarationFile || sf.fileName.split(/[\\/]/).includes("node_modules")) {
      this.fail(`\`${id.text}\` comes from a dependency; only project code can be translated`, id);
    }
    this.files.add(sf.fileName);
    return { sym, decl };
  }

  // --- expressions ---------------------------------------------------------------------

  expr(node: ts.Expression, scope: Scope, path: Term): Value {
    const n = strip(node);
    if (ts.isNumericLiteral(n)) {
      const v = Number(n.text);
      if (!Number.isSafeInteger(v)) this.fail(`only safe integer literals are supported (got ${n.getText()})`, n);
      return { kind: "int", t: ir.int(BigInt(v)) };
    }
    if (n.kind === ts.SyntaxKind.TrueKeyword) return { kind: "bool", t: ir.TRUE };
    if (n.kind === ts.SyntaxKind.FalseKeyword) return { kind: "bool", t: ir.FALSE };
    if (ts.isIdentifier(n)) return this.identifier(n, scope);
    if (ts.isPrefixUnaryExpression(n)) return this.prefix(n, scope, path);
    if (ts.isBinaryExpression(n)) return this.binary(n, scope, path);
    if (ts.isConditionalExpression(n)) {
      const c = this.bool(n.condition, scope, path);
      const a = this.expr(n.whenTrue, scope, ir.and(path, c));
      const b = this.expr(n.whenFalse, scope, ir.and(path, ir.not(c)));
      return this.merge(c, a, b, n);
    }
    if (ts.isPropertyAccessExpression(n)) return this.property(n, scope, path);
    if (ts.isElementAccessExpression(n)) return this.element(n, scope, path);
    if (ts.isCallExpression(n)) return this.callExpr(n, scope, path);
    if (ts.isObjectLiteralExpression(n)) return this.objectLiteral(n, scope, path);
    if (ts.isArrayLiteralExpression(n)) {
      const items = n.elements.map((e) => {
        if (ts.isSpreadElement(e) || ts.isOmittedExpression(e)) this.fail("spread and holes in array literals are not supported", e);
        return this.expr(e, scope, path);
      });
      return { kind: "tuple", items };
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return { kind: "fn", decl: n, scope };
    this.fail(describeKind(n), n);
  }

  int(node: ts.Expression, scope: Scope, path: Term): Term {
    const v = this.expr(node, scope, path);
    if (v.kind !== "int") this.fail(`expected a number here, got ${v.kind}`, node);
    return v.t;
  }

  bool(node: ts.Expression, scope: Scope, path: Term): Term {
    const v = this.expr(node, scope, path);
    if (v.kind !== "bool") this.fail(`expected a boolean here (truthiness of other values is not supported), got ${v.kind}`, node);
    return v.t;
  }

  private identifier(id: ts.Identifier, scope: Scope): Value {
    if (id.text === "undefined" && this.isGlobal(id, "undefined")) this.fail("`undefined` is not supported", id);
    const local = this.checker.getSymbolAtLocation(id);
    if (local) {
      const bound = scope.lookup(local);
      if (bound) return bound;
    }
    const { sym, decl } = this.declarationOf(id);
    const bound = scope.lookup(sym);
    if (bound) return bound;

    if (ts.isFunctionDeclaration(decl)) {
      if (!decl.body) this.fail(`\`${id.text}\` has no body`, id);
      return { kind: "fn", decl, scope: undefined };
    }
    if (ts.isVariableDeclaration(decl)) {
      const list = decl.parent;
      if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) {
        this.fail(`\`${id.text}\` is not a const: its value may change between runs`, id);
      }
      const statement = list.parent;
      const moduleLevel = ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
      if (!moduleLevel) this.fail(`\`${id.text}\` is out of scope here`, id);
      if (!ts.isIdentifier(decl.name) || !decl.initializer) this.fail(`\`${id.text}\` must be a plain const with a value`, id);
      return this.moduleConst(sym, decl.initializer, id);
    }
    if (ts.isParameter(decl) || ts.isBindingElement(decl)) this.fail(`\`${id.text}\` is out of scope here`, id);
    this.fail(`\`${id.text}\` (${ts.SyntaxKind[decl.kind]}) is not supported`, id);
  }

  /**
   * A module-level const. Only numbers, booleans and functions: an object held in a const can
   * still be mutated by other code, so its fields are not constants.
   */
  private moduleConst(sym: ts.Symbol, init: ts.Expression, ref: ts.Identifier): Value {
    const cached = this.moduleConsts.get(sym);
    if (cached) return cached;
    if (this.evaluating.has(sym)) this.fail(`\`${ref.text}\` refers to itself`, ref);
    this.evaluating.add(sym);
    let v: Value;
    try {
      v = this.expr(init, ROOT, ir.TRUE);
    } finally {
      this.evaluating.delete(sym);
    }
    if (v.kind === "record" || v.kind === "tuple") {
      this.fail(`\`${ref.text}\` is a module-level object; its fields can be mutated, so pdd smt cannot treat them as constants`, ref);
    }
    this.moduleConsts.set(sym, v);
    return v;
  }

  private prefix(n: ts.PrefixUnaryExpression, scope: Scope, path: Term): Value {
    switch (n.operator) {
      case ts.SyntaxKind.MinusToken:
        return { kind: "int", t: ir.neg(this.int(n.operand, scope, path)) };
      case ts.SyntaxKind.PlusToken:
        return { kind: "int", t: this.int(n.operand, scope, path) };
      case ts.SyntaxKind.ExclamationToken:
        return { kind: "bool", t: ir.not(this.bool(n.operand, scope, path)) };
      default:
        this.fail(`the operator ${ts.tokenToString(n.operator)} is not supported`, n);
    }
  }

  private arith(t: Term, path: Term, n: ts.Node): Value {
    this.oblige(path, ir.isSafe(t), `\`${n.getText()}\` may exceed Number.MAX_SAFE_INTEGER (JS numbers lose precision there)`, n);
    return { kind: "int", t };
  }

  private binary(n: ts.BinaryExpression, scope: Scope, path: Term): Value {
    const op = n.operatorToken.kind;
    const K = ts.SyntaxKind;
    if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
      const l = this.bool(n.left, scope, path);
      const rightPath = op === K.AmpersandAmpersandToken ? ir.and(path, l) : ir.and(path, ir.not(l));
      const r = this.bool(n.right, scope, rightPath);
      return { kind: "bool", t: op === K.AmpersandAmpersandToken ? ir.and(l, r) : ir.or(l, r) };
    }
    if (op === K.SlashToken) {
      this.fail("a division must be wrapped in Math.floor, Math.ceil or Math.trunc (a plain `/` is not an integer)", n);
    }
    const arithmetic = [K.PlusToken, K.MinusToken, K.AsteriskToken, K.PercentToken, K.LessThanToken, K.LessThanEqualsToken, K.GreaterThanToken, K.GreaterThanEqualsToken];
    if (arithmetic.includes(op)) {
      const a = this.int(n.left, scope, path);
      const b = this.int(n.right, scope, path);
      switch (op) {
        case K.PlusToken:
          return this.arith(ir.add(a, b), path, n);
        case K.MinusToken:
          return this.arith(ir.sub(a, b), path, n);
        case K.AsteriskToken:
          return this.arith(ir.mul(a, b), path, n);
        case K.PercentToken:
          this.oblige(path, ir.not(ir.eq(b, ir.int(0n))), `the divisor of \`${n.getText()}\` may be 0`, n);
          return { kind: "int", t: ir.tmod(a, b) };
        case K.LessThanToken:
          return { kind: "bool", t: ir.lt(a, b) };
        case K.LessThanEqualsToken:
          return { kind: "bool", t: ir.le(a, b) };
        case K.GreaterThanToken:
          return { kind: "bool", t: ir.lt(b, a) };
        default:
          return { kind: "bool", t: ir.le(b, a) };
      }
    }
    if ([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken].includes(op)) {
      const strict = op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken;
      const negate = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
      const a = this.expr(n.left, scope, path);
      const b = this.expr(n.right, scope, path);
      let t: Term;
      if ((a.kind === "int" && b.kind === "int") || (a.kind === "bool" && b.kind === "bool")) t = ir.eq(a.t, b.t);
      else if (strict && (a.kind === "int" || a.kind === "bool") && (b.kind === "int" || b.kind === "bool")) t = ir.FALSE;
      else this.fail(`comparing ${a.kind} with ${b.kind} using ${n.operatorToken.getText()} is not supported`, n);
      return { kind: "bool", t: negate ? ir.not(t) : t };
    }
    this.fail(`the operator ${n.operatorToken.getText()} is not supported`, n);
  }

  private property(n: ts.PropertyAccessExpression, scope: Scope, path: Term): Value {
    if (n.questionDotToken) this.fail("optional chaining is not supported", n);
    const target = strip(n.expression);
    if (ts.isIdentifier(target) && this.isGlobal(target, "Number")) {
      if (n.name.text === "MAX_SAFE_INTEGER") return { kind: "int", t: ir.int(ir.MAX_SAFE) };
      if (n.name.text === "MIN_SAFE_INTEGER") return { kind: "int", t: ir.int(-ir.MAX_SAFE) };
      this.fail(`Number.${n.name.text} is not supported`, n);
    }
    const obj = this.expr(n.expression, scope, path);
    if (obj.kind === "record") {
      const v = obj.fields.get(n.name.text);
      if (v === undefined) this.fail(`the record has no field \`${n.name.text}\` pdd smt knows of`, n);
      return v;
    }
    if (obj.kind === "tuple" && n.name.text === "length") return { kind: "int", t: ir.int(BigInt(obj.items.length)) };
    this.fail(`\`.${n.name.text}\` on a ${obj.kind} is not supported`, n);
  }

  private element(n: ts.ElementAccessExpression, scope: Scope, path: Term): Value {
    if (n.questionDotToken) this.fail("optional chaining is not supported", n);
    const obj = this.expr(n.expression, scope, path);
    const key = strip(n.argumentExpression);
    if (obj.kind === "tuple" && ts.isNumericLiteral(key)) {
      const v = obj.items[Number(key.text)];
      if (v === undefined) this.fail(`index ${key.text} is out of range`, n);
      return v;
    }
    if (obj.kind === "record" && ts.isStringLiteral(key)) {
      const v = obj.fields.get(key.text);
      if (v === undefined) this.fail(`the record has no field \`${key.text}\` pdd smt knows of`, n);
      return v;
    }
    this.fail("only literal indexes into tuples and records are supported", n);
  }

  private objectLiteral(n: ts.ObjectLiteralExpression, scope: Scope, path: Term): Value {
    const fields = new Map<string, Value>();
    for (const p of n.properties) {
      if (ts.isPropertyAssignment(p)) {
        const name = propName(p.name);
        if (name === undefined) this.fail("computed property names are not supported", p);
        fields.set(name, this.expr(p.initializer, scope, path));
      } else if (ts.isShorthandPropertyAssignment(p)) {
        const sym = this.checker.getShorthandAssignmentValueSymbol(p);
        const bound = sym ? scope.lookup(sym) : undefined;
        fields.set(p.name.text, bound ?? this.identifier(p.name, scope));
      } else if (ts.isSpreadAssignment(p)) {
        const v = this.expr(p.expression, scope, path);
        if (v.kind !== "record") this.fail("only records can be spread into an object", p);
        for (const [k, fv] of v.fields) fields.set(k, fv);
      } else {
        this.fail("methods and accessors in object literals are not supported", p);
      }
    }
    return { kind: "record", fields };
  }

  private merge(c: Term, a: Value, b: Value, node: ts.Node): Value {
    if (a.kind === "never") return b;
    if (b.kind === "never") return a;
    if (a.kind === "int" && b.kind === "int") return { kind: "int", t: ir.ite(c, a.t, b.t) };
    if (a.kind === "bool" && b.kind === "bool") return { kind: "bool", t: ir.ite(c, a.t, b.t) };
    if (a.kind === "record" && b.kind === "record") {
      const keys = [...a.fields.keys()];
      if (keys.length !== b.fields.size || keys.some((k) => !b.fields.has(k))) {
        this.fail("the branches build records with different fields", node);
      }
      return { kind: "record", fields: new Map(keys.map((k) => [k, this.merge(c, a.fields.get(k) as Value, b.fields.get(k) as Value, node)])) };
    }
    if (a.kind === "tuple" && b.kind === "tuple" && a.items.length === b.items.length) {
      return { kind: "tuple", items: a.items.map((x, i) => this.merge(c, x, b.items[i] as Value, node)) };
    }
    if (a.kind === "fn" && b.kind === "fn" && a.decl === b.decl && a.scope === b.scope) return a;
    this.fail(`the branches produce different kinds of value (${a.kind} and ${b.kind})`, node);
  }

  // --- calls ---------------------------------------------------------------------------

  private callExpr(n: ts.CallExpression, scope: Scope, path: Term): Value {
    if (n.questionDotToken) this.fail("optional calls are not supported", n);
    const callee = strip(n.expression);
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      if (this.isGlobal(callee.expression, "Math")) return this.mathCall(callee.name.text, n, scope, path);
      if (this.isGlobal(callee.expression, "Number")) return this.numberCall(callee.name.text, n, scope, path);
    }
    if (n.arguments.some((a) => ts.isSpreadElement(a))) this.fail("spread arguments are not supported", n);
    if (ts.isPropertyAccessExpression(callee)) this.fail(`method calls (\`.${callee.name.text}()\`) are not supported`, n);
    const fn = this.expr(callee, scope, path);
    if (fn.kind !== "fn") this.fail("only calls to functions declared in the project are supported", n);
    const args = n.arguments.map((a) => this.expr(a, scope, path));
    return this.call(fn, args, path, n);
  }

  private mathCall(name: string, n: ts.CallExpression, scope: Scope, path: Term): Value {
    const args = n.arguments;
    if (name === "floor" || name === "ceil" || name === "trunc") {
      const first = args[0];
      if (first === undefined) this.fail(`Math.${name}() needs an argument`, n);
      const inner = strip(first);
      if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.SlashToken) {
        const a = this.int(inner.left, scope, path);
        const b = this.int(inner.right, scope, path);
        this.oblige(path, ir.not(ir.eq(b, ir.int(0n))), `the divisor of \`${inner.getText()}\` may be 0`, inner);
        const t = name === "floor" ? ir.fdiv(a, b) : name === "ceil" ? ir.cdiv(a, b) : ir.tdiv(a, b);
        return { kind: "int", t };
      }
      return { kind: "int", t: this.int(first, scope, path) };
    }
    const ints = args.map((a) => this.int(a, scope, path));
    const [first, ...rest] = ints;
    if (first === undefined) this.fail(`Math.${name}() without arguments is not supported`, n);
    switch (name) {
      case "abs":
        return { kind: "int", t: ir.abs(first) };
      case "sign":
        return { kind: "int", t: ir.ite(ir.lt(first, ir.int(0n)), ir.int(-1n), ir.ite(ir.lt(ir.int(0n), first), ir.int(1n), ir.int(0n))) };
      case "min":
        return { kind: "int", t: rest.reduce(ir.min, first) };
      case "max":
        return { kind: "int", t: rest.reduce(ir.max, first) };
      default:
        this.fail(`Math.${name} is not supported`, n);
    }
  }

  private numberCall(name: string, n: ts.CallExpression, scope: Scope, path: Term): Value {
    if (name !== "isInteger" && name !== "isSafeInteger" && name !== "isFinite") this.fail(`Number.${name} is not supported`, n);
    const first = n.arguments[0];
    if (first === undefined) this.fail(`Number.${name}() needs an argument`, n);
    const v = this.expr(first, scope, path);
    // Every number here is a safe integer; booleans are not numbers.
    if (v.kind === "int") return { kind: "bool", t: ir.TRUE };
    if (v.kind === "bool") return { kind: "bool", t: ir.FALSE };
    this.fail(`Number.${name} of a ${v.kind} is not supported`, n);
  }

  call(fn: Extract<Value, { kind: "fn" }>, args: Value[], path: Term, at: ts.Node): Value {
    const decl = fn.decl;
    const name = decl.name && ts.isIdentifier(decl.name) ? decl.name.text : "the function";
    if (this.callStack.has(decl)) this.fail(`${name} is recursive; recursion is not supported`, at);
    if (!decl.body) this.fail(`${name} has no body`, at);
    if (decl.asteriskToken || decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      this.fail(`${name} is async or a generator; only plain functions are supported`, at);
    }
    this.files.add(decl.getSourceFile().fileName);
    const vars = new Map<ts.Symbol, Value>();
    decl.parameters.forEach((p, i) => {
      if (p.dotDotDotToken) this.fail("rest parameters are not supported", p);
      if (p.initializer) this.fail("default parameter values are not supported", p);
      const arg = args[i];
      if (arg === undefined) this.fail(`${name} is called without its parameter \`${p.name.getText()}\``, at);
      this.bind(p.name, arg, vars);
    });
    const scope = (fn.scope ?? ROOT).with(vars);
    this.callStack.add(decl);
    try {
      if (ts.isBlock(decl.body)) {
        return this.block(decl.body.statements, 0, scope, path, () => this.fail(`a path through ${name} ends without a return`, decl));
      }
      return this.expr(decl.body, scope, path);
    } finally {
      this.callStack.delete(decl);
    }
  }

  bind(name: ts.BindingName, value: Value, into: Map<ts.Symbol, Value>): void {
    if (ts.isIdentifier(name)) {
      const sym = this.checker.getSymbolAtLocation(name);
      if (!sym) this.fail(`cannot resolve \`${name.text}\``, name);
      into.set(sym, value);
      return;
    }
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      if (el.dotDotDotToken) this.fail("rest elements in destructuring are not supported", el);
      if (el.initializer) this.fail("default values in destructuring are not supported", el);
      let part: Value | undefined;
      if (ts.isObjectBindingPattern(name)) {
        if (value.kind !== "record") this.fail(`cannot destructure a ${value.kind} as an object`, el);
        const key = el.propertyName ? propName(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : undefined;
        if (key === undefined) this.fail("computed keys in destructuring are not supported", el);
        part = value.fields.get(key);
      } else {
        if (value.kind !== "tuple") this.fail(`cannot destructure a ${value.kind} as an array`, el);
        part = value.items[name.elements.indexOf(el)];
      }
      if (part === undefined) this.fail("destructuring reads a field pdd smt does not know of", el);
      this.bind(el.name, part, into);
    }
  }

  // --- statements ----------------------------------------------------------------------

  block(stmts: readonly ts.Statement[], i: number, scope: Scope, path: Term, cont: (path: Term) => Value): Value {
    if (i >= stmts.length) return cont(path);
    const s = stmts[i] as ts.Statement;
    const next = (sc: Scope, p: Term): Value => this.block(stmts, i + 1, sc, p, cont);

    if (ts.isVariableStatement(s)) {
      if ((s.declarationList.flags & ts.NodeFlags.Const) === 0) this.fail("only `const` declarations are supported (no let/var)", s);
      let sc = scope;
      for (const d of s.declarationList.declarations) {
        if (!d.initializer) this.fail("a const needs a value", d);
        const vars = new Map<ts.Symbol, Value>();
        this.bind(d.name, this.expr(d.initializer, sc, path), vars);
        sc = sc.with(vars);
      }
      return next(sc, path);
    }
    if (ts.isReturnStatement(s)) {
      if (!s.expression) this.fail("`return` without a value is not supported", s);
      return this.expr(s.expression, scope, path);
    }
    if (ts.isThrowStatement(s)) {
      this.oblige(path, ir.FALSE, "this `throw` may be reached", s);
      return NEVER;
    }
    if (ts.isIfStatement(s)) {
      const c = this.bool(s.expression, scope, path);
      const rest = (p: Term): Value => next(scope, p);
      const a = this.statement(s.thenStatement, scope, ir.and(path, c), rest);
      const elsePath = ir.and(path, ir.not(c));
      const b = s.elseStatement ? this.statement(s.elseStatement, scope, elsePath, rest) : rest(elsePath);
      return this.merge(c, a, b, s);
    }
    if (ts.isBlock(s)) return this.block(s.statements, 0, scope, path, (p) => next(scope, p));
    if (ts.isEmptyStatement(s)) return next(scope, path);
    if (ts.isExpressionStatement(s)) this.fail("statements with side effects are not supported", s);
    if (ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s)) {
      this.fail("loops are not supported", s);
    }
    if (ts.isTryStatement(s)) this.fail("try/catch is not supported", s);
    if (ts.isSwitchStatement(s)) this.fail("switch is not supported (use if/else)", s);
    this.fail(`${ts.SyntaxKind[s.kind]} is not supported`, s);
  }

  private statement(s: ts.Statement, scope: Scope, path: Term, cont: (path: Term) => Value): Value {
    return ts.isBlock(s) ? this.block(s.statements, 0, scope, path, cont) : this.block([s], 0, scope, path, cont);
  }

  // --- arbitraries ---------------------------------------------------------------------

  constInt(node: ts.Expression): bigint {
    const v = this.expr(node, ROOT, ir.TRUE);
    const c = v.kind === "int" ? ir.constOf(v.t) : undefined;
    if (typeof c !== "bigint") this.fail("this bound must be a constant integer", node);
    return c;
  }

  constScalar(node: ts.Expression): bigint | boolean {
    const v = this.expr(node, ROOT, ir.TRUE);
    const c = v.kind === "int" || v.kind === "bool" ? ir.constOf(v.t) : undefined;
    if (c === undefined) this.fail("this value must be a constant number or boolean", node);
    return c;
  }

  arbitrary(node: ts.Expression, depth = 0): Domain {
    if (depth > 50) this.fail("arbitraries nest too deeply", node);
    const n = strip(node);
    if (ts.isIdentifier(n)) {
      const { decl } = this.declarationOf(n);
      if (!ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isVariableDeclarationList(decl.parent) || (decl.parent.flags & ts.NodeFlags.Const) === 0) {
        this.fail(`\`${n.text}\` must be a const holding an arbitrary`, n);
      }
      return this.arbitrary(decl.initializer, depth + 1);
    }
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) {
      this.fail("pdd smt only understands arbitraries built directly with arb.*", n);
    }
    const callee = n.expression;
    const method = callee.name.text;
    if (!ts.isIdentifier(callee.expression) || !this.isPddExport(callee.expression, "arb")) {
      if (["map", "filter", "chain"].includes(method)) {
        this.fail(`\`.${method}()\` on an arbitrary is not supported: pdd smt cannot see through map/filter/chain`, n);
      }
      this.fail("pdd smt only understands arbitraries built with `arb.*` imported from \"pdd\"", n);
    }
    const args = n.arguments;
    const options = (allowed: string[]): Map<string, ts.Expression> => {
      const out = new Map<string, ts.Expression>();
      const first = args[0];
      if (args.length > 1) this.fail(`arb.${method}() takes at most one options object here`, n);
      if (first === undefined) return out;
      const o = strip(first);
      if (!ts.isObjectLiteralExpression(o)) this.fail(`arb.${method}() options must be an object literal`, first);
      for (const p of o.properties) {
        const key = ts.isPropertyAssignment(p) ? propName(p.name) : undefined;
        if (!ts.isPropertyAssignment(p) || key === undefined || !allowed.includes(key)) {
          this.fail(`arb.${method}() option ${p.name?.getText() ?? ""} is not supported (only ${allowed.join(", ")})`, p);
        }
        out.set(key, p.initializer);
      }
      return out;
    };
    const range = (min: bigint, max: bigint): Domain => {
      if (min > max) this.fail(`empty range: min ${min} > max ${max}`, n);
      if (min < -ir.MAX_SAFE || max > ir.MAX_SAFE) this.fail("integer bounds must be safe integers", n);
      return { kind: "int", ranges: [{ min, max }] };
    };
    const I32_MIN = -(2n ** 31n);
    const I32_MAX = 2n ** 31n - 1n;

    switch (method) {
      case "integer": {
        const o = options(["min", "max"]);
        const min = o.get("min");
        const max = o.get("max");
        return range(min ? this.constInt(min) : I32_MIN, max ? this.constInt(max) : I32_MAX);
      }
      case "nat": {
        const first = args[0];
        if (first !== undefined && !ts.isObjectLiteralExpression(strip(first))) {
          if (args.length > 1) this.fail("arb.nat() takes one argument", n);
          return range(0n, this.constInt(first));
        }
        const max = options(["max"]).get("max");
        return range(0n, max ? this.constInt(max) : I32_MAX);
      }
      case "maxSafeInteger":
        if (args.length > 0) this.fail("arb.maxSafeInteger() takes no arguments", n);
        return range(-ir.MAX_SAFE, ir.MAX_SAFE);
      case "maxSafeNat":
        if (args.length > 0) this.fail("arb.maxSafeNat() takes no arguments", n);
        return range(0n, ir.MAX_SAFE);
      case "boolean":
        if (args.length > 0) this.fail("arb.boolean() takes no arguments", n);
        return { kind: "bool", values: null };
      case "constant":
      case "constantFrom": {
        if (args.length === 0 || (method === "constant" && args.length > 1)) this.fail(`arb.${method}() needs ${method === "constant" ? "one value" : "values"}`, n);
        const values = args.map((a) => this.constScalar(a));
        if (values.every((v) => typeof v === "bigint")) {
          for (const v of values) range(v, v);
          return { kind: "int", ranges: values.map((v) => ({ min: v, max: v })) };
        }
        if (values.every((v) => typeof v === "boolean")) return { kind: "bool", values };
        this.fail(`arb.${method}() mixes numbers and booleans`, n);
      }
      case "oneof": {
        if (args.length === 0) this.fail("arb.oneof() needs arbitraries", n);
        const domains = args.map((a) => {
          if (ts.isObjectLiteralExpression(strip(a))) this.fail("arb.oneof() options and weighted arbitraries are not supported", a);
          return this.arbitrary(a, depth + 1);
        });
        if (domains.every((d) => d.kind === "int")) {
          return { kind: "int", ranges: domains.flatMap((d) => (d.kind === "int" ? d.ranges : [])) };
        }
        if (domains.every((d) => d.kind === "bool")) {
          const all = domains.some((d) => d.kind === "bool" && d.values === null);
          return { kind: "bool", values: all ? null : domains.flatMap((d) => (d.kind === "bool" ? (d.values ?? []) : [])) };
        }
        this.fail("arb.oneof() is only supported over numbers or over booleans", n);
      }
      case "record": {
        if (args.length !== 1) this.fail("arb.record() options are not supported", n);
        const model = strip(args[0] as ts.Expression);
        if (!ts.isObjectLiteralExpression(model)) this.fail("arb.record() needs an object literal", model);
        const fields: Array<[string, Domain]> = model.properties.map((p) => {
          const key = ts.isPropertyAssignment(p) ? propName(p.name) : undefined;
          if (!ts.isPropertyAssignment(p) || key === undefined) this.fail("arb.record() fields must be plain `key: arbitrary` entries", p);
          return [key, this.arbitrary(p.initializer, depth + 1)];
        });
        return { kind: "record", fields };
      }
      case "tuple":
        return { kind: "tuple", items: args.map((a) => this.arbitrary(a, depth + 1)) };
      default:
        this.fail(`arb.${method}() is not supported by pdd smt`, n);
    }
  }

  /** Creates the Z3 constants for a domain. */
  instantiate(domain: Domain, label: string, leaves: Leaf[], pre: Term[]): { value: Value; build: (m: ir.Assignment) => unknown } {
    switch (domain.kind) {
      case "int": {
        const name = `v${this.counter++}`;
        const t = ir.ivar(name);
        leaves.push({ name, sort: "int", label });
        pre.push(ir.or(...domain.ranges.map((r) => ir.and(ir.le(ir.int(r.min), t), ir.le(t, ir.int(r.max))))));
        return { value: { kind: "int", t }, build: (m) => Number(m.get(name) as bigint) };
      }
      case "bool": {
        const name = `v${this.counter++}`;
        const t = ir.bvar(name);
        leaves.push({ name, sort: "bool", label });
        if (domain.values !== null) pre.push(ir.or(...domain.values.map((v) => ir.eq(t, v ? ir.TRUE : ir.FALSE))));
        return { value: { kind: "bool", t }, build: (m) => m.get(name) as boolean };
      }
      case "record": {
        const parts = domain.fields.map(([k, d]) => [k, this.instantiate(d, `${label}.${k}`, leaves, pre)] as const);
        return {
          value: { kind: "record", fields: new Map(parts.map(([k, p]) => [k, p.value])) },
          build: (m) => Object.fromEntries(parts.map(([k, p]) => [k, p.build(m)])),
        };
      }
      case "tuple": {
        const parts = domain.items.map((d, i) => this.instantiate(d, `${label}[${i}]`, leaves, pre));
        return { value: { kind: "tuple", items: parts.map((p) => p.value) }, build: (m) => parts.map((p) => p.build(m)) };
      }
    }
  }

  // --- the law -------------------------------------------------------------------------

  law(site: LawSite): SmtProblem {
    let body = site.call.arguments[1];
    if (body === undefined) this.fail("the law has no body", site.call);
    body = strip(body);
    if ((ts.isArrowFunction(body) || ts.isFunctionExpression(body)) && body.parameters.length === 0 && !ts.isBlock(body.body)) {
      body = strip(body.body);
    }
    if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression) || !this.isPddExport(body.expression, "forAll")) {
      this.fail("the law body must be forAll(...) from \"pdd\" (forAllAsync and builders are not supported)", body);
    }
    const args = body.arguments;
    const predicate = args[args.length - 1];
    if (predicate === undefined || args.length < 2) this.fail("forAll needs arbitraries and a predicate", body);
    const pred = strip(predicate);
    if (!ts.isArrowFunction(pred) && !ts.isFunctionExpression(pred)) this.fail("the predicate must be written inline as a function", pred);
    if (pred.parameters.length > args.length - 1) this.fail("the predicate has more parameters than there are arbitraries", pred);

    const leaves: Leaf[] = [];
    const pre: Term[] = [];
    const inputs = args.slice(0, -1).map((a, i) => {
      const p = pred.parameters[i];
      const label = p && ts.isIdentifier(p.name) ? p.name.text : `arg${i + 1}`;
      return this.instantiate(this.arbitrary(a), label, leaves, pre);
    });

    const result = this.call({ kind: "fn", decl: pred, scope: undefined }, inputs.map((x) => x.value), ir.TRUE, pred);
    if (result.kind !== "bool") this.fail(`the predicate must return a boolean, here it returns ${result.kind}`, pred);
    const files = [...this.files].map((f) => relPosix(this.root, f)).sort();
    return {
      site,
      pre: ir.and(...pre),
      goal: ir.and(...this.obligations.map((o) => o.cond), result.t),
      result: result.t,
      obligations: this.obligations,
      leaves,
      build: (m) => inputs.map((x) => x.build(m)),
      files,
    };
  }
}

function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** The file TypeScript resolves `import ... from "pdd"` to, from a given law file. */
function resolvePddApi(program: ts.Program, fromFile: string): string | undefined {
  const r = ts.resolveModuleName("pdd", fromFile, program.getCompilerOptions(), ts.sys);
  return r.resolvedModule?.resolvedFileName;
}

/**
 * A TypeScript file with a JS file of the same name next to it: at runtime, an import of
 * "./x.js" loads x.js, which pdd smt never read.
 */
function shadowingSibling(file: string): string | undefined {
  if (!TS_EXT.test(file)) return undefined;
  const base = file.replace(TS_EXT, "");
  return JS_EXT.map((e) => base + e).find((f) => existsSync(f));
}

/** Finds the top-level `law(name, body, { smt: ... })` calls of a law file. */
export function findSmtLaws(program: ts.Program, root: string, lawFile: string): LawSite[] {
  const sf = program.getSourceFile(lawFile);
  if (!sf) return [];
  const t = new Translator(program, root, resolvePddApi(program, lawFile));
  const sites: LawSite[] = [];
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s)) continue;
    const call = strip(s.expression);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !t.isPddExport(call.expression, "law")) continue;
    const opts = call.arguments[2] ? strip(call.arguments[2]) : undefined;
    if (!opts || !ts.isObjectLiteralExpression(opts)) continue;
    const marked = opts.properties.some((p) => p.name !== undefined && propName(p.name) === "smt");
    if (!marked) continue;
    const nameArg = call.arguments[0];
    const name = nameArg && (ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg)) ? nameArg.text : "(unnamed)";
    const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf));
    sites.push({ file: lawFile, rel: relPosix(root, lawFile), line: line + 1, name, call });
  }
  return sites;
}

export function translateLaw(program: ts.Program, root: string, site: LawSite): Translation {
  const t = new Translator(program, root, resolvePddApi(program, site.file));
  const where = (node: ts.Node | undefined): string => (node ? t.at(node) : `${site.rel}:${site.line}`);
  const opts = strip(site.call.arguments[2] as ts.Expression) as ts.ObjectLiteralExpression;
  const smt = opts.properties.find((p) => p.name !== undefined && propName(p.name) === "smt");
  if (!smt || !ts.isPropertyAssignment(smt) || strip(smt.initializer).kind !== ts.SyntaxKind.TrueKeyword) {
    return { ok: false, site, reason: "the `smt` option must be the literal `true`", at: where(smt) };
  }
  try {
    const problem = t.law(site);
    for (const rel of problem.files) {
      const sibling = shadowingSibling(path.join(root, rel));
      if (sibling) {
        return {
          ok: false,
          site,
          reason: `${relPosix(root, sibling)} sits next to ${rel}: at runtime the import may load the JS file, which pdd smt did not read`,
          at: rel,
        };
      }
    }
    return { ok: true, problem };
  } catch (e) {
    if (e instanceof Untranslatable) return { ok: false, site, reason: e.message, at: where(e.node) };
    throw e;
  }
}
