// Electrum protocol method handlers. Everything is answered from the indexer
// SQLite database and texitcoind RPC — no ElectrumX, no electrs.

import {
  confirmedBalance,
  confirmedHistory,
  fullHistory,
  indexerTipHeight,
  listUnspent,
  mempoolHistory,
  scripthashToAddress,
  unconfirmedBalance,
} from "./db.js";
import { historyStatus } from "./scripthash.js";
import {
  estimateSmartFee,
  getBlockCount,
  getBlockHash,
  getBlockHeaderHex,
  getBlockVerbose1,
  getMempoolInfo,
  getRawMempoolVerbose,
  getRawTxHex,
  getRawTxVerbose,
  sendRawTx,
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

export function statusFor(scripthash: string): string | null {
  const address = addressFor(scripthash);
  if (!address) return null;
  return historyStatus(fullHistory(address));
}

/** sat/kB -> TXC/kB, Electrum's estimatefee unit. */
function toElectrumFee(txcPerKvB: number | undefined): number {
  if (!txcPerKvB || !Number.isFinite(txcPerKvB) || txcPerKvB <= 0) return -1;
  return Number(txcPerKvB.toFixed(8));
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
      const est = await estimateSmartFee(target).catch(() => null);
      const estimated = toElectrumFee(est?.feerate);
      if (estimated > 0) return estimated;

      // Sparse chains often cannot produce a statistical estimate. Returning
      // Electrum's -1 sentinel leaves some legacy wallet fee UIs spinning, so
      // use the node's live mempool/relay floor as a safe coin-per-kB fallback.
      const info = await getMempoolInfo().catch(() => null);
      return Math.max(info?.mempoolminfee ?? 0, info?.minrelaytxfee ?? 0, 0.00001);
    }
    case "blockchain.relayfee": {
      const info = await getMempoolInfo().catch(() => null);
      return info?.minrelaytxfee ?? 0.00001;
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
      return {
        confirmed: confirmedBalance(address),
        unconfirmed: unconfirmedBalance(address),
      };
    }
    case "blockchain.scripthash.get_history": {
      const address = addressFor(String(params[0]));
      if (!address) return [];
      return [...confirmedHistory(address), ...mempoolHistory(address)];
    }
    case "blockchain.scripthash.get_mempool": {
      const address = addressFor(String(params[0]));
      if (!address) return [];
      return mempoolHistory(address);
    }
    case "blockchain.scripthash.listunspent": {
      const address = addressFor(String(params[0]));
      if (!address) return [];
      return listUnspent(address);
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
        // Electrum clients surface this string to the user verbatim.
        throw new RpcFault(1, (e as Error).message || "broadcast failed");
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
      return { indexer_tip: indexerTipHeight(), node_tip: (await getTip()).height };
  }
  throw new RpcFault(-32601, `unknown method "${method}"`);
}
