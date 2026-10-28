/**
 * The logic pdd smt proves things in: mathematical integers and booleans.
 *
 * The TypeScript translator (translate.ts) produces these terms; z3.ts hands them to Z3, and
 * `evaluate` runs them in plain JS so tests can compare both against real JavaScript.
 *
 * Division and remainder follow JavaScript, not Z3: `fdiv` is Math.floor(a / b), `tdiv` is
 * Math.trunc(a / b) and `tmod` is a % b (the sign of the dividend). Division by zero has no
 * value here; the translator always adds an obligation that the divisor is not 0.
 */

export type Term =
  | { k: "int"; v: bigint }
  | { k: "bool"; v: boolean }
  | { k: "ivar"; name: string }
  | { k: "bvar"; name: string }
  | { k: "add" | "sub" | "mul" | "fdiv" | "tdiv" | "tmod"; a: Term; b: Term }
  | { k: "lt" | "le" | "eq"; a: Term; b: Term }
  | { k: "neg" | "not"; a: Term }
  | { k: "and" | "or"; args: Term[] }
  | { k: "ite"; c: Term; a: Term; b: Term };

/** Number.MAX_SAFE_INTEGER: every integer up to this size is exact in a JS number. */
export const MAX_SAFE = 2n ** 53n - 1n;

export const TRUE: Term = { k: "bool", v: true };
export const FALSE: Term = { k: "bool", v: false };

export const int = (v: bigint): Term => ({ k: "int", v });
export const ivar = (name: string): Term => ({ k: "ivar", name });
export const bvar = (name: string): Term => ({ k: "bvar", name });

const isInt = (t: Term): t is { k: "int"; v: bigint } => t.k === "int";
const isBool = (t: Term): t is { k: "bool"; v: boolean } => t.k === "bool";

/** Constant value of a term, if it has one after folding. */
export function constOf(t: Term): bigint | boolean | undefined {
  return t.k === "int" || t.k === "bool" ? t.v : undefined;
}

// --- JS semantics on bigints (b !== 0n) -------------------------------------------------

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b; // bigint division truncates
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

// --- smart constructors (fold constants, keep terms small) ------------------------------

export function add(a: Term, b: Term): Term {
  if (isInt(a) && isInt(b)) return int(a.v + b.v);
  if (isInt(b) && b.v === 0n) return a;
  if (isInt(a) && a.v === 0n) return b;
  return { k: "add", a, b };
}

export function sub(a: Term, b: Term): Term {
  if (isInt(a) && isInt(b)) return int(a.v - b.v);
  if (isInt(b) && b.v === 0n) return a;
  return { k: "sub", a, b };
}

export function mul(a: Term, b: Term): Term {
  if (isInt(a) && isInt(b)) return int(a.v * b.v);
  if (isInt(b) && b.v === 1n) return a;
  if (isInt(a) && a.v === 1n) return b;
  return { k: "mul", a, b };
}

export function neg(a: Term): Term {
  if (isInt(a)) return int(-a.v);
  return { k: "neg", a };
}

/** Math.floor(a / b). */
export function fdiv(a: Term, b: Term): Term {
  if (isInt(a) && isInt(b) && b.v !== 0n) return int(floorDiv(a.v, b.v));
  return { k: "fdiv", a, b };
}

/** Math.ceil(a / b) = -Math.floor(-a / b). */
export function cdiv(a: Term, b: Term): Term {
  return neg(fdiv(neg(a), b));
}

/** Math.trunc(a / b). */
export function tdiv(a: Term, b: Term): Term {
  if (isInt(a) && isInt(b) && b.v !== 0n) return int(a.v / b.v);
  return { k: "tdiv", a, b };
}

/** a % b (JS remainder: the sign of the dividend). */
export function tmod(a: Term, b: Term): Term {
  if (isInt(a) && isInt(b) && b.v !== 0n) return int(a.v % b.v);
  return { k: "tmod", a, b };
}

export function lt(a: Term, b: Term): Term {
  if (isInt(a) && isInt(b)) return { k: "bool", v: a.v < b.v };
  return { k: "lt", a, b };
}

export function le(a: Term, b: Term): Term {
  if (isInt(a) && isInt(b)) return { k: "bool", v: a.v <= b.v };
  return { k: "le", a, b };
}

/** Equality of two ints or two bools. */
export function eq(a: Term, b: Term): Term {
  if ((isInt(a) && isInt(b)) || (isBool(a) && isBool(b))) return { k: "bool", v: a.v === b.v };
  return { k: "eq", a, b };
}

export function not(a: Term): Term {
  if (isBool(a)) return { k: "bool", v: !a.v };
  if (a.k === "not") return a.a;
  return { k: "not", a };
}

export function and(...args: Term[]): Term {
  const kept: Term[] = [];
  for (const t of args) {
    if (isBool(t)) {
      if (!t.v) return FALSE;
      continue;
    }
    kept.push(t);
  }
  if (kept.length === 0) return TRUE;
  if (kept.length === 1) return kept[0] as Term;
  return { k: "and", args: kept };
}

export function or(...args: Term[]): Term {
  const kept: Term[] = [];
  for (const t of args) {
    if (isBool(t)) {
      if (t.v) return TRUE;
      continue;
    }
    kept.push(t);
  }
  if (kept.length === 0) return FALSE;
  if (kept.length === 1) return kept[0] as Term;
  return { k: "or", args: kept };
}

export function implies(a: Term, b: Term): Term {
  return or(not(a), b);
}

export function ite(c: Term, a: Term, b: Term): Term {
  if (isBool(c)) return c.v ? a : b;
  if (a === b) return a;
  return { k: "ite", c, a, b };
}

export const abs = (a: Term): Term => ite(lt(a, int(0n)), neg(a), a);
export const min = (a: Term, b: Term): Term => ite(le(a, b), a, b);
export const max = (a: Term, b: Term): Term => ite(le(a, b), b, a);

/** |a| <= MAX_SAFE: the value is exact in a JS number. */
export const isSafe = (a: Term): Term => and(le(int(-MAX_SAFE), a), le(a, int(MAX_SAFE)));

// --- plain evaluation (tests, and reading back a model) --------------------------------

export type Assignment = ReadonlyMap<string, bigint | boolean>;

/** Evaluates a term. Division by zero throws (the translator never lets it happen unguarded). */
export function evaluate(t: Term, env: Assignment): bigint | boolean {
  const n = (x: Term): bigint => {
    const v = evaluate(x, env);
    if (typeof v !== "bigint") throw new TypeError("pdd smt: expected an integer term");
    return v;
  };
  const b = (x: Term): boolean => {
    const v = evaluate(x, env);
    if (typeof v !== "boolean") throw new TypeError("pdd smt: expected a boolean term");
    return v;
  };
  const nonZero = (x: Term): bigint => {
    const v = n(x);
    if (v === 0n) throw new RangeError("pdd smt: division by zero");
    return v;
  };
  switch (t.k) {
    case "int":
    case "bool":
      return t.v;
    case "ivar":
    case "bvar": {
      const v = env.get(t.name);
      if (v === undefined) throw new Error(`pdd smt: unbound variable ${t.name}`);
      return v;
    }
    case "add":
      return n(t.a) + n(t.b);
    case "sub":
      return n(t.a) - n(t.b);
    case "mul":
      return n(t.a) * n(t.b);
    case "fdiv": {
      const d = nonZero(t.b);
      return floorDiv(n(t.a), d);
    }
    case "tdiv": {
      const d = nonZero(t.b);
      return n(t.a) / d;
    }
    case "tmod": {
      const d = nonZero(t.b);
      return n(t.a) % d;
    }
    case "lt":
      return n(t.a) < n(t.b);
    case "le":
      return n(t.a) <= n(t.b);
    case "eq":
      return evaluate(t.a, env) === evaluate(t.b, env);
    case "neg":
      return -n(t.a);
    case "not":
      return !b(t.a);
    case "and":
      return t.args.every((x) => b(x));
    case "or":
      return t.args.some((x) => b(x));
    case "ite":
      return b(t.c) ? evaluate(t.a, env) : evaluate(t.b, env);
  }
}
