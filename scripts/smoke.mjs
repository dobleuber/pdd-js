#!/usr/bin/env node
/**
 * Smoke test of the package as users get it: packs packages/pdd with `npm pack`, installs the
 * tarball into fresh projects outside the workspace, and drives the CLI like a new user would.
 *
 *   node scripts/smoke.mjs                 # npm and pnpm, every project, smt and mutate included
 *   node scripts/smoke.mjs --pm npm        # one package manager
 *   node scripts/smoke.mjs --quick         # skip installing Z3 and Stryker
 *   node scripts/smoke.mjs --keep          # keep the temporary projects for inspection
 *
 * Build first (`pnpm build`): the tarball ships dist/.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const managers = option("--pm", "npm,pnpm").split(",");
const quick = flag("--quick");
const keep = flag("--keep");

const PKG = "@dobleuber/pdd";
const OPTIONAL = ["z3-solver@^5.3.2", "@stryker-mutator/core@^10.1.1", "@stryker-mutator/api@^10.1.1", "@stryker-mutator/typescript-checker@^10.1.1"];

// --- helpers ------------------------------------------------------------------------------

/** The scenarios set CI mode explicitly; never inherit it (or a lock key) from this shell. */
const env = { ...process.env, NO_COLOR: "1" };
for (const k of ["CI", "GITHUB_ACTIONS", "PDD_LOCK_KEY", "NODE_OPTIONS", "FORCE_COLOR", "npm_config_prefix"]) delete env[k];

function run(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

let failures = 0;
let passes = 0;
function expect(label, r, code, ...patterns) {
  const missing = patterns.filter((p) => !p.test(r.out));
  if (r.code === code && missing.length === 0) {
    passes++;
    console.log(`  ✔ ${label}`);
    return;
  }
  failures++;
  console.log(`  ✗ ${label}: exit ${r.code} (expected ${code})${missing.length ? `, output lacks ${missing.join(", ")}` : ""}`);
  console.log(r.out.trimEnd().split("\n").slice(-25).map((l) => `      ${l}`).join("\n"));
}
function check(label, ok) {
  expect(label, { code: ok ? 0 : 1, out: "" }, 0);
}

const write = (dir, file, text) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function install(pm, dir, specs) {
  const args = pm === "npm" ? ["install", "--save-dev", "--no-audit", "--no-fund", ...specs] : ["add", "--save-dev", ...specs];
  const r = run(pm, args, dir);
  if (r.code !== 0) {
    console.log(r.out);
    throw new Error(`${pm} could not install ${specs.join(" ")}`);
  }
}

// --- the projects -------------------------------------------------------------------------

const strict = { strict: true, target: "ES2022", skipLibCheck: true, noEmit: true };

/** A project layout the smoke test installs pdd into. */
const projects = [
  {
    name: "esm-nodenext",
    full: true,
    pkg: { type: "module" },
    tsconfig: { compilerOptions: { ...strict, module: "NodeNext", moduleResolution: "NodeNext" } },
    lawExt: "ts",
    srcImport: "../src/abs.js",
  },
  {
    name: "esm-bundler",
    pkg: { type: "module" },
    tsconfig: { compilerOptions: { ...strict, module: "ESNext", moduleResolution: "Bundler" } },
    lawExt: "ts",
    srcImport: "../src/abs",
  },
  {
    name: "commonjs",
    pkg: {},
    tsconfig: { compilerOptions: { ...strict, module: "NodeNext", moduleResolution: "NodeNext" } },
    lawExt: "mts",
    srcImport: "../src/abs.js",
  },
  {
    name: "no-tsconfig",
    pkg: { type: "module" },
    tsconfig: null,
    lawExt: "ts",
    srcImport: "../src/abs.js",
  },
];

/** Wrong for every negative number, so 200 random cases always find it (and shrink it to -1). */
const BUGGY_ABS = "export function abs(n: number): number {\n  return n;\n}\n";
const FIXED_ABS = "export function abs(n: number): number {\n  return n < 0 ? -n : n;\n}\n";
const absLaws = (from, extra = "") => `import { law, forAll, arb } from "${PKG}";
import { abs } from "${from}";

const arbN = arb.integer({ min: -1_000, max: 1_000 });

law("abs is never negative", forAll(arbN, (n) => abs(n) >= 0));
law("abs keeps the size of a number", forAll(arbN, (n) => abs(n) === n || abs(n) === -n));
${extra}`;
const SMT_LAW = `law("abs is at least the number itself", forAll(arbN, (n) => abs(n) >= n), { smt: true });\n`;

function smoke(pm, tarball, project, root) {
  const dir = path.join(root, `${pm}-${project.name}`);
  mkdirSync(dir, { recursive: true });
  console.log(`\n${pm} · ${project.name}`);
  write(dir, "package.json", json({ name: `smoke-${project.name}`, version: "0.0.0", private: true, ...project.pkg }));
  if (project.tsconfig) write(dir, "tsconfig.json", json({ ...project.tsconfig, include: ["src", "laws"] }));
  install(pm, dir, [tarball]);

  const bin = path.join(dir, "node_modules", ".bin", process.platform === "win32" ? "pdd.cmd" : "pdd");
  check("the pdd command is installed", existsSync(bin));
  const pdd = (...args) => run(bin, args, dir);
  const lawFile = `laws/abs.laws.${project.lawExt}`;

  expect("pdd --version", pdd("--version"), 0, /\d+\.\d+\.\d+/);
  expect("pdd init", pdd("init", ...(project.full ? ["--claude", "--ci"] : [])), 0, /created pdd\.config\.json/, /locked \d+ files/);
  check(`init wrote laws/example.laws.${project.lawExt}`, existsSync(path.join(dir, `laws/example.laws.${project.lawExt}`)));
  expect("pdd check passes on the example law", pdd("check"), 0, project.tsconfig ? /typecheck/ : /skipped/);

  write(dir, "src/abs.ts", BUGGY_ABS);
  write(dir, lawFile, absLaws(project.srcImport));
  expect("a new law without a new lock is refused", pdd("check"), 2);
  expect("pdd lock", pdd("lock"), 0);
  expect("a wrong implementation fails with a counterexample", pdd("check"), 1, /abs is never negative/, /-1/);
  write(dir, "src/abs.ts", FIXED_ABS);
  expect("the fixed implementation passes", pdd("check"), 0);
  expect("pdd check --ci passes", pdd("check", "--ci"), 0);

  if (!project.full) return;

  write(dir, "src/abs.ts", `// @ts-ignore\n${FIXED_ABS}`);
  expect("guard catches @ts-ignore in src", pdd("check"), 3, /no-ts-suppress/);
  write(dir, "src/abs.ts", FIXED_ABS);

  const settings = readFileSync(path.join(dir, ".claude/settings.json"), "utf8");
  check("init --claude installed the hook", settings.includes("pdd hook"));
  check("init --ci wrote the workflow", existsSync(path.join(dir, ".github/workflows/pdd.yml")));
  const hook = (file) => run(bin, ["hook"], dir, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd: dir, tool_input: { file_path: path.join(dir, file) } }));
  expect("the hook blocks an edit to the laws", hook(lawFile), 2);
  expect("the hook allows an edit to src", hook("src/abs.ts"), 0);

  const addDev = pm === "npm" ? /npm install -D/ : /pnpm add -D/;
  expect("pdd coverage", pdd("coverage"), 0, /1\/1 exported functions/);
  expect("pdd mutate without Stryker says how to install it", pdd("mutate"), 5, addDev, /@stryker-mutator\/core/);
  write(dir, lawFile, absLaws(project.srcImport, SMT_LAW));
  expect("pdd lock (with an smt law)", pdd("lock"), 0);
  expect("pdd smt without Z3 says how to install it", pdd("smt"), 5, addDev, /z3-solver/);
  if (quick) return;

  install(pm, dir, OPTIONAL);
  expect("pdd smt proves the smt law", pdd("smt", "--strict"), 0, /proven/);
  expect("pdd mutate runs and reports a score", pdd("mutate"), 0, /score \d+(\.\d+)?%/);
}

// --- main ---------------------------------------------------------------------------------

const root = mkdtempSync(path.join(tmpdir(), "pdd-smoke-"));
try {
  if (!existsSync(path.join(repo, "packages/pdd/dist/cli.js"))) throw new Error("build first: pnpm build");
  const packed = run("npm", ["pack", "--pack-destination", root, "--json"], path.join(repo, "packages/pdd"));
  if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.out}`);
  const tarball = path.join(root, JSON.parse(packed.out.slice(packed.out.indexOf("[")))[0].filename);
  console.log(`packed ${path.basename(tarball)} into ${root}`);

  for (const pm of managers) {
    for (const project of projects) {
      try {
        smoke(pm, tarball, project, root);
      } catch (e) {
        failures++;
        console.log(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
} finally {
  console.log(`\n${passes} passed, ${failures} failed`);
  if (keep) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
