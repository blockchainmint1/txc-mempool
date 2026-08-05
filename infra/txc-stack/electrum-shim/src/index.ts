// Electrum protocol server: newline-delimited JSON-RPC over raw TCP and TLS.
// Speaks enough of protocol 1.4 for BlueWallet-family clients (the TXC Wallet
// app) to work against our own indexer instead of the ElectrumX fleet.

import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import { handle, RpcFault, getTip, statusFor } from "./methods.js";
import { indexStats, refreshScripthashMap } from "./db.js";
import { startFeeWarmer } from "./fees.js";

const TCP_PORT = Number(process.env.TCP_PORT ?? 50001);
const TLS_PORT = Number(process.env.TLS_PORT ?? 50002);
const TLS_CERT = process.env.TLS_CERT ?? "";
const TLS_KEY = process.env.TLS_KEY ?? "";
const TIP_POLL_MS = Number(process.env.TIP_POLL_MS ?? 5000);
const MAP_REFRESH_MS = Number(process.env.MAP_REFRESH_MS ?? 60_000);
// LOG_REQUESTS=true logs every single call, which floods the container log on a
// live wallet (a HD scan is hundreds of get_balance calls). Default behaviour is
// to count calls per method and report them once in the periodic health line.
const LOG_REQUESTS = process.env.LOG_REQUESTS === "true";
const LOG_CONNECTIONS = process.env.LOG_CONNECTIONS !== "false";
const methodCounts = new Map<string, number>();
const MAX_LINE = 2 * 1024 * 1024;

interface Client {
  socket: net.Socket;
  buf: string;
  headersSub: boolean;
  scripthashSubs: Map<string, string | null>;
}

const clients = new Set<Client>();
let requestCount = 0;
let errorCount = 0;
let slowRequestCount = 0;
let mapRefreshRunning = false;
let lastMapStats = { scanned: 0, total: 0, ms: 0 };

function send(c: Client, payload: unknown): void {
  if (c.socket.destroyed) return;
  c.socket.write(JSON.stringify(payload) + "\n");
}

async function handleOne(req: Record<string, unknown>, c: Client): Promise<unknown> {
  const startedAt = Date.now();
  const id = req.id ?? null;
  const method = String(req.method ?? "");
  const params = Array.isArray(req.params) ? req.params : [];
  requestCount++;

  methodCounts.set(method || "<missing>", (methodCounts.get(method || "<missing>") ?? 0) + 1);
  // Sends are rare and worth a line each; everything else is counted, not logged.
  if (LOG_REQUESTS || method === "blockchain.transaction.broadcast") {
    console.log(`[electrum] request ${method || "<missing>"}`);
  }

  try {
    if (method === "blockchain.headers.subscribe") c.headersSub = true;
    if (method === "blockchain.scripthash.subscribe") {
      const sh = String(params[0] ?? "").toLowerCase();
      const status = statusFor(sh);
      c.scripthashSubs.set(sh, status);
      return { jsonrpc: "2.0", id, result: status };
    }
    if (method === "blockchain.scripthash.unsubscribe") {
      c.scripthashSubs.delete(String(params[0] ?? "").toLowerCase());
      return { jsonrpc: "2.0", id, result: true };
    }
    const result = await handle(method, params);
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 1_000) {
      slowRequestCount++;
      console.warn(`[electrum] slow request ${method} ${elapsed}ms`);
    }
    return { jsonrpc: "2.0", id, result };
  } catch (e) {
    errorCount++;
    const fault = e instanceof RpcFault ? e : new RpcFault(1, (e as Error).message);
    console.error(`[electrum] ${method} failed:`, fault.message);
    return { jsonrpc: "2.0", id, error: { code: fault.code, message: fault.message } };
  }
}

async function onLine(line: string, c: Client): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    send(c, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  // Batch requests: electrum-client uses these heavily (getHistoryBatch,
  // listunspentBatch, transaction.getBatch) — the reply must be an array.
  if (Array.isArray(parsed)) {
    const out = await Promise.all(
      parsed.map((r) => handleOne(r as Record<string, unknown>, c)),
    );
    send(c, out);
    return;
  }
  send(c, await handleOne(parsed as Record<string, unknown>, c));
}

function attach(socket: net.Socket): void {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
  const c: Client = { socket, buf: "", headersSub: false, scripthashSubs: new Map() };
  clients.add(c);

  if (LOG_CONNECTIONS) {
    console.log(`[electrum] client connected (${clients.size} active)`);
  }

  socket.on("data", (chunk) => {
    c.buf += chunk.toString("utf8");
    if (c.buf.length > MAX_LINE) {
      socket.destroy();
      return;
    }
    let nl: number;
    while ((nl = c.buf.indexOf("\n")) >= 0) {
      const line = c.buf.slice(0, nl);
      c.buf = c.buf.slice(nl + 1);
      void onLine(line, c);
    }
  });
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    clients.delete(c);
    if (LOG_CONNECTIONS) {
      console.log(`[electrum] client disconnected (${clients.size} active)`);
    }
  });
}

let lastTipHeight = -1;

async function pollTip(): Promise<void> {
  try {
    const tip = await getTip(true);
    if (tip.height !== lastTipHeight) {
      lastTipHeight = tip.height;
      for (const c of clients) {
        if (c.headersSub) {
          send(c, {
            jsonrpc: "2.0",
            method: "blockchain.headers.subscribe",
            params: [{ height: tip.height, hex: tip.hex }],
          });
        }
      }
    }
    // Push scripthash status changes (new tip or mempool movement).
    for (const c of clients) {
      for (const [sh, prev] of c.scripthashSubs) {
        const now = statusFor(sh);
        if (now !== prev) {
          c.scripthashSubs.set(sh, now);
          send(c, {
            jsonrpc: "2.0",
            method: "blockchain.scripthash.subscribe",
            params: [sh, now],
          });
        }
      }
    }
  } catch (e) {
    console.error("[electrum] tip poll failed:", (e as Error).message);
  }
}

async function refreshMap(label: "warm" | "refresh"): Promise<void> {
  if (mapRefreshRunning) return;
  mapRefreshRunning = true;
  try {
    // Tolerate older db.ts builds that returned a plain count.
    const raw = (await refreshScripthashMap()) as unknown;
    const refreshed =
      typeof raw === "number"
        ? { added: raw, scanned: raw, total: raw, ms: 0 }
        : (raw as { added: number; scanned: number; total: number; ms: number });
    lastMapStats = refreshed;
    if (label === "warm" || refreshed.added > 0 || refreshed.ms >= 1_000) {
      console.log(
        `[electrum] scripthash map ${label}: ${refreshed.total} mapped, ` +
          `+${refreshed.added} new, ${refreshed.scanned} scanned in ${refreshed.ms}ms`,
      );
    }
  } catch (e) {
    console.error("[electrum] map refresh failed:", (e as Error).message);
  } finally {
    mapRefreshRunning = false;
  }
}

function start(): void {
  startFeeWarmer();

  net.createServer(attach).listen(TCP_PORT, () =>
    console.log(`[electrum] TCP listening on ${TCP_PORT}`),
  );

  if (TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
    tls
      .createServer(
        {
          cert: fs.readFileSync(TLS_CERT),
          key: fs.readFileSync(TLS_KEY),
          minVersion: "TLSv1.2",
        },
        attach,
      )
      .listen(TLS_PORT, () => console.log(`[electrum] TLS listening on ${TLS_PORT}`));
  } else {
    console.warn("[electrum] TLS_CERT/TLS_KEY missing — TLS listener disabled");
  }

  // Start serving first; build the map in yielding batches immediately after.
  setImmediate(() => void refreshMap("warm"));
  setInterval(() => void refreshMap("refresh"), MAP_REFRESH_MS);
  setInterval(() => {
    try {
      const stats = indexStats();
      const lag = lastTipHeight < 0 ? "unknown" : String(Math.max(0, lastTipHeight - stats.indexerTip));
      console.log(
        `[electrum] health: index=${stats.indexerTip}, node=${lastTipHeight}, lag=${lag} blocks, ` +
          `addresses=${stats.indexedAddresses}, mapped=${stats.mappedScripthashes}, ` +
          `map_refresh=${mapRefreshRunning ? "running" : "idle"}, map_ms=${lastMapStats.ms}, ` +
          `txs=${stats.indexedTransactions}, clients=${clients.size}, requests=${requestCount}, ` +
          `errors=${errorCount}, slow=${slowRequestCount}`,
      );
      const top = [...methodCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([m, n]) => `${m}=${n}`)
        .join(" ");
      if (top) console.log(`[electrum] calls last 60s: ${top}`);
      methodCounts.clear();
    } catch (e) {
      console.error("[electrum] health check failed:", (e as Error).message);
    }
  }, 60_000);
  setInterval(() => void pollTip(), TIP_POLL_MS);
  void pollTip();
}

start();

process.on("uncaughtException", (e) => console.error("[electrum] uncaught:", e));
process.on("unhandledRejection", (e) => console.error("[electrum] unhandled:", e));
