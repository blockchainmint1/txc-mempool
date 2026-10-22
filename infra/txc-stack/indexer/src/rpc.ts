// Tiny JSON-RPC client for texitcoind. Uses fetch with HTTP basic auth.
// We deliberately avoid the heavy bitcoin-core npm clients — TexitCoin uses
// the same RPC surface as Bitcoin Core but we only need a handful of calls.

import { OverloadError, WorkGate } from "./resource-controls.js";

const RPC_URL = process.env.RPC_URL ?? "http://host.docker.internal:15739";
const RPC_USER = process.env.RPC_USER ?? "";
const RPC_PASS = process.env.RPC_PASSWORD ?? "";
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 10_000);
const RPC_MAX_INFLIGHT = Number(process.env.RPC_MAX_INFLIGHT ?? 16);
const RPC_MAX_QUEUE = Number(process.env.RPC_MAX_QUEUE ?? 200);
const RPC_DEBUG = process.env.RPC_DEBUG === "true";
const rpcGate = new WorkGate(RPC_MAX_INFLIGHT, RPC_MAX_QUEUE);
export const rpcWorkStats = () => rpcGate.stats();

const AUTH = "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64");

let nextId = 1;

export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

// Retry policy. texitcoind answers "Work queue depth exceeded" (plain text,
// HTTP 500) when rpcworkqueue is saturated, and "Service Unavailable" during
// warmup. Both are transient: the correct response is a short backoff and a
// retry, not a 500 propagated all the way out to a browser or a wallet.
const RPC_RETRIES = Number(process.env.RPC_RETRIES ?? 3);
const RPC_RETRY_BASE_MS = Number(process.env.RPC_RETRY_BASE_MS ?? 120);

function isRetryable(err: unknown): boolean {
  if (err instanceof RpcError) {
    // Our own waiting-room rejection: retrying just adds load.
    if (err.code === 503 && err.message === "rpc queue full") return false;
    if (err.code === 502 || err.code === 503) return true;
    const m = err.message.toLowerCase();
    // Node warmup only. "Work queue depth exceeded" (HTTP 500, plain text)
    // is pushback — the correct response is to shed load, not retry.
    return (
      m.includes("service unavailable") ||
      m.includes("warming up") ||
      m.includes("loading block index")
    );
  }
  const name = (err as { name?: string })?.name;
  // AbortError (our own timeout) and low-level fetch/socket failures.
  return name === "AbortError" || name === "TypeError" || name === "FetchError";
}

/** Methods that are safe to replay. Never retry a broadcast. */
const NON_IDEMPOTENT = new Set(["sendrawtransaction"]);

export async function rpc<T = unknown>(method: string, params: unknown[] = [], signal?: AbortSignal): Promise<T> {
  let release: () => void;
  try {
    release = await rpcGate.acquire(signal);
  } catch (err) {
    if (err instanceof OverloadError) throw new RpcError(503, "rpc queue full");
    throw err;
  }
  if (RPC_DEBUG) {
    const s = rpcGate.stats();
    console.log(`[rpc] ${method} inflight=${s.active}/${RPC_MAX_INFLIGHT} queued=${s.queued}/${RPC_MAX_QUEUE}`);
  }
  try {
  const attempts = NON_IDEMPOTENT.has(method) ? 1 : RPC_RETRIES;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      signal?.throwIfAborted();
      return await rpcOnce<T>(method, params, signal);
    } catch (err) {
      lastErr = err;
      if (signal?.aborted || i === attempts - 1 || !isRetryable(err)) throw err;
      // Exponential backoff with jitter so a thundering herd of clients
      // doesn't re-saturate the work queue in lockstep.
      const wait = RPC_RETRY_BASE_MS * 2 ** i + Math.floor(Math.random() * 80);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
  } finally { release(); }
}

async function rpcOnce<T = unknown>(method: string, params: unknown[] = [], signal?: AbortSignal): Promise<T> {
  const id = nextId++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTH },
      body: JSON.stringify({ jsonrpc: "1.0", id, method, params }),
      signal: signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal,
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

// getblockcount is the single hottest RPC on the box: every explorer client
// polls the tip every couple of seconds. A 1.5s in-process cache collapses
// that into at most one node call per interval even if nginx's cache misses.
let tipCache: { height: number; at: number } | null = null;
const TIP_CACHE_MS = Number(process.env.TIP_CACHE_MS ?? 1_500);
let tipInflight: Promise<number> | null = null;

export async function getBlockCount(): Promise<number> {
  const now = Date.now();
  if (tipCache && now - tipCache.at < TIP_CACHE_MS) return tipCache.height;
  if (tipInflight) return tipInflight;
  tipInflight = (async () => { try {
    const height = await rpc<number>("getblockcount");
    tipCache = { height, at: now };
    return height;
  } catch (err) {
    // Last-known-good tip beats a 500. At most a few minutes stale, and only
    // while the node is refusing RPC.
    if (tipCache && Date.now() - tipCache.at < 180_000) return tipCache.height;
    throw err;
  } finally { tipInflight = null; } })();
  return tipInflight;
}

// Block hashes are immutable once buried, so memoize them permanently for
// heights that are well behind the tip. Saves a node round-trip on every
// /blocks listing and every block page load.
const hashCache = new Map<number, string>();
export async function getBlockHash(h: number): Promise<string> {
  const cached = hashCache.get(h);
  if (cached) return cached;
  const hash = await rpc<string>("getblockhash", [h]);
  const tip = tipCache?.height ?? h;
  if (tip - h >= 6) {
    if (hashCache.size > 20_000) hashCache.clear();
    hashCache.set(h, hash);
  }
  return hash;
}
// Uncached getblockhash for the reorg check. The memo above can mask a deep
// reorg (the cached hash matches the orphaned one we stored), so the reorg
// walk must always ask the node directly.
export const getBlockHashDirect = (h: number) => rpc<string>("getblockhash", [h]);

export const getBlockVerbose = (hash: string) => rpc<RpcBlock>("getblock", [hash, 2]);

// Verbosity 1: same header fields, but tx is just txids — no transaction
// bodies or hex. Use for block summaries and txid lists.
export type RpcBlockSummary = Omit<RpcBlock, "tx"> & { tx: string[] };
export const getBlockVerbose1 = (hash: string) => rpc<RpcBlockSummary>("getblock", [hash, 1]);
export const getRawTx = (txid: string, signal?: AbortSignal) => rpc<RpcTx>("getrawtransaction", [txid, true], signal);
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
