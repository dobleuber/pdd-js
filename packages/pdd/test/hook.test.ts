import { describe, expect, test } from "vitest";
import { decide, protectedGlobs } from "../src/hook/decide.js";

const root = "/project";
const globs = protectedGlobs("laws", ["tsconfig.json", ".github/workflows/*.yml"], []);
const edit = (file_path: string, tool_name = "Edit") => decide({ tool_name, cwd: root, tool_input: { file_path } }, { root, globs });
const bash = (command: string) => decide({ tool_name: "Bash", cwd: root, tool_input: { command } }, { root, globs });

describe("hook decide", () => {
  test("blocks edits to the spec", () => {
    for (const f of ["/project/laws/cart.laws.ts", "laws/arbitraries.ts", "/project/pdd.config.json", "/project/pdd.lock.json", "/project/.claude/settings.json", "/project/tsconfig.json", "/project/.github/workflows/ci.yml"]) {
      expect(edit(f).allow, f).toBe(false);
    }
    expect(edit("/project/laws/new.laws.ts", "Write").allow).toBe(false);
  });

  test("allows edits to the code", () => {
    expect(edit("/project/src/cart.ts")).toEqual({ allow: true });
    expect(edit("/project/src/laws-helper.ts")).toEqual({ allow: true });
    expect(edit("/elsewhere/laws/x.ts")).toEqual({ allow: true });
  });

  test("blocks re-locking and shell writes to the spec", () => {
    expect(bash("pdd lock").allow).toBe(false);
    expect(bash("pnpm exec pdd lock --sign").allow).toBe(false);
    expect(bash("echo 'law(...)' > laws/cart.laws.ts").allow).toBe(false);
    expect(bash("sed -i 's/=== 0/>= 0/' laws/cart.laws.ts").allow).toBe(false);
    expect(bash("rm pdd.lock.json").allow).toBe(false);
  });

  test("allows reading the spec and checking", () => {
    expect(bash("cat laws/cart.laws.ts").allow).toBe(true);
    expect(bash("pdd lock --check").allow).toBe(true);
    expect(bash("pnpm exec pdd check").allow).toBe(true);
    expect(bash("echo hi > src/notes.txt").allow).toBe(true);
  });

  test("ignores other tools", () => {
    expect(decide({ tool_name: "Read", tool_input: { file_path: "/project/laws/x.ts" } }, { root, globs }).allow).toBe(true);
  });
});
