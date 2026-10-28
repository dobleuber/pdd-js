import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "../config/load.js";
import { CONFIG_FILE, LOCK_FILE } from "../config/schema.js";
import { ExitCode, PddError } from "../shared/exit-codes.js";
import { pc, sym } from "../shared/output.js";
import { writeLock } from "./lock.js";

export interface InitOptions {
  claude?: boolean;
  ci?: boolean;
  sign?: boolean;
}

const CONFIG_TEMPLATE = `{
  "lawsDir": "laws",
  "src": ["src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  "runs": 200
}
`;

const LAW_TEMPLATE = `import { law, forAll, arb } from "pdd";

// Laws are the human-owned spec. Agents write the code; they must never edit this folder.
// Replace this example with laws about your own code, e.g.:
//
//   import { total } from "../src/cart.js";
//   law("a total is never negative", forAll(arbCart, (cart) => total(cart) >= 0));

law("addition is commutative", forAll(arb.integer(), arb.integer(), (a, b) => a + b === b + a));
`;

const WORKFLOW_TEMPLATE = `name: pdd
on:
  push:
  pull_request:

jobs:
  pdd:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # --ci: fresh random seed, no --seed/--filter. With PDD_LOCK_KEY set, only a
      # lock signed by a human with that key is accepted.
      - run: pnpm exec pdd check --ci
        env:
          PDD_LOCK_KEY: \${{ secrets.PDD_LOCK_KEY }}
`;

const HOOK_COMMAND = `"$CLAUDE_PROJECT_DIR"/node_modules/.bin/pdd hook`;

type Json = Record<string, unknown>;

/** Adds the pdd PreToolUse hook to .claude/settings.json without touching anything else. */
async function installClaudeHook(root: string): Promise<"added" | "present"> {
  const file = path.join(root, ".claude", "settings.json");
  let settings: Json = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Json;
    } catch {
      throw new PddError(`pdd: ${file} is not valid JSON; fix it before running pdd init --claude`, ExitCode.CONFIG_ERROR);
    }
  }
  const hooks = (settings.hooks ??= {}) as Json;
  const pre = (hooks.PreToolUse ??= []) as Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }>;
  const present = pre.some((entry) => entry.hooks?.some((h) => h.command.includes("pdd hook")));
  if (present) return "present";
  pre.push({
    matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return "added";
}

/** Law files must load as ES modules; in a CommonJS package they use the .mts extension. */
function lawExtension(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { type?: string };
    return pkg.type === "module" ? "ts" : "mts";
  } catch {
    return "mts";
  }
}

async function hasLawFiles(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const entries = await readdir(dir, { recursive: true });
  return entries.some((e) => /\.laws\.(ts|mts|js|mjs)$/.test(String(e)));
}

export async function initCommand(opts: InitOptions): Promise<number> {
  const root = process.cwd();
  const configPath = path.join(root, CONFIG_FILE);

  if (existsSync(configPath)) console.log(`${sym.skip} ${CONFIG_FILE} already exists`);
  else {
    await writeFile(configPath, CONFIG_TEMPLATE);
    console.log(`${sym.ok} created ${CONFIG_FILE}`);
  }
  const config = parseConfig(root, readFileSync(configPath, "utf8"));

  const lawsDir = path.join(root, config.lawsDir);
  if (await hasLawFiles(lawsDir)) console.log(`${sym.skip} ${config.lawsDir}/ already has laws`);
  else {
    await mkdir(lawsDir, { recursive: true });
    const file = `example.laws.${lawExtension(root)}`;
    await writeFile(path.join(lawsDir, file), LAW_TEMPLATE);
    console.log(`${sym.ok} created ${config.lawsDir}/${file}`);
  }

  if (opts.ci) {
    const wf = path.join(root, ".github", "workflows", "pdd.yml");
    if (existsSync(wf)) console.log(`${sym.skip} .github/workflows/pdd.yml already exists`);
    else {
      await mkdir(path.dirname(wf), { recursive: true });
      await writeFile(wf, WORKFLOW_TEMPLATE);
      console.log(`${sym.ok} created .github/workflows/pdd.yml`);
    }
  }

  if (opts.claude) {
    const result = await installClaudeHook(root);
    console.log(
      result === "added"
        ? `${sym.ok} added the pdd PreToolUse hook to .claude/settings.json`
        : `${sym.skip} the pdd hook is already in .claude/settings.json`,
    );
  }

  const { files, signed } = await writeLock(config, opts.sign === true);
  console.log(`${sym.ok} locked ${files} files in ${LOCK_FILE}${signed ? " (signed)" : ""}`);

  console.log(`
${pc.bold("Next steps")}
  1. Write your laws in ${config.lawsDir}/ (a human, not the agent).
  2. Review them and run ${pc.cyan("pdd lock")}; commit laws + lock together.
  3. Let the agent write code; it is done when ${pc.cyan("pdd check")} passes.`);
  if (opts.ci) {
    console.log(`
${pc.bold("Protect the spec on GitHub")}
  - CODEOWNERS (so a human must approve any change to the spec):
      /${config.lawsDir}/            @your-team
      /${CONFIG_FILE}       @your-team
      /${LOCK_FILE}         @your-team
      /tsconfig.json         @your-team
      /.github/              @your-team
  - Branch protection: require the "pdd" check and code-owner review.
  - Optional: add a PDD_LOCK_KEY secret and sign locks with
      PDD_LOCK_KEY=<key> pdd lock --sign
    Keep the key out of the agent's shell (pass it only on that command).`);
  }
  return ExitCode.OK;
}
