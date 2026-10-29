# pdd smt — proofs with Z3 (experimental)

`pdd check` tests each law against hundreds of random inputs: strong evidence, not a proof.
`pdd smt` goes further for a small, explicit subset of the code: it asks the
[Z3](https://github.com/Z3Prover/z3) SMT solver whether **any** input the law's arbitraries can
produce breaks the law. If none can, the law is **proven** for all of them, including the ones
random testing never samples.

```ts
// laws/discount.laws.ts
import { law, forAll, arb } from "@dobleuber/pdd";
import { discounted } from "../src/cart.js";

law(
  "a discount never makes a total negative or larger",
  forAll(arb.integer({ min: 0, max: 1_000_000_000 }), arb.integer({ min: 0, max: 100 }), (t, p) => {
    const d = discounted(t, p);
    return d >= 0 && d <= t;
  }),
  { smt: true },
);
```

```text
pdd smt  experimental
✔ smt        3/3 proven, 0 counterexample(s), 0 not proven  (Z3 5.3.2.0)
  ✔ proven          a discount never makes a total negative or larger laws/discount.laws.ts:12 (143 ms)
```

`{ smt: true }` does not change `pdd check`: the law is still tested with random inputs like any
other. The option lives in the law file, so it is under the lock like the rest of the spec.

## Install and run

```bash
pnpm add -D z3-solver      # Z3 compiled to WebAssembly (~36 MB), an optional peer dependency
pnpm exec pdd smt          # --strict, --json, --ci, --seed
```

`pdd smt` first runs the whole `pdd check` pipeline (lock, guard, typecheck, laws); a proof is only
worth something on top of a spec that is locked, clean and passing. Then, for each law marked
`{ smt: true }`:

| Result | Meaning | Exit code |
|---|---|---|
| **proven** | Z3 shows that no input breaks the law | 0 |
| **counterexample** | Z3 found an input, and the law **fails on it in the real runner** | 1 |
| **not proven** | The law could not be translated, Z3 gave up, or Z3's input does not break the law at runtime | 0, or **7** with `--strict` / `smt.requireProof` |
| **tampering** | The code under test tampered with the runner while replaying Z3's input | 4 |

```json
{ "smt": { "timeoutMs": 10000, "requireProof": false } }
```

`timeoutMs` is the time Z3 may spend on one law. With `requireProof: true` (or `--strict`), every
law marked `{ smt: true }` must be proven, or the run fails with exit 7. The shopping-cart example
sets it, and its CI runs `pdd smt --ci`.

## What can be proven

The law and every function it calls must stay inside this subset. pdd translates the TypeScript
itself (AST + type checker), so there are no annotations to write.

**Inputs** — the arbitraries in `forAll`, written directly or as `const`s in the laws folder:

- `arb.integer({ min, max })`, `arb.nat(max)`, `arb.maxSafeInteger()`, `arb.maxSafeNat()` with
  constant bounds;
- `arb.boolean()`, `arb.constant(v)`, `arb.constantFrom(...values)` with constant numbers or booleans;
- `arb.oneof(...)` over numbers or over booleans; `arb.record({ ... })` and `arb.tuple(...)` of the above.

**Code** — functions declared in the project (`function` or `const f = (...) => ...`):

- integer arithmetic `+ - * %`, `/` only inside `Math.floor`, `Math.ceil` or `Math.trunc`;
- `Math.abs`, `Math.min`, `Math.max`, `Math.sign`, `Number.isInteger`, `Number.isSafeInteger`,
  `Number.isFinite`, `Number.MAX_SAFE_INTEGER`, `Number.MIN_SAFE_INTEGER`;
- comparisons, `=== !== == !=` between numbers or booleans, `&& || !`, `? :`;
- `const` (with destructuring), `if` / `else`, `return`, `throw`;
- object and array literals (with spread of objects), field access, calls to other such functions;
- module-level `const`s holding numbers, booleans or functions.

**Not supported** (the law is reported as *not translatable*, with the reason and the line):
strings, arrays of any length and their methods, loops, recursion, `let` / `var`, mutation,
`try` / `catch`, `switch`, classes and methods, async code, `.map` / `.filter` / `.chain` on
arbitraries, dependencies from `node_modules`, and module-level objects (their fields can be
mutated, so they are not constants).

## Why a "proven" can be trusted

The translator is the part that could lie, so it is built to fail closed:

- **JavaScript numbers, not mathematical integers.** Every value is a JS number that is an exact
  integer. Each `+`, `-` and `*` adds an obligation that its result stays within
  `Number.MAX_SAFE_INTEGER`, where JS arithmetic is exact. `/` is only accepted inside
  `Math.floor` / `Math.ceil` / `Math.trunc`, which are exact on safe integers, and every divisor
  must be provably non-zero. `%` follows JS (the sign of the dividend), not Z3's Euclidean `mod`.
- **Nothing may throw.** A reachable `throw` is an obligation that fails, because a law whose
  predicate throws fails at runtime.
- **The proof goal is "the predicate returns true and every obligation holds"** for every input in
  the arbitraries' ranges. Z3 is asked for an input that breaks it.
- **Every counterexample is replayed in the real, isolated runner.** If the law fails on it, it is
  a counterexample (exit 1). If the law holds on it, the input broke one of pdd's assumptions
  (e.g. a sum may leave the safe-integer range) without breaking the law: the law is reported as
  *not proven*, never as proven.
- **Names are resolved with the type checker.** `Math` must be the real global (a local
  `const Math = ...` is not), `arb`, `law` and `forAll` must come from `"@dobleuber/pdd"`, and every reference
  is followed to its declaration.
- **The file that runs is the file that was read.** If a `.js` file sits next to a `.ts` file the
  proof relies on, the law is not translated: at runtime the import could load the `.js` file.
- **Differential tests** compare the translation with real JavaScript on sampled inputs, both
  through pdd's own evaluator and through Z3 (`packages/pdd/test/smt.test.ts`), and the red-team
  suite plays the cheats against the real CLI (`redteam/smt.test.ts`).

## Limits

- The subset is small on purpose. Prior work (RefScript, esverify) shows that translating general
  JS/TS into logic does not reach production; the value is in pure integer logic (prices, limits,
  rounding, state machines over numbers) and in never reporting more than was proven.
- "Proven" is relative to the arbitraries: a law over `arb.integer({ min: 0, max: 100 })` says
  nothing about 101. The arbitraries are part of the locked spec, so a human chooses those ranges.
- Non-linear arithmetic (`x * y` with both unknown) can make Z3 give up; the law is then *not
  proven* and pdd says so.
- `pdd smt` trusts the same things as `pdd check`: the lock, guard and the isolated runner. In
  particular, guard forbids patching built-ins such as `Math`, which the translation relies on.
