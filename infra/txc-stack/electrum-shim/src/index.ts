// Electrum protocol server: newline-delimited JSON-RPC over raw TCP and TLS.
// Speaks enough of protocol 1.4 for BlueWallet-family clients (the TXC Wallet
// app) to work against our own indexer instead of the ElectrumX fleet.

import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import { handle, RpcFault, getTip, statusFor } from "./methods.js";
import { refreshScripthashMap } from "./db.js";

const TCP_PORT = Number(process.env.TCP_PORT ?? 50001);
const TLS_PORT = Number(process.env.TLS_PORT ?? 50002);
const TLS_CERT = process.env.TLS_CERT ?? "";
const TLS_KEY = process.env.TLS_KEY ?? "";
const TIP_POLL_MS = Number(process.env.TIP_POLL_MS ?? 5000);
const MAP_REFRESH_MS = Number(process.env.MAP_REFRESH_MS ?? 60_000);
const MAX_LINE = 2 * 1024 * 1024;

interface Client {
  socket: net.Socket;
  buf: string;
  headersSub: boolean;
  scripthashSubs: Map<string, string | null>;
}

const clients = new Set<Client>();

function send(c: Client, payload: unknown): void {
  if (c.socket.destroyed) return;
  c.socket.write(JSON.stringify(payload) + "\n");
}

async function handleOne(req: Record<string, unknown>, c: Client): Promise<unknown> {
  const id = req.id ?? null;
  const method = String(req.method ?? "");
  const params = Array.isArray(req.params) ? req.params : [];

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
    return { jsonrpc: "2.0", id, result };
  } catch (e) {
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
  socket.on("close", () => clients.delete(c));
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

function start(): void {
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

  const added = refreshScripthashMap();
  console.log(`[electrum] scripthash map warm: +${added} entries`);
  setInterval(() => {
    try {
      refreshScripthashMap();
    } catch (e) {
      console.error("[electrum] map refresh failed:", (e as Error).message);
    }
  }, MAP_REFRESH_MS);
  setInterval(() => void pollTip(), TIP_POLL_MS);
  void pollTip();
}

start();

process.on("uncaughtException", (e) => console.error("[electrum] uncaught:", e));
process.on("unhandledRejection", (e) => console.error("[electrum] unhandled:", e));
