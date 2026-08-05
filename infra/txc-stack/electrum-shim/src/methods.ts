// Electrum protocol method handlers. Everything is answered from the indexer
// SQLite database and texitcoind RPC — no ElectrumX, no electrs.

import {
  confirmedBalance,
  confirmedHistory,
  fullHistory,
  indexStats,
  indexerTipHeight,
  listUnspent,
  mempoolHistory,
  scripthashToAddress,
  unconfirmedBalance,
} from "./db.js";
import { getFeeEstimate, getRelayFee } from "./fees.js";
import { isSpentInMempool, pendingCredit, pendingUtxos } from "./mempool.js";
import { historyStatus } from "./scripthash.js";
import {
  getBlockCount,
  getBlockHash,
  getBlockHeaderHex,
  getBlockVerbose1,
  getRawMempoolVerbose,
  getRawTxHex,
  getRawTxVerbose,
  sendRawTx,
  getRawMempoolTxids,
  decodeRawTx,
} from "./rpc.js";

export const SERVER_VERSION = "TxcElectrumShim 1.0";
export const PROTOCOL_MIN = "1.4";
export const PROTOCOL_MAX = "1.4.2";
export const GENESIS_HASH = process.env.GENESIS_HASH ?? "";

export class RpcFault extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Resolve a scripthash to the address our indexer keys on. */
function addressFor(scripthash: string): string | null {
  // The map is refreshed centrally on a timer. Never rebuild it here: HD
  // wallets scan many unused addresses, and rebuilding the complete map once
  // for every unknown scripthash blocks the event loop and makes fee loading
  // and sends appear to hang. An unknown/unused scripthash correctly has no
  // history, balance, or UTXOs.
  return scripthashToAddress(scripthash);
}

async function tipHeader(): Promise<{ height: number; hex: string }> {
  const height = await getBlockCount();
  const hash = await getBlockHash(height);
  const hex = await getBlockHeaderHex(hash);
  return { height, hex };
}

let cachedTip: { height: number; hex: string; at: number } | null = null;
export async function getTip(force = false): Promise<{ height: number; hex: string }> {
  if (!force && cachedTip && Date.now() - cachedTip.at < 3000) {
    return { height: cachedTip.height, hex: cachedTip.hex };
  }
  const t = await tipHeader();
  cachedTip = { ...t, at: Date.now() };
  return t;
}

/**
 * History as the wallet must see it: confirmed rows from the indexer plus every
 * pending transaction, including ones the indexer's mempool table has not
 * picked up yet (it refreshes on its own slower timer).
 */
function historyFor(address: string): { tx_hash: string; height: number; fee?: number }[] {
  const items = [...confirmedHistory(address), ...mempoolHistory(address)];
  const seen = new Set(items.map((i) => i.tx_hash));
  for (const u of pendingUtxos(address)) {
    if (!seen.has(u.tx_hash)) {
      seen.add(u.tx_hash);
      items.push({ tx_hash: u.tx_hash, height: 0, fee: 0 });
    }
  }
  return items;
}

/**
 * Spendable set: confirmed UTXOs that no pending transaction has already
 * consumed, plus unconfirmed outputs paying this address. iOS Electrum clients
 * derive the displayed balance from this list, so omitting pending credits is
 * what made an incoming payment show in history while the balance stayed put.
 */
function unspentFor(address: string) {
  const confirmed = listUnspent(address).filter(
    (u) => !isSpentInMempool(u.tx_hash, u.tx_pos),
  );
  const pendingList = pendingUtxos(address).filter(
    (p) => !isSpentInMempool(p.tx_hash, p.tx_pos),
  );
  const seen = new Set(confirmed.map((u) => `${u.tx_hash}:${u.tx_pos}`));
  return [
    ...confirmed,
    ...pendingList.filter((p) => !seen.has(`${p.tx_hash}:${p.tx_pos}`)),
  ];
}

export function statusFor(scripthash: string): string | null {
  const address = addressFor(scripthash);
  if (!address) return null;
  return historyStatus(historyFor(address));
}

export async function handle(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    // ---- server ----
    case "server.version":
      return [SERVER_VERSION, PROTOCOL_MAX];
    case "server.ping":
      return null;
    case "server.banner":
      return "TEXITcoin Electrum endpoint — served by the mempool.texitcoin.org indexer.";
    case "server.donation_address":
      return "";
    case "server.peers.subscribe":
      return [];
    case "server.features":
      return {
        server_version: SERVER_VERSION,
        protocol_min: PROTOCOL_MIN,
        protocol_max: PROTOCOL_MAX,
        genesis_hash: GENESIS_HASH || (await getBlockHash(0)),
        hash_function: "sha256",
        pruning: null,
        hosts: {},
      };

    // ---- headers / blocks ----
    case "blockchain.headers.subscribe": {
      const t = await getTip();
      return { height: t.height, hex: t.hex };
    }
    case "blockchain.block.header": {
      const height = Number(params[0]);
      if (!Number.isInteger(height) || height < 0) throw new RpcFault(1, "invalid height");
      const hash = await getBlockHash(height);
      return await getBlockHeaderHex(hash);
    }
    case "blockchain.block.headers": {
      const start = Number(params[0]);
      const count = Math.min(Number(params[1]) || 0, 2016);
      const parts: string[] = [];
      for (let h = start; h < start + count; h++) {
        try {
          parts.push(await getBlockHeaderHex(await getBlockHash(h)));
        } catch {
          break;
        }
      }
      return { count: parts.length, hex: parts.join(""), max: 2016 };
    }

    // ---- fees ----
    case "blockchain.estimatefee": {
      const target = Math.max(1, Number(params[0]) || 1);
      // Cached/background-refreshed: never blocks the wallet on a slow node.
      return await getFeeEstimate(target);
    }
    case "blockchain.relayfee": {
      return await getRelayFee();
    }
    case "mempool.get_fee_histogram": {
      const entries = await getRawMempoolVerbose().catch(() => ({}));
      const rates = Object.values(entries)
        .map((e) => {
          const feeTxc = e.fees?.base ?? e.fee ?? 0;
          const sats = Math.round(feeTxc * 1e8);
          const vsize = e.vsize || 1;
          return { rate: sats / vsize, vsize };
        })
        .sort((a, b) => b.rate - a.rate);
      // Electrum's histogram: [[feerate, cumulative vsize], ...] descending,
      // bucketed so the payload stays small.
      const out: [number, number][] = [];
      let bucketRate = rates[0]?.rate ?? 0;
      let bucketSize = 0;
      for (const r of rates) {
        bucketSize += r.vsize;
        if (bucketSize >= 100_000) {
          out.push([Number(bucketRate.toFixed(3)), bucketSize]);
          bucketRate = r.rate;
          bucketSize = 0;
        }
      }
      if (bucketSize > 0) out.push([Number(bucketRate.toFixed(3)), bucketSize]);
      return out;
    }

    // ---- scripthash ----
    case "blockchain.scripthash.get_balance": {
      const address = addressFor(String(params[0]));
      if (!address) return { confirmed: 0, unconfirmed: 0 };
      const delta = unconfirmedBalance(address);
      return {
        confirmed: confirmedBalance(address),
        // The indexer's pending delta lags its own mempool poll; fall back to
        // the live snapshot so a just-received payment is reflected at once.
        unconfirmed: delta !== 0 ? delta : pendingCredit(address),
      };
    }
    case "blockchain.scripthash.get_history": {
      const address = addressFor(String(params[0]));
      if (!address) return [];
      return historyFor(address);
    }
    case "blockchain.scripthash.get_mempool": {
      const address = addressFor(String(params[0]));
      if (!address) return [];
      const rows = mempoolHistory(address);
      const seen = new Set(rows.map((r) => r.tx_hash));
      for (const u of pendingUtxos(address)) {
        if (!seen.has(u.tx_hash)) {
          seen.add(u.tx_hash);
          rows.push({ tx_hash: u.tx_hash, height: 0, fee: 0 });
        }
      }
      return rows;
    }
    case "blockchain.scripthash.listunspent": {
      const address = addressFor(String(params[0]));
      if (!address) return [];
      return unspentFor(address);
    }
    case "blockchain.scripthash.subscribe":
      return statusFor(String(params[0]));
    case "blockchain.scripthash.unsubscribe":
      return true;

    // ---- transactions ----
    case "blockchain.transaction.get": {
      const txid = String(params[0]);
      const verbose = params[1] === true;
      return verbose ? await getRawTxVerbose(txid) : await getRawTxHex(txid);
    }
    // Wallet extension method (Electrum forks): verbose tx, with each input
    // enriched with the value/address it spends so the client can show fees
    // and counterparties without a second round trip.
    case "blockchain.transaction.get_detailed": {
      const txid = String(params[0]);
      const tx = (await getRawTxVerbose(txid)) as Record<string, any>;
      const vin: any[] = Array.isArray(tx.vin) ? tx.vin : [];
      await Promise.all(
        vin.slice(0, 100).map(async (input) => {
          if (!input || typeof input.txid !== "string") return; // coinbase
          try {
            const prev = (await getRawTxVerbose(input.txid)) as Record<string, any>;
            const out = prev?.vout?.[input.vout];
            if (!out) return;
            input.value = out.value;
            input.scriptPubKey = out.scriptPubKey;
            const addr =
              out.scriptPubKey?.address ?? out.scriptPubKey?.addresses?.[0];
            if (addr) input.address = addr;
          } catch {
            // A missing/pruned parent must not fail the whole lookup.
          }
        }),
      );
      return tx;
    }

    case "blockchain.transaction.broadcast": {
      const hex = String(params[0]);
      try {
        return await sendRawTx(hex);
      } catch (e) {
        const raw = (e as Error).message || "broadcast failed";
        const friendly = await explainBroadcastFailure(hex, raw);
        if (friendly.txid) return friendly.txid; // already accepted — treat as success
        // Electrum clients surface this string to the user verbatim.
        throw new RpcFault(1, friendly.message);
      }
    }

    case "blockchain.transaction.id_from_pos": {
      const height = Number(params[0]);
      const pos = Number(params[1]);
      const block = await getBlockVerbose1(await getBlockHash(height));
      const txid = block.tx[pos];
      if (!txid) throw new RpcFault(1, "no tx at position");
      return txid;
    }

    // ---- misc ----
    case "blockchain.numblocks.subscribe":
      return (await getTip()).height;
    case "server.add_peer":
      return false;
    case "blockchain.indexer.status":
      return { ...indexStats(), indexer_tip: indexerTipHeight(), node_tip: (await getTip()).height };
  }
  throw new RpcFault(-32601, `unknown method "${method}"`);
}

/**
 * Turn a raw texitcoind broadcast rejection into something a wallet user can act
 * on — and detect the cases that aren't really failures at all.
 *
 * `txn-mempool-conflict` means another *pending* transaction already spends one
 * of the same coins. That usually happens when a wallet retries a send after a
 * timeout, or when two devices share a seed. If the conflict is literally our
 * own transaction, the send already succeeded and we return its txid.
 */
async function explainBroadcastFailure(
  hex: string,
  raw: string,
): Promise<{ txid?: string; message: string }> {
  let decoded: { txid: string; vin: { txid?: string; vout?: number }[] } | null = null;
  try {
    decoded = await decodeRawTx(hex);
  } catch {
    decoded = null;
  }

  const alreadyKnown = /already[- ]?in[- ]?mempool|txn-already-known|already in block chain|txn-already-in-mempool/i;
  if (decoded && alreadyKnown.test(raw)) return { txid: decoded.txid, message: raw };

  if (decoded && /txn-mempool-conflict|insufficient fee|txn-already/i.test(raw)) {
    // Is our exact transaction already known to the node? Then it went through.
    try {
      await getRawTxVerbose(decoded.txid);
      return { txid: decoded.txid, message: raw };
    } catch {
      /* not known — a genuine conflict */
    }
  }

  if (/txn-mempool-conflict/i.test(raw)) {
    const conflict = decoded ? await findConflictingMempoolTx(decoded) : null;
    const suffix = conflict ? ` (pending transaction ${conflict})` : "";
    return {
      message:
        "Those coins are already being spent by an unconfirmed transaction" +
        suffix +
        ". Wait for it to confirm — about a block — then send again.",
    };
  }

  return { message: raw };
}

/** Find the mempool transaction spending one of our inputs, if we can. */
async function findConflictingMempoolTx(decoded: {
  vin: { txid?: string; vout?: number }[];
}): Promise<string | null> {
  const wanted = new Set(
    decoded.vin.filter((i) => i.txid).map((i) => `${i.txid}:${i.vout ?? 0}`),
  );
  if (wanted.size === 0) return null;
  try {
    const txids = await getRawMempoolTxids();
    // Our mempool is tiny; cap the scan so a flood can never stall a send.
    for (const txid of txids.slice(0, 200)) {
      let tx: Record<string, unknown>;
      try {
        tx = await getRawTxVerbose(txid);
      } catch {
        continue;
      }
      const vin = (tx.vin as { txid?: string; vout?: number }[] | undefined) ?? [];
      for (const i of vin) {
        if (i.txid && wanted.has(`${i.txid}:${i.vout ?? 0}`)) return txid;
      }
    }
  } catch {
    /* mempool unavailable — the generic message still helps */
  }
  return null;
}
