# pdd smt — design (phase 4, experimental, not implemented)

`pdd check` tests each law against hundreds of random inputs: that is strong evidence, not a proof.
`pdd smt` would be the next step for a small subset of the code: **verifying a law for every
possible input** with an SMT solver (Z3, through the `z3-solver` npm package, which ships Z3
compiled to WebAssembly).

## Scope

Only **pure, total** functions over simple data:

- bounded integers, booleans, tuples/records of those types, arrays of bounded length;
- no I/O, no mutation, no `this`, no closures over mutable state, no unbounded recursion.

Guard already recognizes much of this (no global patches, no dynamic code); a dedicated purity
analysis is still missing.

## Idea

1. Pick the laws marked with `law(name, body, { smt: true })` whose body is a `forAll` over
   translatable arbitraries (`arb.integer({min,max})`, `arb.boolean()`, `arb.record`, ...).
2. Translate the predicate and the functions it calls (TypeScript AST) into Z3 formulas.
3. Ask Z3 for a counterexample to `¬predicate`. `unsat` = the law holds for every input within the
   bounds; `sat` = a concrete counterexample, which is also replayed with fast-check.
4. If something cannot be translated, the law stays at the `test` level and pdd reports why
   (it is never marked as proven when it is not).

## Why it is not in the MVP

Prior work (RefScript, esverify) shows that translating general JS/TS into logic does not reach
production. The value is in a small, explicit subset, and in never lying about what was proven.
First, the laws + lock + anti-cheat flow has to work (phases 1–2), and law strength has to be
measured with mutation testing (phase 3).
