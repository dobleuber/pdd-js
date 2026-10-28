# pdd — Proof-Driven Development for JS/TS

A tool to check that the code an AI agent writes does what it was asked to do, **with no
cheating**. It takes the idea behind [Bend 2](https://github.com/bendlang/bend) and Lean and
applies it to TypeScript, without rewriting anything:

1. **Laws written by a human** (`laws/*.laws.ts`): the spec, in TypeScript.
2. **A mechanical verdict** (`pdd check`): each law is tested against hundreds of random inputs
   (via [fast-check](https://fast-check.dev)). The agent does not decide when it is done; `pdd check` does.
3. **An anti-cheat layer**: a cryptographic lock on the spec, a scanner for escape hatches
   (`any`, `@ts-ignore`, `.skip`, mocks, patched built-ins, ...), a mandatory type check, and an
   isolated runner that detects when the code under test tries to tamper with it.
4. **A measure of law strength** (`pdd mutate`, `pdd coverage`): small bugs are injected into the
   code, and pdd reports the ones no law catches — the behaviour the spec does not pin down yet.

> This is not a mathematical proof: it is strong evidence that is hard to fake. See
> [Limits](#limits) and [docs/smt-design.md](docs/smt-design.md).

## Quick start

```bash
pnpm add -D pdd
pnpm exec pdd init --claude --ci
```

`init` creates `pdd.config.json`, an example law in `laws/`, the first `pdd.lock.json`, the
Claude Code hook (`--claude`) and a GitHub Actions workflow (`--ci`).

The workflow:

1. **The human** writes the laws and arbitraries in `laws/`, reviews them and runs `pdd lock`.
2. **The agent** writes the code in `src/`. It is done when `pdd check` passes.
3. **CI** runs `pdd check --ci` on a clean checkout. That is the verdict that counts.

## The law language

```ts
// laws/cart.laws.ts
import { law, forAll } from "pdd";
import { addItem, total } from "../src/cart.js";
import { arbCart, arbLineItem } from "./arbitraries.js";

law(
  "adding an item raises the total by exactly price × qty",
  forAll(arbCart, arbLineItem, (cart, item) => total(addItem(cart, item)) === total(cart) + item.price * item.qty),
);
```

- `law(name, forAll(...arbitraries, predicate), options?)` — options: `{ runs, timeoutMs }`.
- `forAllAsync(...)` for async predicates.
- `arb.*` — arbitraries (a curated subset of fast-check). Always import them from `"pdd"`.
- The predicate **must return `true` or `false`**. A forgotten `return` (`undefined`) or a
  `Promise` inside `forAll` makes the law fail, never pass.
- `law()` goes at the top level of the file, with a literal name. There is no `law.skip` or
  `law.only`.

Full example in [examples/shopping-cart](examples/shopping-cart).

## Commands

| Command | What it does |
|---|---|
| `pdd check` | Lock → guard → typecheck → laws. `--seed`, `--runs` (can only go up), `--filter`, `--json`, `--ci` |
| `pdd lock` | Records the hashes of the spec. **Humans only.** `--check`, `--diff`, `--sign` |
| `pdd guard` | Only the escape-hatch scanner. `--json`, `--list-rules` |
| `pdd init` | Sets up a project. `--claude`, `--ci`, `--sign` |
| `pdd hook` | Claude Code `PreToolUse` hook (reads JSON from stdin) |
| `pdd mutate` | Mutation testing with Stryker: lists the injected bugs no law catches. `--seed`, `--json`, `--ci` |
| `pdd coverage` | Lists exported functions no law reaches. `--json`, `--strict` |
| `pdd smt` | Phase 4, experimental, not implemented yet |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Everything passes |
| 1 | A law does not hold (with a counterexample and a command to reproduce it) |
| 2 | The spec does not match the lock (or the lock is missing, or its signature is invalid) |
| 3 | Static checks fail (guard or typecheck) |
| 4 | Tampering detected (modified built-ins, forged report, hidden laws, early exit) |
| 5 | Configuration or usage error (e.g. `--seed` in CI) |
| 6 | The laws are too weak: mutation score below `mutate.thresholds.break`, or `pdd coverage --strict` found exports no law reaches |

If the lock fails, `pdd check` stops there. Otherwise the priority is 4 > 3 > 1.

## Law strength

A law only guarantees what it says. `pdd mutate` measures how much the laws really pin down: it
uses [Stryker](https://stryker-mutator.io) to make small changes to `src/` (`<` → `<=`, `||` → `&&`,
a condition → `false`, ...) and runs the laws against each one. A **killed** mutant is a bug some
law catches; a **surviving** mutant is behaviour the spec does not check.

```text
! mutation   score 61.9%  (26 killed, 0 timeout, 12 survived, 4 no coverage, 13 discarded)
  Survived — some law runs this code, but none fails when it changes:
    src/cart.ts
      applyDiscount
        37:52   percent > 100  →  false  (ConditionalExpression)
```

That output is the shopping-cart example before it had laws for invalid input: nothing checked
that a 150 % discount is rejected. Adding three such laws took the score to 92.9 %; the only
survivors left are error-message strings, which no law needs to fix.

- **Install** (optional peer dependencies; `pdd check` does not need them, `pdd mutate` needs Node ≥ 22):

  ```bash
  pnpm add -D @stryker-mutator/core @stryker-mutator/api @stryker-mutator/typescript-checker
  ```

- `pdd mutate` first runs the whole `pdd check` pipeline (lock, guard, typecheck, laws): mutation
  testing needs a green baseline. Then Stryker runs the laws through pdd's own isolated runner, with
  per-law coverage, so each mutant only reruns the laws that reach it.
- Mutants that do not compile are discarded (Stryker's TypeScript checker), so they are not noise.
- The full HTML report goes to `reports/mutation/mutation.html`.
- **Every setting comes from the locked `pdd.config.json`.** `pdd mutate` refuses to run when a
  `stryker.config.*` file exists (it could exclude mutants), and guard rejects `// Stryker disable`
  comments and any reference to Stryker's globals in `src/`. If the code under test exits or tampers
  with the runner while a mutant is active (code that detects mutation testing to look strong), the
  run fails with exit 4 instead of counting the mutant as killed.

`pdd coverage` is the quick, static companion: it lists exported functions and classes that no law
names (**uncovered**), and those reached only through another function (**indirect**). It exits 0
unless you pass `--strict` or set `coverage.failOnUncovered`.

Settings, all under the lock:

```json
{
  "mutate": {
    "files": ["src/**/*.ts"],
    "thresholds": { "high": 80, "low": 60, "break": 70 },
    "concurrency": 4,
    "timeoutMs": 10000,
    "typecheck": true
  },
  "coverage": { "failOnUncovered": false, "ignore": ["src/index.ts"] }
}
```

`files` defaults to the `src` globs (never tests or the laws). `thresholds.break` is off by default;
set it to make CI fail when the laws get weaker.

## What the lock protects

`pdd.lock.json` stores the SHA-256 of:

- everything in `laws/` (laws **and** arbitraries: a weak arbitrary is just as effective a cheat);
- `pdd.config.json` (lowering `runs` or turning rules off breaks the lock);
- `lock.include` — by default `tsconfig.json` and `.github/workflows/*`.

When the `PDD_LOCK_KEY` variable is set (in CI, as a secret), the lock **must** be signed with
HMAC using that key. The agent can regenerate the hashes, but not the signature:

```bash
PDD_LOCK_KEY=<key> pnpm exec pdd lock --sign
```

Pass the key only on that command; do not leave it exported in the shell where the agent works.

## Guard rules

`pdd guard --list-rules` shows the full list:

| Rule | Applies to | Detects |
|---|---|---|
| `no-explicit-any` | src | `any` |
| `no-ts-suppress` | src, tests | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` |
| `no-eslint-disable` | src, tests | `eslint-disable`, `biome-ignore`, `Stryker disable`, ... |
| `no-unsafe-cast` | src | `x as unknown as T` |
| `no-non-null-assertion` | src | `x!` (warn by default; `max` option) |
| `no-test-skip` | tests | `.skip`, `.only`, `xit`, `fit`, ... |
| `no-mock-under-law` | tests | `vi.mock`/`jest.mock` of modules the laws use |
| `no-global-patch` | src | `Math.random = ...`, `Array.prototype.x = ...`, `Object.defineProperty(globalThis, ...)` |
| `no-dynamic-code` | src | `eval`, `new Function`, `import()`/`require()` with a computed specifier |
| `no-pdd-internals` | src | importing `pdd`, `fast-check`, `node_modules` paths or the laws; Stryker's globals (`__stryker__`) |
| `no-env-sniff` | src | reading `CI`, `GITHUB_ACTIONS`, `VITEST`, `PDD_*`, `__STRYKER_*`, ... |
| `no-runner-ipc` | src | `process.send`, `process.on("message")` |

They are configured in `pdd.config.json` (`"off" | "warn" | "error"` or `["error", { options }]`),
which is under the lock: changing them is a spec change that a human reviews.

## Threat model

Assumption: the agent can run any command and edit any local file. The local defenses (the hook,
guard) are seatbelts; **the wall is CI on a clean checkout**. The goal: any cheat is either caught
by CI or has to go through a diff reviewed by a human.

| Cheat | Defense |
|---|---|
| Editing a law or an arbitrary | Lock (2) + hook + CODEOWNERS |
| Editing and regenerating the lock | The diff shows up in the PR + HMAC signature in CI |
| Lowering `runs`, turning rules off, loosening `tsconfig`, touching CI | They are under the lock |
| Hardcoded answers (`if (n === 3) return 42`) | Random inputs with a fresh seed on every run; `--seed` forbidden in CI |
| `@ts-ignore`, `any`, `.skip`, `eslint-disable` | Guard (3) |
| Type errors (tsx does not check them) | Mandatory typecheck (3) |
| Mocking the module under law | The runner has no mocks + `no-mock-under-law` rule |
| Patching built-ins (`Math.random`, prototypes) | Static rule + runtime snapshot of built-ins (4) |
| Exiting early (`process.exit(0)`) | The runner requires a complete report: if it is missing, it fails (4) |
| Forging the report over IPC | Messages carry a nonce that the code under test never sees (4) |
| Hiding laws (`if (...) law(...)`) | Static count vs. runtime registrations (4) |
| Behaving differently in CI | `no-env-sniff` rule + law processes receive no CI variables |
| `NODE_OPTIONS=--require cheat.js` | Law processes do not inherit `NODE_OPTIONS` |
| Patching `node_modules` | In CI: `pnpm install --frozen-lockfile` |
| Weak laws that let wrong code pass | `pdd mutate` with a locked `break` threshold (6) |
| Hiding mutants (`// Stryker disable`, a `stryker.config.*` file) | Guard (3); `pdd mutate` refuses Stryker config files (5) |
| Detecting mutation testing to fail on purpose | Guard (3) + tampering under a mutant fails the run (4) |

All of this is covered by the red-team suites: [33 scenarios](redteam/redteam.test.ts) that play a
cheating agent against a copy of the example and check the exit code, plus
[7 for `pdd mutate` and `pdd coverage`](redteam/mutate.test.ts).

## Limits

- **A law only guarantees what it says.** If the laws are incomplete, the agent meets them to the
  letter and the result can still be wrong. Reviewing 20 laws is much easier than reviewing 500
  lines, but it is still human work. `pdd mutate` shows where they are weak; it cannot tell you
  what the laws should say.
- **Random testing, not mathematical proof.** For exhaustive proofs of pure functions, see
  [docs/smt-design.md](docs/smt-design.md).
- **The code under test runs in the same process as the runner.** A very elaborate attack could
  subvert it from the inside; the static rules, runtime checks and review make that hard, not
  impossible.
- **The hook is heuristic** (especially with Bash). It keeps an honest agent on track; CI is what
  enforces the spec.
- **Out of scope for pdd:** GitHub branch protection and CODEOWNERS. `pdd init --ci` prints the
  recommended setup.
- The typecheck uses the TypeScript 5.9 API bundled with pdd (TypeScript 7 no longer exposes that
  API in JS).

## Development

```bash
pnpm install
pnpm test          # build + unit tests + red-team
pnpm example       # build + pdd check on the example
pnpm --filter example-shopping-cart exec pdd mutate   # mutation testing on the example
```

Layout: `packages/pdd` (the tool), `examples/shopping-cart` (example project), `redteam` (cheat
scenarios), `docs/`.

### Roadmap

- **Phase 1 — MVP** ✔ laws, isolated runner, `pdd check`, example.
- **Phase 2 — Anti-cheat** ✔ lock + signature, guard, typecheck, hook, red-team.
- **Phase 3 — Law strength** ✔ `pdd mutate` (Stryker with a pdd test-runner plugin), `pdd coverage`.
  Still open: a vitest adapter (convenience only, never the verdict).
- **Phase 4 — Experimental SMT**: exhaustive proofs with Z3 for pure functions.
