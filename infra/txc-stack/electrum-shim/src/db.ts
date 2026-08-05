// Read access to the indexer's SQLite database plus a tiny side-car database
// holding the scripthash -> address map that Electrum clients need.

import Database from "better-sqlite3";
import { addressToScripthash } from "./scripthash.js";

const INDEXER_DB_PATH = process.env.INDEXER_DB_PATH ?? "/data/indexer.sqlite";
const MAP_DB_PATH = process.env.MAP_DB_PATH ?? "/data/scripthash.sqlite";

export const idx = new Database(INDEXER_DB_PATH, { readonly: true });
idx.pragma("mmap_size = 268435456");

export const map = new Database(MAP_DB_PATH);
map.pragma("journal_mode = WAL");
map.exec(`
  CREATE TABLE IF NOT EXISTS scripthashes (
    scripthash TEXT PRIMARY KEY,
    address    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sh_address ON scripthashes(address);
`);

const insertSh = map.prepare(
  "INSERT OR IGNORE INTO scripthashes(scripthash, address) VALUES (?, ?)",
);
const selectAddr = map.prepare("SELECT address FROM scripthashes WHERE scripthash = ?");

export interface IndexStats {
  indexerTip: number;
  indexedBlocks: number;
  indexedTransactions: number;
  indexedAddresses: number;
  mappedScripthashes: number;
}

export function indexStats(): IndexStats {
  const index = idx
    .prepare(
      `SELECT
         COALESCE(MAX(height), -1) AS indexerTip,
         COUNT(*) AS indexedBlocks
       FROM blocks`,
    )
    .get() as { indexerTip: number; indexedBlocks: number };
  const txs = idx.prepare("SELECT COUNT(DISTINCT txid) AS count FROM address_txs").get() as {
    count: number;
  };
  const addresses = idx
    .prepare("SELECT COUNT(DISTINCT address) AS count FROM address_txs")
    .get() as { count: number };
  const mapped = map.prepare("SELECT COUNT(*) AS count FROM scripthashes").get() as {
    count: number;
  };
  return {
    indexerTip: index.indexerTip,
    indexedBlocks: index.indexedBlocks,
    indexedTransactions: txs.count,
    indexedAddresses: addresses.count,
    mappedScripthashes: mapped.count,
  };
}

export function scripthashToAddress(scripthash: string): string | null {
  const row = selectAddr.get(scripthash.toLowerCase()) as { address: string } | undefined;
  return row?.address ?? null;
}

/**
 * Walk every address the indexer knows about and make sure it has a
 * scripthash entry. Cheap after the first pass because the insert is
 * INSERT OR IGNORE against a primary key.
 */
export async function refreshScripthashMap(): Promise<{
  added: number;
  scanned: number;
  total: number;
  ms: number;
}> {
  const startedAt = Date.now();
  const rows = idx
    .prepare(
      // `balances` and `address_txs` only cover *confirmed* activity, and
      // `outputs` covers everything the chain has ever paid. `mempool_address_txs`
      // is what makes a brand-new wallet's first *incoming pending* payment
      // resolvable — without it the receiving scripthash is unknown, so
      // get_balance/get_history answer empty and the wallet balance never moves.
      `SELECT address FROM balances
       UNION
       SELECT DISTINCT address FROM address_txs WHERE address IS NOT NULL
       UNION
       SELECT DISTINCT address FROM outputs WHERE address IS NOT NULL
       UNION
       SELECT DISTINCT address FROM mempool_address_txs WHERE address IS NOT NULL`,
    )
    .all() as { address: string }[];
  let added = 0;
  const insertBatch = map.transaction((list: { address: string }[]) => {
    for (const { address } of list) {
      if (!address) continue;
      const sh = addressToScripthash(address);
      if (!sh) continue;
      const res = insertSh.run(sh, address);
      if (res.changes) added++;
    }
  });
  // better-sqlite3 and address hashing are synchronous. Processing the entire
  // chain's address set in one transaction blocks Electrum socket responses,
  // so yield to the event loop between bounded batches.
  const batchSize = 500;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    insertBatch(rows.slice(offset, offset + batchSize));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const total = (map.prepare("SELECT COUNT(*) AS count FROM scripthashes").get() as {
    count: number;
  }).count;
  return { added, scanned: rows.length, total, ms: Date.now() - startedAt };
}

/**
 * Map only the addresses touched by the current mempool. This is a handful of
 * rows, so it can run every few seconds — it is what makes an incoming pending
 * payment to a fresh address visible (and push a subscribe notification)
 * without waiting for the full map pass.
 */
export function refreshMempoolScripthashes(): { added: number; scanned: number } {
  const rows = idx
    .prepare("SELECT DISTINCT address FROM mempool_address_txs WHERE address IS NOT NULL")
    .all() as { address: string }[];
  let added = 0;
  const run = map.transaction((list: { address: string }[]) => {
    for (const { address } of list) {
      const sh = addressToScripthash(address);
      if (!sh) continue;
      if (insertSh.run(sh, address).changes) added++;
    }
  });
  run(rows);
  return { added, scanned: rows.length };
}


// ---- Address-level queries (the actual Electrum payloads) ----

export interface HistoryItem {
  tx_hash: string;
  height: number;
  fee?: number;
}

export function confirmedHistory(address: string): HistoryItem[] {
  return idx
    .prepare(
      `SELECT txid AS tx_hash, height FROM address_txs
       WHERE address = ? ORDER BY height ASC, txid ASC`,
    )
    .all(address) as HistoryItem[];
}

export function mempoolHistory(address: string): HistoryItem[] {
  return (
    idx
      .prepare(`SELECT txid AS tx_hash FROM mempool_address_txs WHERE address = ?`)
      .all(address) as { tx_hash: string }[]
  ).map((r) => ({ tx_hash: r.tx_hash, height: 0, fee: 0 }));
}

export function fullHistory(address: string): HistoryItem[] {
  return [...confirmedHistory(address), ...mempoolHistory(address)];
}

export function confirmedBalance(address: string): number {
  const row = idx.prepare("SELECT balance FROM balances WHERE address = ?").get(address) as
    | { balance: number }
    | undefined;
  return row?.balance ?? 0;
}

export function unconfirmedBalance(address: string): number {
  const row = idx
    .prepare("SELECT COALESCE(SUM(delta), 0) AS d FROM mempool_address_txs WHERE address = ?")
    .get(address) as { d: number };
  return row.d ?? 0;
}

export interface Utxo {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
}

export function listUnspent(address: string): Utxo[] {
  return idx
    .prepare(
      // COALESCE: Electrum clients expect height 0 (unconfirmed), never NULL —
      // a NULL here makes bitcoinjs-based wallets drop the whole UTXO.
      `SELECT txid AS tx_hash, vout AS tx_pos, COALESCE(height, 0) AS height, value
       FROM outputs
       WHERE address = ? AND spent_txid IS NULL
       ORDER BY height ASC, txid ASC, vout ASC`,
    )
    .all(address) as Utxo[];
}


export function indexerTipHeight(): number {
  const row = idx.prepare("SELECT MAX(height) AS h FROM blocks").get() as { h: number | null };
  return row.h ?? -1;
}
