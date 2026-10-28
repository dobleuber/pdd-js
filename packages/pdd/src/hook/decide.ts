import path from "node:path";
import picomatch from "picomatch";
import { CONFIG_FILE, LOCK_FILE } from "../config/schema.js";
import { isInside, relPosix } from "../shared/paths.js";
import type { HookDecision, HookInput } from "./protocol.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Commands that write, move or delete files. Best effort: the hook is a seatbelt, CI is the wall. */
const WRITE_COMMAND = /(>|\btee\b|\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-[a-z]*i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bln\b|\bchmod\b|\binstall\b|\bdd\b|\bgit\s+(checkout|restore|apply|stash|reset|rm|mv)\b|\bpatch\b|writeFile|\bpython3?\b|\bnode\s+-e\b)/;
const RELOCK_COMMAND = /\bpdd\b[^\n;&|]*\block\b(?![^\n;&|]*--(check|diff)\b)/;

export function protectedGlobs(lawsDir: string, lockInclude: string[], extra: string[]): string[] {
  return [
    `${lawsDir}/**`,
    CONFIG_FILE,
    LOCK_FILE,
    ".claude/settings.json",
    ".claude/settings.local.json",
    ...lockInclude,
    ...extra,
  ];
}

/** The fixed part of a glob before its first wildcard, used to spot paths inside shell commands. */
function literalPrefix(glob: string): string {
  const idx = glob.search(/[*?[{]/);
  const literal = idx === -1 ? glob : glob.slice(0, idx);
  return literal.replace(/\/+$/, "");
}

export interface DecideOptions {
  root: string;
  globs: string[];
}

export function decide(input: HookInput, opts: DecideOptions): HookDecision {
  const tool = input.tool_name ?? "";
  const cwd = input.cwd ?? opts.root;
  const isProtected = picomatch(opts.globs, { dot: true });

  if (EDIT_TOOLS.has(tool)) {
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (!target) return { allow: true };
    const abs = path.resolve(cwd, target);
    if (!isInside(opts.root, abs)) return { allow: true };
    const rel = relPosix(opts.root, abs);
    if (isProtected(rel)) {
      return {
        allow: false,
        reason:
          `pdd: "${rel}" is part of the human-owned spec (laws, pdd config, lock or CI). ` +
          "Agents may not edit it. If the spec is wrong, stop and ask the human to change it.",
      };
    }
    return { allow: true };
  }

  if (tool === "Bash") {
    const command = input.tool_input?.command ?? "";
    if (RELOCK_COMMAND.test(command)) {
      return {
        allow: false,
        reason: "pdd: only a human may re-lock the laws (`pdd lock`). `pdd lock --check` and `pdd lock --diff` are fine.",
      };
    }
    if (WRITE_COMMAND.test(command)) {
      const hit = opts.globs.map(literalPrefix).find((lit) => lit.length > 0 && command.includes(lit));
      if (hit) {
        return {
          allow: false,
          reason: `pdd: this command looks like it modifies "${hit}", which is part of the human-owned spec. Ask the human instead.`,
        };
      }
    }
  }
  return { allow: true };
}
