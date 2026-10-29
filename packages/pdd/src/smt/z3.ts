/**
 * Hands pdd smt's terms (ir.ts) to Z3 and reads back the answer.
 *
 * z3-solver (Z3 compiled to WebAssembly, ~36 MB) is an optional peer dependency: it is loaded
 * with a dynamic import only here, so `pdd check` never pays for it.
 */
import { pathToFileURL } from "node:url";
import type { Arith, Bool, Context, Expr, Z3HighLevel, Z3LowLevel } from "z3-solver";
import { ExitCode, PddError } from "../shared/exit-codes.js";
import { addDevCommand } from "../shared/install-hint.js";
import { resolvePackage } from "../shared/resolve.js";
import type { Assignment, Term } from "./ir.js";
import type { Leaf } from "./translate.js";

export const Z3_PACKAGE = "z3-solver";
export const Z3_VERSION_RANGE = "^5.3.2";

type Z3 = Context<"pdd">;
type Z3Module = { init(): Promise<Z3HighLevel & Z3LowLevel>; killThreads(em: unknown): Promise<void> };

export type ProofOutcome =
  | { status: "unsat" }
  | { status: "unknown"; reason: string }
  | { status: "sat"; model: Assignment };

export interface Z3Session {
  readonly version: string;
  /** Looks for an input that satisfies `pre` but not `goal`. */
  check(pre: Term, goal: Term, leaves: Leaf[], timeoutMs: number): Promise<ProofOutcome>;
  close(): Promise<void>;
}

export async function openZ3(root: string): Promise<Z3Session> {
  const resolved = resolvePackage(root, Z3_PACKAGE);
  if (resolved === undefined) {
    throw new PddError(`pdd smt needs Z3. Install it with:\n  ${addDevCommand(root, [`${Z3_PACKAGE}@${Z3_VERSION_RANGE}`])}`, ExitCode.CONFIG_ERROR);
  }
  const mod = (await import(pathToFileURL(resolved).href)) as Z3Module;
  const api = await mod.init();
  const ctx = new api.Context("pdd") as Z3;
  const version = api.Z3.get_full_version().split(" ")[0] ?? "unknown";

  return {
    version,
    async check(pre, goal, leaves, timeoutMs) {
      const vars = new Map<string, Expr<"pdd">>();
      for (const l of leaves) vars.set(l.name, l.sort === "int" ? ctx.Int.const(l.name) : ctx.Bool.const(l.name));
      const toZ3 = translator(ctx, vars);
      const solver = new ctx.Solver();
      solver.set("timeout", timeoutMs);
      solver.add(toZ3.bool(pre));
      solver.add(ctx.Not(toZ3.bool(goal)));
      const answer = await solver.check();
      if (answer === "unsat") return { status: "unsat" };
      if (answer === "unknown") return { status: "unknown", reason: solver.reasonUnknown() };
      const model = solver.model();
      const values = new Map<string, bigint | boolean>();
      for (const l of leaves) {
        const v = model.eval(vars.get(l.name) as Expr<"pdd">, true);
        if (l.sort === "int") {
          if (!ctx.isIntVal(v)) throw new Error(`pdd smt: Z3 gave a non-integer value for ${l.label}`);
          values.set(l.name, v.value());
        } else {
          values.set(l.name, ctx.isTrue(v));
        }
      }
      return { status: "sat", model: values };
    },
    async close() {
      await mod.killThreads(api.em);
    },
  };
}

function translator(ctx: Z3, vars: ReadonlyMap<string, Expr<"pdd">>): { int(t: Term): Arith<"pdd">; bool(t: Term): Bool<"pdd"> } {
  const memo = new Map<Term, Expr<"pdd">>();
  const zero = ctx.Int.val(0);

  /** Math.floor(a / b) with Z3's Euclidean `div` (which floors only for b > 0). */
  const floorDiv = (a: Arith<"pdd">, b: Arith<"pdd">): Arith<"pdd"> => ctx.If(b.gt(zero), a.div(b), a.neg().div(b.neg())) as Arith<"pdd">;
  /** Math.trunc(a / b): round towards zero. */
  const abs = (a: Arith<"pdd">): Arith<"pdd"> => ctx.If(a.ge(zero), a, a.neg()) as Arith<"pdd">;
  const truncDiv = (a: Arith<"pdd">, b: Arith<"pdd">): Arith<"pdd"> => {
    const q = abs(a).div(abs(b)); // both non-negative: Euclidean div is the floor
    return ctx.If(a.ge(zero).eq(b.gt(zero)), q, q.neg()) as Arith<"pdd">;
  };

  const go = (t: Term): Expr<"pdd"> => {
    const hit = memo.get(t);
    if (hit) return hit;
    let e: Expr<"pdd">;
    switch (t.k) {
      case "int":
        e = ctx.Int.val(t.v);
        break;
      case "bool":
        e = ctx.Bool.val(t.v);
        break;
      case "ivar":
      case "bvar": {
        const v = vars.get(t.name);
        if (!v) throw new Error(`pdd smt: unbound variable ${t.name}`);
        e = v;
        break;
      }
      case "add":
        e = int(t.a).add(int(t.b));
        break;
      case "sub":
        e = int(t.a).sub(int(t.b));
        break;
      case "mul":
        e = int(t.a).mul(int(t.b));
        break;
      case "fdiv":
        e = floorDiv(int(t.a), int(t.b));
        break;
      case "tdiv":
        e = truncDiv(int(t.a), int(t.b));
        break;
      case "tmod": {
        const a = int(t.a);
        const b = int(t.b);
        e = a.sub(b.mul(truncDiv(a, b)));
        break;
      }
      case "lt":
        e = int(t.a).lt(int(t.b));
        break;
      case "le":
        e = int(t.a).le(int(t.b));
        break;
      case "eq":
        e = go(t.a).eq(go(t.b));
        break;
      case "neg":
        e = int(t.a).neg();
        break;
      case "not":
        e = ctx.Not(bool(t.a));
        break;
      case "and":
        e = ctx.And(...t.args.map(bool));
        break;
      case "or":
        e = ctx.Or(...t.args.map(bool));
        break;
      case "ite":
        e = ctx.If(bool(t.c), go(t.a), go(t.b)) as Expr<"pdd">;
        break;
    }
    memo.set(t, e);
    return e;
  };
  const int = (t: Term): Arith<"pdd"> => go(t) as Arith<"pdd">;
  const bool = (t: Term): Bool<"pdd"> => go(t) as Bool<"pdd">;
  return { int, bool };
}
