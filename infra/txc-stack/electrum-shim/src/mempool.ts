// Live mempool snapshot, refreshed in the background.
//
// Why this exists: the indexer only materialises *confirmed* outputs, plus a
// per-address delta table for pending activity. That is enough to show a
// pending transaction in history, but not enough for a wallet to move its
// balance — iOS Electrum clients derive the spendable balance from
// `listunspent`, so a pending incoming payment stays invisible until the block
// lands, and a coin already spent by a pending transaction keeps being offered
// (which is exactly how you get `txn-mempool-conflict` on the next send).
//
// The snapshot gives us both sides cheaply:
//   * pending outputs paying an address  -> unconfirmed UTXOs (height 0)
//   * outpoints consumed by mempool txs  -> confirmed UTXOs to hide
//
// Everything is answered from memory; refreshes never block a client call.

import { getRawMempoolTxids, getRawTxVerbose } from "./rpc.js";
import { mapAddresses } from "./db.js";

const REFRESH_MS = Number(process.env.MEMPOOL_SNAPSHOT_MS ?? 8_000);

export interface PendingUtxo {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
}

interface Snapshot {
  /** address -> unconfirmed outputs paying it */
  pendingByAddress: Map<string, PendingUtxo[]>;
  /** "txid:vout" consumed by some mempool transaction */
  spent: Set<string>;
  at: number;
  txids: number;
}

let snapshot: Snapshot = {
  pendingByAddress: new Map(),
  spent: new Set(),
  at: 0,
  txids: 0,
};

// Decoded mempool transactions, keyed by txid. Mempool txs are immutable, so a
// tx only ever has to be fetched from the node once.
const txCache = new Map<string, Record<string, any>>();
let refreshing = false;

function toSats(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e8);
}

function addressesOf(vout: Record<string, any>): string[] {
  const spk = vout?.scriptPubKey ?? {};
  if (typeof spk.address === "string") return [spk.address];
  if (Array.isArray(spk.addresses)) return spk.addresses.filter((a: unknown) => typeof a === "string");
  return [];
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const txids = await getRawMempoolTxids();
    const live = new Set(txids);
    for (const cached of txCache.keys()) if (!live.has(cached)) txCache.delete(cached);

    const pendingByAddress = new Map<string, PendingUtxo[]>();
    const spent = new Set<string>();

    for (const txid of txids) {
      let tx = txCache.get(txid);
      if (!tx) {
        try {
          tx = (await getRawTxVerbose(txid)) as Record<string, any>;
        } catch {
          continue; // evicted between the listing and the fetch
        }
        txCache.set(txid, tx);
      }

      for (const input of (tx.vin ?? []) as Record<string, any>[]) {
        if (typeof input?.txid === "string" && typeof input?.vout === "number") {
          spent.add(`${input.txid}:${input.vout}`);
        }
      }
      for (const vout of (tx.vout ?? []) as Record<string, any>[]) {
        const value = toSats(vout?.value);
        if (value <= 0) continue;
        for (const address of addressesOf(vout)) {
          const list = pendingByAddress.get(address) ?? [];
          list.push({ tx_hash: txid, tx_pos: Number(vout.n ?? 0), height: 0, value });
          pendingByAddress.set(address, list);
        }
      }
      // Yield between transactions so a large mempool cannot stall sockets.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    snapshot = { pendingByAddress, spent, at: Date.now(), txids: txids.length };
    // Make every address in the live mempool resolvable from its scripthash
    // right away — this is what lets a fresh wallet see its first incoming
    // payment instead of answering "unknown scripthash" with a zero balance.
    if (pendingByAddress.size > 0) mapAddresses(pendingByAddress.keys());
  } catch {
    // Keep serving the previous snapshot; a node hiccup must not break balances.
  } finally {
    refreshing = false;
  }
}

/** Unconfirmed outputs paying `address` (height 0, Electrum convention). */
export function pendingUtxos(address: string): PendingUtxo[] {
  return snapshot.pendingByAddress.get(address) ?? [];
}

/** True when a pending transaction already spends this confirmed outpoint. */
export function isSpentInMempool(txid: string, vout: number): boolean {
  return snapshot.spent.has(`${txid}:${vout}`);
}

/** Sum of pending outputs paying `address`, in satoshis. */
export function pendingCredit(address: string): number {
  return pendingUtxos(address).reduce((sum, u) => sum + u.value, 0);
}

export function pendingAddresses(): string[] {
  return [...snapshot.pendingByAddress.keys()];
}

export function mempoolSnapshotStats(): { txids: number; addresses: number; ageMs: number } {
  return {
    txids: snapshot.txids,
    addresses: snapshot.pendingByAddress.size,
    ageMs: snapshot.at === 0 ? -1 : Date.now() - snapshot.at,
  };
}

export function startMempoolWatcher(): void {
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}
