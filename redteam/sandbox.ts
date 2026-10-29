/**
 * Each scenario gets a fresh copy of examples/shopping-cart in a temp folder,
 * with node_modules/@dobleuber/pdd linked to this repo's build, and runs the real CLI.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "packages/pdd/dist/cli.js");
const example = path.join(repo, "examples/shopping-cart");

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  out: string;
}

export interface Sandbox {
  dir: string;
  run(args: string[], opts?: { env?: Record<string, string>; input?: string }): Promise<RunResult>;
  read(rel: string): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  edit(rel: string, change: (text: string) => string): Promise<void>;
  dispose(): Promise<void>;
}

/** The scenarios control CI mode and the lock key explicitly; never inherit them. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, NO_COLOR: "1" };
  for (const k of ["CI", "GITHUB_ACTIONS", "PDD_LOCK_KEY", "NODE_OPTIONS", "FORCE_COLOR"]) delete env[k];
  return { ...env, ...extra };
}

export async function makeSandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdd-redteam-"));
  await cp(example, dir, { recursive: true, filter: (src) => path.basename(src) !== "node_modules" });
  await mkdir(path.join(dir, "node_modules/@dobleuber"), { recursive: true });
  await symlink(path.join(repo, "packages/pdd"), path.join(dir, "node_modules/@dobleuber/pdd"), "dir");

  const sandbox: Sandbox = {
    dir,
    run(args, opts = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: cleanEnv(opts.env) });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
        child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
        child.stdin.end(opts.input ?? "");
      });
    },
    read: (rel) => readFile(path.join(dir, rel), "utf8"),
    write: async (rel, content) => {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), content);
    },
    edit: async (rel, change) => {
      const before = await sandbox.read(rel);
      const after = change(before);
      if (after === before) throw new Error(`scenario edit did not change ${rel}`);
      await sandbox.write(rel, after);
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
  return sandbox;
}
