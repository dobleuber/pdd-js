import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { LOCK_FILE, type PddConfig } from "../config/schema.js";
import { diffManifests, isEmptyDiff, type ManifestDiff } from "./diff.js";
import { buildManifest, computeRootHash, type LockFile } from "./manifest.js";
import { verifySignature } from "./sign.js";

export type SignatureStatus = "verified" | "not-checked";

export type LockVerdict =
  | { status: "ok"; files: number; signature: SignatureStatus }
  | { status: "missing" }
  | ({ status: "mismatch"; problems: string[] } & ManifestDiff);

function isLockFile(value: unknown): value is LockFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    v.algorithm === "sha256" &&
    typeof v.rootHash === "string" &&
    (v.signature === undefined || typeof v.signature === "string") &&
    typeof v.files === "object" &&
    v.files !== null &&
    Object.values(v.files).every((h) => typeof h === "string")
  );
}

export function readLock(config: PddConfig): LockFile | "missing" | "malformed" {
  const lockPath = path.join(config.root, LOCK_FILE);
  if (!existsSync(lockPath)) return "missing";
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    return isLockFile(parsed) ? parsed : "malformed";
  } catch {
    return "malformed";
  }
}

/**
 * Compares the files on disk with pdd.lock.json.
 * When a key is given (CI sets PDD_LOCK_KEY from a secret), the lock MUST carry
 * a valid signature: an agent can regenerate the hashes, but not the HMAC.
 */
export async function verifyLock(config: PddConfig, key?: string): Promise<LockVerdict> {
  const lock = readLock(config);
  if (lock === "missing") return { status: "missing" };
  const empty = { changed: [], added: [], removed: [] };
  if (lock === "malformed") {
    return { status: "mismatch", problems: [`${LOCK_FILE} is malformed`], ...empty };
  }

  const problems: string[] = [];
  if (computeRootHash(lock.files) !== lock.rootHash) {
    problems.push(`${LOCK_FILE} was edited by hand: its rootHash does not match its file list`);
  }

  let signature: SignatureStatus = "not-checked";
  if (key) {
    if (!lock.signature) problems.push(`${LOCK_FILE} is not signed, but PDD_LOCK_KEY is set: only a signed lock is accepted`);
    else if (!verifySignature(lock.rootHash, lock.signature, key)) problems.push(`${LOCK_FILE} has an invalid signature`);
    else signature = "verified";
  }

  const current = await buildManifest(config);
  const diff = diffManifests(lock.files, current.files);
  if (problems.length > 0 || !isEmptyDiff(diff)) return { status: "mismatch", problems, ...diff };
  return { status: "ok", files: Object.keys(current.files).length, signature };
}
