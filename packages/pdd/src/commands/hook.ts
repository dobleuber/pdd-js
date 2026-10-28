import { readFileSync } from "node:fs";
import path from "node:path";
import { findProjectRoot, parseConfig } from "../config/load.js";
import { CONFIG_FILE, DEFAULTS } from "../config/schema.js";
import { decide, protectedGlobs } from "../hook/decide.js";
import { HOOK_DENY_EXIT, type HookInput } from "../hook/protocol.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Claude Code PreToolUse hook. Blocks agent edits to the human-owned spec.
 * It fails open (allows) on anything unexpected: it is a seatbelt that keeps
 * honest agents on track; the CI check is what actually enforces the spec.
 */
export async function hookCommand(): Promise<number> {
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    return 0;
  }
  const root = findProjectRoot(input.cwd ?? process.cwd());
  if (!root) return 0;

  let lawsDir: string = DEFAULTS.lawsDir;
  let include: string[] = [...DEFAULTS.lockInclude];
  let extra: string[] = [];
  try {
    const config = parseConfig(root, readFileSync(path.join(root, CONFIG_FILE), "utf8"));
    lawsDir = config.lawsDir;
    include = config.lock.include;
    extra = config.protectedPaths;
  } catch {
    // A broken config still gets the default protection.
  }

  const decision = decide(input, { root, globs: protectedGlobs(lawsDir, include, extra) });
  if (decision.allow) return 0;
  process.stderr.write(`${decision.reason}\n`);
  return HOOK_DENY_EXIT;
}
