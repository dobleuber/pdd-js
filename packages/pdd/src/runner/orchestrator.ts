import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import type { PddConfig } from "../config/schema.js";
import { isSniffedEnvVar } from "../shared/env.js";
import { relPosix } from "../shared/paths.js";
import { discoverLawFiles } from "./discover.js";
import { summarize, type ChildInit, type FileResult, type LawResult, type LawsReport, type MutationReport } from "./report.js";
import { scanLawFile } from "./static-count.js";

export interface RunLawsOptions {
  config: PddConfig;
  seed: number;
  filter?: string;
  runsOverride?: number;
  /** Override the law files (absolute paths); defaults to discovery under lawsDir. */
  files?: string[];
  /** pdd mutate only: exact law names to run in this file. */
  names?: string[];
  /** pdd mutate only: stop at the first failing law. */
  bail?: boolean;
  /** pdd mutate only: activate a mutant and/or collect Stryker coverage. */
  mutation?: { activeMutant: string | null; hitLimit: number | null; testIdPrefix: string };
  /** pdd smt only: run exactly these argument tuples instead of generated cases. */
  examples?: unknown[][];
  /** Overrides config.fileTimeoutMs for this run. */
  fileTimeoutMs?: number;
  /** Kills the law process when aborted (pdd mutate disposes its runs this way). */
  signal?: AbortSignal;
}

const CHILD_ENTRY = fileURLToPath(new URL("./child-entry.js", import.meta.url));
const MAX_OUTPUT = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Environment for law processes: nothing that could preload code into them,
 * and nothing that tells the code under test it is being checked or is in CI,
 * so it behaves the same way it will in production.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "NODE_OPTIONS" || key === "NODE_PATH" || isSniffedEnvVar(key)) continue;
    env[key] = value;
  }
  return env;
}

export async function runLawFile(file: string, opts: RunLawsOptions): Promise<FileResult> {
  const { config } = opts;
  const relFile = relPosix(config.root, file);
  const scan = scanLawFile(file, await readFile(file, "utf8"));
  const tampering = scan.violations.map((v) => `${relFile}:${v.line}:${v.col} ${v.message}`);
  const laws: LawResult[] = [];
  let output = "";
  let loadError: string | undefined;
  let done: { registered: number; names: string[]; mutation?: MutationReport } | undefined;
  let readyReceived = false;
  let timedOut = false;

  const nonce = randomBytes(16).toString("hex");
  const child = spawn(process.execPath, [CHILD_ENTRY], {
    cwd: config.root,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  const collect = (chunk: Buffer): void => {
    if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const init: ChildInit = {
    type: "init",
    nonce,
    file,
    seed: opts.seed,
    runs: config.runs,
    runsOverride: opts.runsOverride ?? null,
    timeoutMs: config.timeoutMs,
    filter: opts.filter ?? null,
    names: opts.names ?? null,
    bail: opts.bail === true,
    mutation: opts.mutation ?? null,
    examples: opts.examples ?? null,
  };

  child.on("message", (message: unknown) => {
    if (!readyReceived && isRecord(message) && message.type === "ready" && !("nonce" in message)) {
      readyReceived = true;
      child.send(init);
      return;
    }
    if (!isRecord(message) || message.nonce !== nonce) {
      tampering.push("received a report message without the right nonce (forged report?)");
      return;
    }
    if (done) {
      tampering.push("received a report message after the run was complete");
      return;
    }
    switch (message.type) {
      case "law":
        laws.push(message.result as LawResult);
        break;
      case "tampering":
        tampering.push(String(message.reason));
        break;
      case "load-error":
        loadError = String(message.error);
        break;
      case "done":
        done = { registered: Number(message.registered), names: (message.names as string[]) ?? [] };
        if (opts.mutation !== undefined && isRecord(message.mutation)) done.mutation = message.mutation as unknown as MutationReport;
        break;
      default:
        tampering.push(`unknown report message type: ${String(message.type)}`);
    }
  });

  const { code, signal, spawnError } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: Error;
  }>((resolve) => {
    const fileTimeoutMs = opts.fileTimeoutMs ?? config.fileTimeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, fileTimeoutMs);
    const abort = (): void => {
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    child.on("error", (err) => finish({ code: null, signal: null, spawnError: err }));
    child.on("close", (c, s) => finish({ code: c, signal: s }));
  });

  let error: string | undefined;
  if (spawnError) {
    error = `could not start the law process: ${spawnError.message}`;
  } else if (timedOut) {
    error = `the law file did not finish within fileTimeoutMs (${opts.fileTimeoutMs ?? config.fileTimeoutMs} ms)`;
  } else if (loadError !== undefined) {
    error = `could not load the law file:\n${loadError}`;
    if (/\.laws\.ts$/.test(file) && /require|not been linked|ERR_REQUIRE_ESM/.test(loadError)) {
      error += '\nhint: law files must load as ES modules. Add "type": "module" to package.json or rename the file to *.laws.mts.';
    }
  } else if (!done) {
    tampering.push(
      `the law process exited (code ${code ?? "none"}${signal ? `, signal ${signal}` : ""}) before reporting completion — the code under test may have called process.exit or crashed the runner`,
    );
  } else {
    if (done.registered !== scan.count) {
      tampering.push(
        `${scan.count} law(s) are declared in the file but ${done.registered} registered at runtime` +
          (done.registered === 0 && scan.count > 0 ? ` (is "pdd" resolving to a different copy of the package?)` : ""),
      );
    } else if (scan.violations.length === 0 && done.names.join("\u0000") !== scan.names.join("\u0000")) {
      tampering.push("the laws that registered at runtime differ from the ones declared in the file");
    }
    if (laws.length !== done.registered) {
      tampering.push(`expected ${done.registered} law result(s), received ${laws.length}`);
    }
  }

  const status: FileResult["status"] =
    tampering.length > 0
      ? "tampering"
      : error !== undefined
        ? "errored"
        : laws.some((l) => l.status === "failed" || l.status === "errored")
          ? "failed"
          : "ok";

  const result: FileResult = { file: relFile, status, laws, tampering, output };
  if (error !== undefined) result.error = error;
  if (timedOut) result.timedOut = true;
  if (!timedOut && !done && signal !== null && !opts.signal?.aborted) result.crashSignal = signal;
  if (done?.mutation !== undefined) result.mutation = done.mutation;
  return result;
}

export async function runLaws(opts: RunLawsOptions): Promise<LawsReport> {
  const files = opts.files ?? (await discoverLawFiles(opts.config));
  const results: FileResult[] = new Array(files.length);
  const limit = Math.max(1, Math.min(availableParallelism(), files.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < files.length) {
        const index = next++;
        const file = files[index];
        if (file !== undefined) results[index] = await runLawFile(file, opts);
      }
    }),
  );
  return summarize(opts.seed, results);
}
