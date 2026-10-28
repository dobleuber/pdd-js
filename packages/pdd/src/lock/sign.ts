import { createHmac, timingSafeEqual } from "node:crypto";

export const LOCK_KEY_ENV = "PDD_LOCK_KEY";

export function signRootHash(rootHash: string, key: string): string {
  return createHmac("sha256", key).update(rootHash).digest("hex");
}

export function verifySignature(rootHash: string, signature: string, key: string): boolean {
  const expected = Buffer.from(signRootHash(rootHash, key), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
