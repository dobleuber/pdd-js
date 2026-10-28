import { readFile } from "node:fs/promises";
import { moduleSpecifiers, parse, resolveRelative } from "./ast.js";

/** All local modules reachable from the given entry files through relative imports. */
export async function localImportGraph(entries: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file) || file.includes("/node_modules/")) continue;
    seen.add(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const { spec } of moduleSpecifiers(parse(file, text))) {
      const resolved = resolveRelative(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}
