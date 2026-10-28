import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load.js";
import { LOCK_FILE, type PddConfig } from "../config/schema.js";
import { diffManifests, isEmptyDiff } from "../lock/diff.js";
import { buildManifest, serializeLock } from "../lock/manifest.js";
import { LOCK_KEY_ENV, signRootHash } from "../lock/sign.js";
import { readLock, verifyLock, type LockVerdict } from "../lock/verify.js";
import { ExitCode, PddError } from "../shared/exit-codes.js";
import { pc, sym } from "../shared/output.js";

export interface LockOptions {
  check?: boolean;
  diff?: boolean;
  sign?: boolean;
}

export function printLockMismatch(v: Extract<LockVerdict, { status: "mismatch" }>): void {
  for (const p of v.problems) console.log(`    ${pc.red(p)}`);
  for (const f of v.changed) console.log(`    ${pc.yellow("changed")}  ${f}`);
  for (const f of v.added) console.log(`    ${pc.green("added")}    ${f}`);
  for (const f of v.removed) console.log(`    ${pc.red("removed")}  ${f}`);
  console.log(pc.dim("    If a human made and reviewed this change on purpose, they re-lock with `pdd lock`."));
}

export async function writeLock(config: PddConfig, sign: boolean): Promise<{ files: number; signed: boolean }> {
  const manifest = await buildManifest(config);
  if (sign) {
    const key = process.env[LOCK_KEY_ENV];
    if (!key) throw new PddError(`pdd: --sign needs the ${LOCK_KEY_ENV} environment variable`, ExitCode.CONFIG_ERROR);
    manifest.signature = signRootHash(manifest.rootHash, key);
  }
  await writeFile(path.join(config.root, LOCK_FILE), serializeLock(manifest));
  return { files: Object.keys(manifest.files).length, signed: manifest.signature !== undefined };
}

export async function lockCommand(opts: LockOptions): Promise<number> {
  const config = loadConfig();

  if (opts.check) {
    const verdict = await verifyLock(config, process.env[LOCK_KEY_ENV] || undefined);
    if (verdict.status === "ok") {
      console.log(`${sym.ok} ${verdict.files} files match ${LOCK_FILE}`);
      return ExitCode.OK;
    }
    if (verdict.status === "missing") console.log(`${sym.fail} ${LOCK_FILE} is missing`);
    else {
      console.log(`${sym.fail} the spec does not match ${LOCK_FILE}`);
      printLockMismatch(verdict);
    }
    return ExitCode.LOCK_MISMATCH;
  }

  const previous = readLock(config);
  const current = await buildManifest(config);
  const diff = typeof previous === "object" ? diffManifests(previous.files, current.files) : undefined;

  if (opts.diff) {
    if (!diff) console.log(`${LOCK_FILE} is ${previous}; \`pdd lock\` would lock ${Object.keys(current.files).length} files.`);
    else if (isEmptyDiff(diff)) console.log(`${sym.ok} no changes since the last lock`);
    else printLockMismatch({ status: "mismatch", problems: [], ...diff });
    return ExitCode.OK;
  }

  const { files, signed } = await writeLock(config, opts.sign === true);
  console.log(`${sym.ok} locked ${files} files in ${LOCK_FILE}${signed ? " (signed)" : ""}`);
  if (diff && !isEmptyDiff(diff)) {
    for (const f of diff.changed) console.log(`    ${pc.yellow("changed")}  ${f}`);
    for (const f of diff.added) console.log(`    ${pc.green("added")}    ${f}`);
    for (const f of diff.removed) console.log(`    ${pc.red("removed")}  ${f}`);
  }
  console.log(pc.dim("Commit the laws and the lock together, and review that diff as a human."));
  return ExitCode.OK;
}
