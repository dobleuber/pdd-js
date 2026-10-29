/**
 * Runs the laws of ONE law file in an isolated process and reports to the
 * orchestrator over the IPC channel.
 *
 * Order matters:
 *   1. capture what we need (process.send, process.exit, the registry) before any user code runs;
 *   2. receive the nonce from the parent (user code never sees it, so it can't forge reports);
 *   3. snapshot built-ins, import the law file (which imports the code under test), re-check built-ins;
 *   4. run every registered law with fast-check, re-checking built-ins after each one;
 *   5. send `done` with the number and names of the laws that registered.
 * If this process dies before step 5, the parent treats the file as tampered (fail-closed).
 */
import { pathToFileURL } from "node:url";
import * as fc from "fast-check";
import { register as registerTsx } from "tsx/esm/api";
import { claimRegistry, unwrapProperty, type LawRecord } from "../api/registry.js";
import { snapshotIntrinsics } from "./intrinsics.js";
import type { ChildInit, ChildMessage, LawResult, MutantCoverage, MutationReport } from "./report.js";

const rawSend = typeof process.send === "function" ? process.send.bind(process) : undefined;
const exit = process.exit.bind(process);
const clock = performance.now.bind(performance);
const registry = claimRegistry();

function send(message: ChildMessage | { type: "ready" }): Promise<void> {
  return new Promise((resolve) => {
    if (!rawSend) return resolve();
    rawSend(message, undefined, undefined, () => resolve());
  });
}

/** The object Stryker's injected code reads and writes (`globalThis.__stryker__`). */
interface StrykerNamespace {
  activeMutant?: string;
  currentTestId?: string;
  mutantCoverage?: MutantCoverage;
  hitCount?: number;
  hitLimit?: number;
}

/**
 * pdd mutate only: install Stryker's namespace before any mutated code loads, so the
 * active mutant is already set when module-level ("static") code runs.
 */
function installStrykerNamespace(init: ChildInit): StrykerNamespace | undefined {
  if (init.mutation === null) return undefined;
  const ns: StrykerNamespace = {};
  if (init.mutation.activeMutant !== null) ns.activeMutant = init.mutation.activeMutant;
  if (init.mutation.hitLimit !== null) {
    ns.hitCount = 0;
    ns.hitLimit = init.mutation.hitLimit;
  }
  (globalThis as { __stryker__?: StrykerNamespace }).__stryker__ = ns;
  return ns;
}

function mutationReport(ns: StrykerNamespace | undefined): MutationReport | undefined {
  if (ns === undefined) return undefined;
  return { mutantCoverage: ns.mutantCoverage ?? null, hitCount: ns.hitCount ?? null };
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
  return String(e);
}

async function runLaw(record: LawRecord, init: ChildInit, ns: StrykerNamespace | undefined): Promise<LawResult> {
  const start = clock();
  if (ns !== undefined && init.mutation !== null) ns.currentTestId = `${init.mutation.testIdPrefix}${record.name}`;
  const numRuns = Math.max(record.options.runs ?? init.runs, init.runsOverride ?? 0);
  const base = { name: record.name, seed: init.seed, numRuns };
  let property: unknown;
  try {
    property = unwrapProperty(record.build());
  } catch (e) {
    return { ...base, status: "errored", error: formatError(e), timeMs: clock() - start };
  }
  if (property === undefined) {
    return {
      ...base,
      status: "errored",
      error: "the law body must be forAll(...) or forAllAsync(...) from \"@dobleuber/pdd\"",
      timeMs: clock() - start,
    };
  }
  // With examples (pdd smt replaying a Z3 counterexample), fast-check runs exactly those
  // tuples: they count towards numRuns, and endOnFailure keeps the original values.
  const examples = init.examples;
  const details = await fc.check(property as fc.IRawProperty<unknown[]>, {
    seed: init.seed,
    numRuns: examples === null ? numRuns : examples.length,
    interruptAfterTimeLimit: record.options.timeoutMs ?? init.timeoutMs,
    markInterruptAsFailure: true,
    ...(examples === null ? {} : { examples, endOnFailure: true }),
  });
  const timeMs = clock() - start;
  if (!details.failed) return { ...base, status: "passed", numRuns: details.numRuns, timeMs };

  const errorInstance = (details as { errorInstance?: unknown }).errorInstance;
  const error =
    errorInstance instanceof Error
      ? errorInstance.message
      : errorInstance != null
        ? String(errorInstance)
        : details.interrupted
          ? "interrupted: the law exceeded its time limit"
          : "the predicate returned false";
  const result: LawResult = { ...base, status: "failed", numRuns: details.numRuns, error, timeMs };
  if (details.counterexample !== null) result.counterexample = fc.stringify(details.counterexample);
  if (details.counterexamplePath !== null) result.path = details.counterexamplePath;
  return result;
}

async function main(init: ChildInit): Promise<void> {
  const { nonce } = init;
  registerTsx();
  const ns = installStrykerNamespace(init);
  const changedIntrinsics = snapshotIntrinsics();

  try {
    await import(pathToFileURL(init.file).href);
  } catch (e) {
    await send({ nonce, type: "load-error", error: formatError(e) });
    exit(0);
    return;
  }

  const afterLoad = changedIntrinsics();
  if (afterLoad.length > 0) {
    await send({ nonce, type: "tampering", reason: `built-ins were modified while loading: ${afterLoad.join(", ")}` });
  }

  const filter = init.filter === null ? null : new RegExp(init.filter);
  const only = init.names === null ? null : new Set(init.names);
  const total = registry.count();
  const names: string[] = [];
  const seen = new Set<string>();
  let bailed = false;

  for (let i = 0; i < total; i++) {
    const record = registry.at(i);
    if (!record) continue;
    names.push(record.name);
    let result: LawResult;
    if (seen.has(record.name)) {
      result = { name: record.name, status: "errored", numRuns: 0, seed: init.seed, timeMs: 0, error: "duplicate law name in this file" };
    } else if (bailed || (filter && !filter.test(record.name)) || (only && !only.has(record.name))) {
      result = { name: record.name, status: "skipped", numRuns: 0, seed: init.seed, timeMs: 0 };
    } else {
      result = await runLaw(record, init, ns);
      if (ns !== undefined) delete ns.currentTestId;
      if (init.bail && (result.status === "failed" || result.status === "errored")) bailed = true;
    }
    seen.add(record.name);
    await send({ nonce, type: "law", result });

    const changed = changedIntrinsics();
    if (changed.length > 0) {
      await send({
        nonce,
        type: "tampering",
        reason: `built-ins were modified while running "${record.name}": ${changed.join(", ")}`,
      });
    }
  }

  const mutation = mutationReport(ns);
  await send(mutation === undefined ? { nonce, type: "done", registered: total, names } : { nonce, type: "done", registered: total, names, mutation });
  exit(0);
}

if (!rawSend) {
  console.error("pdd: this file is started by `pdd check`; do not run it directly.");
  exit(70);
}

// If the orchestrator goes away (pdd mutate disposing a worker), do not linger.
process.once("disconnect", () => exit(0));

process.once("message", (message) => {
  main(message as ChildInit).catch(async (e: unknown) => {
    console.error(formatError(e));
    exit(70);
  });
});
void send({ type: "ready" });
