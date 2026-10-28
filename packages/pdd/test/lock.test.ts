import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { PddConfig } from "../src/config/schema.js";
import { diffManifests } from "../src/lock/diff.js";
import { buildManifest, computeRootHash, serializeLock } from "../src/lock/manifest.js";
import { signRootHash, verifySignature } from "../src/lock/sign.js";
import { verifyLock } from "../src/lock/verify.js";

let dir: string;
let config: PddConfig;

async function lockNow(key?: string): Promise<void> {
  const m = await buildManifest(config);
  if (key) m.signature = signRootHash(m.rootHash, key);
  await writeFile(path.join(dir, "pdd.lock.json"), serializeLock(m));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pdd-lock-"));
  await mkdir(path.join(dir, "laws"));
  await writeFile(path.join(dir, "pdd.config.json"), "{}");
  await writeFile(path.join(dir, "laws", "a.laws.ts"), "law A");
  await writeFile(path.join(dir, "laws", "arbitraries.ts"), "arb");
  await writeFile(path.join(dir, "tsconfig.json"), "{}");
  config = parseConfig(dir, "{}");
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe("lock", () => {
  test("covers laws, arbitraries, the config and lock.include", async () => {
    const m = await buildManifest(config);
    expect(Object.keys(m.files)).toEqual(["laws/a.laws.ts", "laws/arbitraries.ts", "pdd.config.json", "tsconfig.json"]);
  });

  test("root hash does not depend on key order", () => {
    expect(computeRootHash({ a: "1", b: "2" })).toBe(computeRootHash({ b: "2", a: "1" }));
    expect(computeRootHash({ a: "1" })).not.toBe(computeRootHash({ a: "2" }));
  });

  test("verify: ok, then mismatch after editing an arbitrary", async () => {
    await lockNow();
    expect((await verifyLock(config)).status).toBe("ok");
    await writeFile(path.join(dir, "laws", "arbitraries.ts"), "weaker arb");
    const v = await verifyLock(config);
    expect(v.status).toBe("mismatch");
    if (v.status === "mismatch") expect(v.changed).toEqual(["laws/arbitraries.ts"]);
  });

  test("verify: missing lock", async () => {
    expect((await verifyLock(config)).status).toBe("missing");
  });

  test("verify: hand-edited lock is rejected", async () => {
    await lockNow();
    const m = await buildManifest(config);
    m.files["laws/a.laws.ts"] = "0".repeat(64);
    await writeFile(path.join(dir, "pdd.lock.json"), serializeLock(m));
    const v = await verifyLock(config);
    expect(v.status).toBe("mismatch");
    if (v.status === "mismatch") expect(v.problems.join()).toMatch(/edited by hand/);
  });

  test("with a key, the lock must be signed with that key", async () => {
    await lockNow();
    let v = await verifyLock(config, "secret");
    expect(v.status).toBe("mismatch");
    if (v.status === "mismatch") expect(v.problems.join()).toMatch(/not signed/);

    await lockNow("other-key");
    v = await verifyLock(config, "secret");
    if (v.status === "mismatch") expect(v.problems.join()).toMatch(/invalid signature/);
    else throw new Error("expected mismatch");

    await lockNow("secret");
    v = await verifyLock(config, "secret");
    expect(v).toMatchObject({ status: "ok", signature: "verified" });
  });

  test("diff and signature helpers", () => {
    expect(diffManifests({ a: "1", b: "2" }, { a: "9", c: "3" })).toEqual({ changed: ["a"], added: ["c"], removed: ["b"] });
    const sig = signRootHash("abc", "k");
    expect(verifySignature("abc", sig, "k")).toBe(true);
    expect(verifySignature("abc", sig, "x")).toBe(false);
    expect(verifySignature("abc", "zz", "k")).toBe(false);
  });
});
