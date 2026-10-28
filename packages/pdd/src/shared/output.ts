import pc from "picocolors";

export { pc };

export const sym = {
  ok: pc.green("✔"),
  fail: pc.red("✖"),
  warn: pc.yellow("!"),
  skip: pc.dim("-"),
};

export function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}
