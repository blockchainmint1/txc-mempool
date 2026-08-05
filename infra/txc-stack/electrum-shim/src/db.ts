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

export interface OperationalStats {
  indexerTip: number;
  mappedScripthashes: number;
}

/**
 * Cheap counters for the once-per-minute health line. Keep this deliberately
 * free of COUNT(DISTINCT ...) scans: better-sqlite3 is synchronous, so an
 * expensive telemetry query also pauses TLS handshakes for every wallet.
 */
export function operationalStats(): OperationalStats {
  const tip = idx.prepare("SELECT MAX(height) AS height FROM blocks").get() as {
    height: number | null;
  };
  const mapped = map.prepare("SELECT COUNT(*) AS count FROM scripthashes").get() as {
    count: number;
  };
  return {
    indexerTip: tip.height ?? -1,
    mappedScripthashes: mapped.count,
  };
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
 * scripthash entry.
 *
 * Hard-won constraint: the indexer database has NO index on `height`, so any
 * `WHERE height > ?` filter degenerates into a synchronous full table scan
 * (minutes on a live chain). better-sqlite3 is synchronous, so that scan
 * freezes Node's event loop — TLS handshakes stall and iOS reports "Network
 * Error"/the container health check fails. We therefore page through each
 * table by `rowid`, which is always the b-tree primary key: every chunk is a
 * bounded index range read, and we yield to the event loop between chunks.
 */
map.exec(`CREATE TABLE IF NOT EXISTS watermarks (name TEXT PRIMARY KEY, rowid_max INTEGER NOT NULL)`);
const readWatermark = map.prepare("SELECT rowid_max FROM watermarks WHERE name = ?");
const writeWatermark = map.prepare(
  "INSERT INTO watermarks(name, rowid_max) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET rowid_max = excluded.rowid_max",
);

function getWatermark(name: string): number {
  const row = readWatermark.get(name) as { rowid_max: number } | undefined;
  return row?.rowid_max ?? 0;
}

// Tables scanned incrementally by rowid. `balances` is included so a rebuilt
// side-car still backfills historic addresses, just in bounded chunks.
const SOURCE_TABLES = ["balances", "address_txs", "outputs"] as const;
const CHUNK = 2_000;
// Upper bound on rows examined per pass, so a periodic refresh can never turn
// into a multi-minute stall even mid-backfill; the next pass resumes.
const MAX_ROWS_PER_PASS = 40_000;

export async function refreshScripthashMap(): Promise<{
  added: number;
  scanned: number;
  total: number;
  ms: number;
}> {
  const startedAt = Date.now();
  let added = 0;
  let scanned = 0;

  const insertBatch = map.transaction((list: { address: string }[]) => {
    for (const { address } of list) {
      if (!address) continue;
      const sh = addressToScripthash(address);
      if (!sh) continue;
      if (insertSh.run(sh, address).changes) added++;
    }
  });

  for (const table of SOURCE_TABLES) {
    let cursor = getWatermark(table);
    const select = idx.prepare(
      `SELECT rowid AS rid, address FROM ${table}
       WHERE rowid > ? AND address IS NOT NULL
       ORDER BY rowid ASC LIMIT ${CHUNK}`,
    );
    while (scanned < MAX_ROWS_PER_PASS) {
      const rows = select.all(cursor) as { rid: number; address: string }[];
      if (rows.length === 0) break;
      insertBatch(rows);
      scanned += rows.length;
      cursor = rows[rows.length - 1]!.rid;
      writeWatermark.run(table, cursor);
      // Give sockets, TLS handshakes and RPC callbacks a turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (rows.length < CHUNK) break;
    }
  }

  // Mempool addresses are a handful of rows — always mapped in full.
  const pending = idx
    .prepare("SELECT DISTINCT address FROM mempool_address_txs WHERE address IS NOT NULL")
    .all() as { address: string }[];
  if (pending.length) {
    insertBatch(pending);
    scanned += pending.length;
  }

  const total = (map.prepare("SELECT COUNT(*) AS count FROM scripthashes").get() as {
    count: number;
  }).count;
  return { added, scanned, total, ms: Date.now() - startedAt };
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

/**
 * Map an explicit list of addresses (e.g. everything currently paying out in
 * the mempool snapshot). Lets a first-ever incoming payment become resolvable
 * within seconds instead of waiting for the indexer's mempool table.
 */
export function mapAddresses(addresses: Iterable<string>): number {
  let added = 0;
  const run = map.transaction((list: string[]) => {
    for (const address of list) {
      if (!address) continue;
      const sh = addressToScripthash(address);
      if (!sh) continue;
      if (insertSh.run(sh, address).changes) added++;
    }
  });
  run([...addresses]);
  return added;
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
