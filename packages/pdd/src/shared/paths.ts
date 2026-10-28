import path from "node:path";

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Path of `abs` relative to `root`, always with forward slashes. */
export function relPosix(root: string, abs: string): string {
  return toPosix(path.relative(root, abs));
}

export function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
