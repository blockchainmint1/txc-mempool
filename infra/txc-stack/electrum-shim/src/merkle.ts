import { createHash } from "node:crypto";

/** Bitcoin-style double SHA-256. */
const sha256d = (buf: Buffer): Buffer =>
  createHash("sha256").update(createHash("sha256").update(buf).digest()).digest();

/** Display-order txid hex -> internal little-endian bytes. */
const toInternal = (txidHex: string): Buffer => Buffer.from(txidHex, "hex").reverse();

/** Internal little-endian bytes -> display-order hex. */
const toDisplay = (buf: Buffer): string => Buffer.from(buf).reverse().toString("hex");

/**
 * Merkle branch proving that the tx at `pos` belongs to a block whose txids are
 * `txids` (in block order). Returns hashes in display order, which is what the
 * Electrum protocol's `blockchain.transaction.get_merkle` expects.
 *
 * Bitcoin duplicates the final hash when a level has an odd count.
 */
export function merkleBranch(txids: string[], pos: number): string[] {
  if (pos < 0 || pos >= txids.length) {
    throw new Error("position out of range");
  }

  let level = txids.map(toInternal);
  let index = pos;
  const branch: string[] = [];

  while (level.length > 1) {
    if (level.length % 2 === 1) {
      level = [...level, level[level.length - 1]!];
    }

    const sibling = index ^ 1;
    branch.push(toDisplay(level[sibling]!));

    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256d(Buffer.concat([level[i]!, level[i + 1]!])));
    }

    level = next;
    index >>= 1;
  }

  return branch;
}
