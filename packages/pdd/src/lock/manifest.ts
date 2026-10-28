import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { CONFIG_FILE, LOCK_FILE, type PddConfig } from "../config/schema.js";

export interface LockFile {
  version: 1;
  algorithm: "sha256";
  /** Relative posix path -> sha256 of the raw bytes. */
  files: Record<string, string>;
  /** sha256 over the canonical file list; this is what gets signed. */
  rootHash: string;
  /** Optional HMAC-SHA256 of rootHash with PDD_LOCK_KEY. */
  signature?: string;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Everything that defines "what was asked": every file under lawsDir
 * (laws and arbitraries), the pdd config itself, and lock.include
 * (tsconfig, CI workflows...). If any of these changes, the lock breaks.
 */
export async function collectLockedFiles(config: PddConfig): Promise<string[]> {
  const patterns = [`${fg.escapePath(config.lawsDir)}/**/*`, CONFIG_FILE, ...config.lock.include];
  const files = await fg(patterns, {
    cwd: config.root,
    dot: true,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", LOCK_FILE],
  });
  return files.sort();
}

export function computeRootHash(files: Record<string, string>): string {
  const canonical = Object.keys(files)
    .sort()
    .map((name) => [name, files[name]]);
  return sha256(JSON.stringify(canonical));
}

export async function buildManifest(config: PddConfig): Promise<LockFile> {
  const files: Record<string, string> = {};
  for (const rel of await collectLockedFiles(config)) {
    files[rel] = sha256(await readFile(path.join(config.root, rel)));
  }
  return { version: 1, algorithm: "sha256", files, rootHash: computeRootHash(files) };
}

export function serializeLock(lock: LockFile): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}
