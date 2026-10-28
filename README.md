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
| `pdd mutate` | Phase 3, not implemented yet |
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

If the lock fails, `pdd check` stops there. Otherwise the priority is 4 > 3 > 1.

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
| `no-eslint-disable` | src, tests | `eslint-disable`, `biome-ignore`, ... |
| `no-unsafe-cast` | src | `x as unknown as T` |
| `no-non-null-assertion` | src | `x!` (warn by default; `max` option) |
| `no-test-skip` | tests | `.skip`, `.only`, `xit`, `fit`, ... |
| `no-mock-under-law` | tests | `vi.mock`/`jest.mock` of modules the laws use |
| `no-global-patch` | src | `Math.random = ...`, `Array.prototype.x = ...`, `Object.defineProperty(globalThis, ...)` |
| `no-dynamic-code` | src | `eval`, `new Function`, `import()`/`require()` with a computed specifier |
| `no-pdd-internals` | src | importing `pdd`, `fast-check`, `node_modules` paths or the laws |
| `no-env-sniff` | src | reading `CI`, `GITHUB_ACTIONS`, `VITEST`, `PDD_*`, ... |
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

All of this is covered by the [red-team suite](redteam/redteam.test.ts): 31 scenarios that play a
cheating agent against a copy of the example and check the exit code.

## Limits

- **A law only guarantees what it says.** If the laws are incomplete, the agent meets them to the
  letter and the result can still be wrong. Reviewing 20 laws is much easier than reviewing 500
  lines, but it is still human work. Phase 3 (mutation testing) measures how strong they are.
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
```

Layout: `packages/pdd` (the tool), `examples/shopping-cart` (example project), `redteam` (cheat
scenarios), `docs/`.

### Roadmap

- **Phase 1 — MVP** ✔ laws, isolated runner, `pdd check`, example.
- **Phase 2 — Anti-cheat** ✔ lock + signature, guard, typecheck, hook, red-team.
- **Phase 3 — Law strength**: `pdd mutate` (Stryker with a runner that calls `pdd check`), a report
  of exported functions with no law, a vitest adapter (convenience only, never the verdict).
- **Phase 4 — Experimental SMT**: exhaustive proofs with Z3 for pure functions.
