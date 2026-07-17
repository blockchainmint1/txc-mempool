// Tiny JSON-RPC client for texitcoind. Uses fetch with HTTP basic auth.
// We deliberately avoid the heavy bitcoin-core npm clients — TexitCoin uses
// the same RPC surface as Bitcoin Core but we only need a handful of calls.

const RPC_URL = process.env.RPC_URL ?? "http://host.docker.internal:15739";
const RPC_USER = process.env.RPC_USER ?? "";
const RPC_PASS = process.env.RPC_PASSWORD ?? "";
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 60_000);

const AUTH = "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64");

let nextId = 1;

export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const id = nextId++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTH },
      body: JSON.stringify({ jsonrpc: "1.0", id, method, params }),
      signal: ctrl.signal,
    });

    // Bitcoin Core sometimes rejects with a plain-text body instead of JSON —
    // most commonly "Work queue depth exceeded" when rpcworkqueue is full, or
    // "Service Unavailable" during warmup. Peek at the body as text first and
    // only JSON-parse when it looks like JSON, so the indexer can treat these
    // as retryable RPC errors instead of crashing with "Unexpected token W".
    const raw = await res.text();
    const trimmed = raw.trimStart();
    const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");

    if (!looksJson) {
      const snippet = raw.slice(0, 120).replace(/\s+/g, " ").trim() || res.statusText;
      throw new RpcError(res.status || 502, `Non-JSON RPC response (${res.status}): ${snippet}`);
    }

    if (!res.ok && res.status !== 500) {
      throw new RpcError(res.status, `HTTP ${res.status} from ${method}`);
    }
    const body = JSON.parse(raw) as { result: T; error: { code: number; message: string } | null };
    if (body.error) throw new RpcError(body.error.code, body.error.message);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Typed helpers for the calls we actually use ----

export interface RpcVin {
  txid?: string;
  vout?: number;
  coinbase?: string;
  sequence: number;
  scriptSig?: { asm: string; hex: string };
  txinwitness?: string[];
}
export interface RpcVout {
  value: number; // TXC (not sats)
  n: number;
  scriptPubKey: {
    asm: string;
    hex: string;
    type: string;
    address?: string;
    addresses?: string[];
  };
}
export interface RpcTx {
  txid: string;
  hash: string;
  version: number;
  size: number;
  vsize: number;
  weight: number;
  locktime: number;
  vin: RpcVin[];
  vout: RpcVout[];
  hex: string;
  blockhash?: string;
  confirmations?: number;
  time?: number;
  blocktime?: number;
}
export interface RpcBlock {
  hash: string;
  confirmations: number;
  height: number;
  version: number;
  versionHex: string;
  merkleroot: string;
  time: number;
  mediantime: number;
  nonce: number;
  bits: string;
  difficulty: number;
  previousblockhash?: string;
  nextblockhash?: string;
  size: number;
  weight: number;
  nTx: number;
  tx: RpcTx[]; // when verbosity=2
}

export const getBlockCount = () => rpc<number>("getblockcount");
export const getBlockHash = (h: number) => rpc<string>("getblockhash", [h]);
export const getBlockVerbose = (hash: string) => rpc<RpcBlock>("getblock", [hash, 2]);
export const getRawTx = (txid: string) => rpc<RpcTx>("getrawtransaction", [txid, true]);
export const getRawMempool = () => rpc<string[]>("getrawmempool");

// Verbose mempool: { txid: { vsize, weight, fee (TXC), fees: { base, modified, ancestor, descendant }, ... } }
export interface RpcMempoolEntry {
  vsize: number;
  weight?: number;
  size?: number;
  time: number;
  fee?: number; // TXC (legacy)
  fees?: {
    base: number; // TXC
    modified: number;
    ancestor: number;
    descendant: number;
  };
  depends?: string[];
}
export const getRawMempoolVerbose = () =>
  rpc<Record<string, RpcMempoolEntry>>("getrawmempool", [true]);

export interface RpcMempoolInfo {
  loaded: boolean;
  size: number;
  bytes: number;
  usage: number;
  total_fee?: number; // TXC (newer Core)
  maxmempool: number;
  mempoolminfee: number; // TXC/kvB
  minrelaytxfee: number; // TXC/kvB
}
export const getMempoolInfo = () => rpc<RpcMempoolInfo>("getmempoolinfo");

export interface RpcSmartFee {
  feerate?: number; // TXC/kvB
  blocks?: number;
  errors?: string[];
}
export const estimateSmartFee = (target: number) =>
  rpc<RpcSmartFee>("estimatesmartfee", [target, "CONSERVATIVE"]);

/** Convert a TXC/kvB feerate (Core convention) to sat/vB. */
export function feerateTxcKvbToSatVb(txcPerKvB: number | undefined): number | null {
  if (!txcPerKvB || !Number.isFinite(txcPerKvB) || txcPerKvB <= 0) return null;
  // TXC per kvB → sats per kvB → sats per vB
  return (txcPerKvB * 1e8) / 1000;
}


export function voutAddress(v: RpcVout): string | null {
  if (v.scriptPubKey.address) return v.scriptPubKey.address;
  const arr = v.scriptPubKey.addresses;
  if (arr && arr.length === 1) return arr[0];
  return null;
}

// TXC → sats. RPC returns floating-point TXC; round to satoshis.
export function txcToSats(v: number): number {
  return Math.round(v * 1e8);
}
