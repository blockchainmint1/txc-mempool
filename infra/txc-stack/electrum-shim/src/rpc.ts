// Minimal JSON-RPC client for texitcoind. Same defensive body handling as the
// indexer: Core answers with plain text ("Work queue depth exceeded",
// "Service Unavailable") under load, which must be a retryable error rather
// than a JSON parse crash that takes the process down.

const RPC_URL = process.env.RPC_URL ?? "http://host.docker.internal:15739";
const RPC_USER = process.env.RPC_USER ?? "";
const RPC_PASS = process.env.RPC_PASSWORD ?? "";
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 30_000);

const AUTH = "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64");

let nextId = 1;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
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
    const raw = await res.text();
    const trimmed = raw.trimStart();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
      const snippet = raw.slice(0, 120).replace(/\s+/g, " ").trim() || res.statusText;
      throw new RpcError(res.status || 502, `Non-JSON RPC response (${res.status}): ${snippet}`);
    }
    if (!res.ok && res.status !== 500) {
      throw new RpcError(res.status, `HTTP ${res.status} from ${method}`);
    }
    const body = JSON.parse(raw) as {
      result: T;
      error: { code: number; message: string } | null;
    };
    if (body.error) throw new RpcError(body.error.code, body.error.message);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export const getBlockCount = () => rpc<number>("getblockcount");
export const getBlockHash = (height: number) => rpc<string>("getblockhash", [height]);
/** Raw 80-byte header hex — exactly what Electrum clients expect. */
export const getBlockHeaderHex = (hash: string) => rpc<string>("getblockheader", [hash, false]);
export const getRawTxHex = (txid: string) => rpc<string>("getrawtransaction", [txid]);
export const getRawTxVerbose = (txid: string) =>
  rpc<Record<string, unknown>>("getrawtransaction", [txid, true]);
export const sendRawTx = (hex: string) => rpc<string>("sendrawtransaction", [hex]);

export interface RpcMempoolEntry {
  vsize: number;
  time: number;
  fee?: number;
  fees?: { base: number };
  depends?: string[];
}
export const getRawMempoolVerbose = () =>
  rpc<Record<string, RpcMempoolEntry>>("getrawmempool", [true]);

export const estimateSmartFee = (target: number) =>
  rpc<{ feerate?: number; errors?: string[] }>("estimatesmartfee", [target, "CONSERVATIVE"]);

export const getMempoolInfo = () =>
  rpc<{ mempoolminfee: number; minrelaytxfee: number }>("getmempoolinfo");

export const getBlockVerbose1 = (hash: string) =>
  rpc<{ height: number; tx: string[] }>("getblock", [hash, 1]);

export const getRawMempoolTxids = () => rpc<string[]>("getrawmempool", [false]);
export const decodeRawTx = (hex: string) =>
  rpc<{ txid: string; vin: { txid?: string; vout?: number }[] }>("decoderawtransaction", [hex]);
