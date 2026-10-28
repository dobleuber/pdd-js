/**
 * pdd smt: for every law marked { smt: true }, translate it, ask Z3 for an input that breaks
 * it, and replay any such input in the real (isolated) runner.
 *
 *   unsat                          -> proven: the law holds for every input of its arbitraries
 *   sat, and the replay fails      -> counterexample: the law is false
 *   sat, but the replay passes     -> not proven: the input breaks one of pdd smt's
 *                                     assumptions (e.g. a value may leave the safe-integer range)
 *                                     without breaking the law; pdd never calls that proven
 *   unknown / untranslatable       -> not proven, with the reason
 */
import type { PddConfig } from "../config/schema.js";
import { discoverLawFiles } from "../runner/discover.js";
import { runLawFile } from "../runner/orchestrator.js";
import { ExitCode, PddError } from "../shared/exit-codes.js";
import { lawsDirFiles, loadProjectProgram } from "../shared/program.js";
import { evaluate, type Assignment } from "./ir.js";
import { findSmtLaws, translateLaw, type SmtProblem } from "./translate.js";
import { openZ3, type Z3Session } from "./z3.js";

export type SmtStatus = "proven" | "counterexample" | "not-proven" | "tampering";

export interface SmtLawResult {
  file: string;
  line: number;
  name: string;
  status: SmtStatus;
  /** Why the law is not proven: it could not be translated, Z3 gave up, or Z3's input does not break it at runtime. */
  why?: "untranslatable" | "unknown" | "outside-model";
  reason?: string;
  /** Where the reason comes from (file:line). */
  at?: string;
  /** The input that breaks the law, as the runner printed it. */
  counterexample?: string;
  error?: string;
  /** The files the proof relies on. */
  files?: string[];
  timeMs: number;
}

export interface SmtReport {
  z3: string | null;
  laws: SmtLawResult[];
  summary: { laws: number; proven: number; counterexamples: number; notProven: number; tampering: number };
}

function describeModel(problem: SmtProblem, model: Assignment): string {
  return problem.leaves.map((l) => `${l.label} = ${String(model.get(l.name))}`).join(", ");
}

/** The obligations a model breaks, to explain why Z3's input is not a real counterexample. */
function brokenObligations(problem: SmtProblem, model: Assignment): string[] {
  const out: string[] = [];
  for (const o of problem.obligations) {
    let holds: boolean;
    try {
      holds = evaluate(o.cond, model) === true;
    } catch {
      holds = false;
    }
    if (!holds) out.push(`${o.reason} (${o.at})`);
  }
  return out;
}

async function prove(config: PddConfig, z3: Z3Session, problem: SmtProblem, seed: number): Promise<SmtLawResult> {
  const { site } = problem;
  const start = performance.now();
  const base = { file: site.rel, line: site.line, name: site.name, files: problem.files };
  const outcome = await z3.check(problem.pre, problem.goal, problem.leaves, config.smt.timeoutMs);
  const timeMs = (): number => Math.round(performance.now() - start);

  if (outcome.status === "unsat") return { ...base, status: "proven", timeMs: timeMs() };
  if (outcome.status === "unknown") {
    return {
      ...base,
      status: "not-proven",
      why: "unknown",
      reason: `Z3 could not decide within ${config.smt.timeoutMs} ms (${outcome.reason || "unknown"})`,
      timeMs: timeMs(),
    };
  }

  // Z3 found an input. Only the real runner decides whether it breaks the law.
  const values = problem.build(outcome.model);
  const replay = await runLawFile(site.file, { config, seed, names: [site.name], examples: [values] });
  const law = replay.laws.find((l) => l.name === site.name);
  if (replay.status === "tampering") {
    return { ...base, status: "tampering", reason: replay.tampering.join("; "), timeMs: timeMs() };
  }
  if (law?.status === "passed") {
    const broken = brokenObligations(problem, outcome.model);
    const reason =
      broken.length > 0
        ? `Z3 found an input outside what pdd smt can prove exactly, but the law holds at runtime for it (${describeModel(problem, outcome.model)}): ${broken.join("; ")}`
        : `Z3's input (${describeModel(problem, outcome.model)}) does not break the law at runtime: pdd smt's model of this code differs from JavaScript here`;
    return { ...base, status: "not-proven", why: "outside-model", reason, timeMs: timeMs() };
  }
  const result: SmtLawResult = {
    ...base,
    status: "counterexample",
    counterexample: law?.counterexample ?? describeModel(problem, outcome.model),
    timeMs: timeMs(),
  };
  const error = law?.error ?? replay.error;
  if (error !== undefined) result.error = error;
  return result;
}

export async function runSmt(config: PddConfig, seed: number): Promise<SmtReport> {
  const loaded = loadProjectProgram(config, lawsDirFiles(config));
  if (loaded.status !== "ok") {
    throw new PddError(`pdd smt needs a readable ${config.tsconfig} to translate the laws`, ExitCode.CONFIG_ERROR);
  }
  const program = loaded.program;
  const sites = (await discoverLawFiles(config)).flatMap((f) => findSmtLaws(program, config.root, f));
  const laws: SmtLawResult[] = [];
  let z3: Z3Session | undefined;

  try {
    for (const site of sites) {
      const start = performance.now();
      const t = translateLaw(program, config.root, site);
      if (!t.ok) {
        laws.push({
          file: site.rel,
          line: site.line,
          name: site.name,
          status: "not-proven",
          why: "untranslatable",
          reason: t.reason,
          at: t.at,
          timeMs: Math.round(performance.now() - start),
        });
        continue;
      }
      z3 ??= await openZ3(config.root);
      laws.push(await prove(config, z3, t.problem, seed));
    }
  } finally {
    await z3?.close();
  }

  const count = (s: SmtStatus): number => laws.filter((l) => l.status === s).length;
  return {
    z3: z3?.version ?? null,
    laws,
    summary: {
      laws: laws.length,
      proven: count("proven"),
      counterexamples: count("counterexample"),
      notProven: count("not-proven"),
      tampering: count("tampering"),
    },
  };
}
