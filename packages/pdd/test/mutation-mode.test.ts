/**
 * The law runner's mutation mode, used by pdd mutate's Stryker plugin.
 * Imports the built runner: it spawns dist/runner/child-entry.js.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { runLawFile } from "../dist/runner/orchestrator.js";

const root = fileURLToPath(new URL("./fixtures/mutation/", import.meta.url));
const config = parseConfig(root, "{}");
const file = path.join(root, "laws", "m.laws.ts");
const prefix = "laws/m.laws.ts::";
const mutation = (activeMutant: string | null, hitLimit: number | null = null) => ({ activeMutant, hitLimit, testIdPrefix: prefix });

describe("mutation mode", () => {
  test("without it, nothing is installed and no coverage is reported", async () => {
    const r = await runLawFile(file, { config, seed: 1 });
    expect(r.status).toBe("ok");
    expect(r.mutation).toBeUndefined();
  });

  test("the dry run reports static and per-law coverage", async () => {
    const r = await runLawFile(file, { config, seed: 1, mutation: mutation(null) });
    expect(r.status).toBe("ok");
    const cov = r.mutation?.mutantCoverage;
    expect(cov?.static).toEqual({ "0": 1 });
    expect(Object.keys(cov?.perTest ?? {}).sort()).toEqual([`${prefix}double is even`, `${prefix}double is x + x`]);
    expect(cov?.perTest[`${prefix}double is x + x`]?.["1"]).toBeGreaterThan(0);
  });

  test("an active mutant is installed before the code loads (static mutants)", async () => {
    const r = await runLawFile(file, { config, seed: 1, mutation: mutation("0") });
    expect(r.laws.find((l) => l.name === "double is x + x")?.status).toBe("failed");
    expect(r.laws.find((l) => l.name === "double is even")?.status).toBe("passed");
  });

  test("names filter and bail skip the other laws", async () => {
    const only = await runLawFile(file, { config, seed: 1, mutation: mutation("1"), names: ["double is even"] });
    expect(only.laws.map((l) => [l.name, l.status])).toEqual([
      ["double is x + x", "skipped"],
      ["double is even", "failed"],
    ]);
    expect(only.status).toBe("failed");

    const bailed = await runLawFile(file, { config, seed: 1, mutation: mutation("1"), bail: true });
    expect(bailed.laws.map((l) => l.status)).toEqual(["failed", "skipped"]);
    expect(bailed.tampering).toEqual([]);
  });

  test("the hit count is reported so the plugin can spot infinite loops", async () => {
    const r = await runLawFile(file, { config, seed: 1, mutation: mutation("1", 5) });
    expect(r.mutation?.hitCount).toBeGreaterThan(5);
  });

  test("an aborted run is killed", async () => {
    const aborter = new AbortController();
    aborter.abort();
    const r = await runLawFile(file, { config, seed: 1, mutation: mutation(null), signal: aborter.signal });
    expect(r.status).not.toBe("ok");
    expect(r.crashSignal).toBeUndefined();
  });
});
