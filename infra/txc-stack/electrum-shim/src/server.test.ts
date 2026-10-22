import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { addressToScripthash } from "./scripthash.js";

test("real wallet TCP flow preserves balance/history/UTXOs, pending funds, detailed inputs and broadcast", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "txc-wallet-test-"));
  const address = "TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m";
  const sh = addressToScripthash(address);
  assert.ok(sh);
  const dbPath = join(dir, "index.sqlite");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE blocks(height INTEGER,hash TEXT,time INTEGER);
    CREATE TABLE balances(address TEXT,balance INTEGER);
    CREATE TABLE address_txs(address TEXT,txid TEXT,height INTEGER);
    CREATE TABLE outputs(txid TEXT,vout INTEGER,address TEXT,value INTEGER,height INTEGER,spent_txid TEXT);
    CREATE TABLE mempool_address_txs(address TEXT,txid TEXT,delta INTEGER);`);
  db.prepare("INSERT INTO blocks VALUES (100,?,1000)").run("a".repeat(64));
  db.prepare("INSERT INTO balances VALUES (?,125000000)").run(address);
  db.prepare("INSERT INTO address_txs VALUES (?, 'confirmed',100)").run(address);
  db.prepare("INSERT INTO outputs VALUES ('confirmed',0,?,125000000,100,NULL)").run(address);
  db.close();
  const mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const { method, params, id } = JSON.parse(body);
      let result: unknown = null;
      if (method === "getblockcount") result = 100;
      if (method === "getblockhash") result = "a".repeat(64);
      if (method === "getblockheader") result = "00".repeat(80);
      if (method === "getmempoolinfo") result = { mempoolminfee: 0.00001, minrelaytxfee: 0.00001, bytes: 200 };
      if (method === "estimatesmartfee") result = { feerate: 0.00001 };
      if (method === "getrawmempool") result = params[0] === true ? {} : ["pending"];
      if (method === "sendrawtransaction") result = "broadcast-id";
      if (method === "getrawtransaction") {
        result = params[0] === "detailed"
          ? { txid: "detailed", vin: [{ txid: "parent", vout: 0 }], vout: [] }
          : { txid: params[0], hex: "ff".repeat(1000), vin: [], vout: [{ n: 0,
            value: params[0] === "pending" ? 0.5 : 2, scriptPubKey: { address } }] };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result, error: null, id }));
    });
  });
  await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
  const mockAddr = mock.address();
  assert.ok(mockAddr && typeof mockAddr !== "string");
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const reserved = reservation.address();
  assert.ok(reserved && typeof reserved !== "string");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("./index.ts", import.meta.url))], {
    env: { ...process.env, INDEXER_DB_PATH: dbPath, MAP_DB_PATH: join(dir, "map.sqlite"),
      TCP_PORT: String(reserved.port), TLS_CERT: "", TLS_KEY: "", RPC_URL: `http://127.0.0.1:${mockAddr.port}`,
      LOG_CONNECTIONS: "false" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  let socket: net.Socket | undefined;
  try {
    for (let i = 0; i < 100 && !logs.includes("scripthash map warm:"); i++) {
      if (child.exitCode !== null) throw new Error(`Fixture server exited: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.match(logs, /scripthash map warm:/);
    socket = net.connect(reserved.port, "127.0.0.1");
    const connected = socket;
    let buffer = "";
    const replies: unknown[] = [];
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const reply = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
        if (Array.isArray(reply) || "id" in reply) replies.push(reply);
      }
    });
    const call = async (request: unknown): Promise<any> => {
      connected.write(JSON.stringify(request) + "\n");
      for (let i = 0; i < 500 && !replies.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(replies.length, "wallet request timed out");
      return replies.shift();
    };
    assert.equal((await call({ id: 1, method: "server.version", params: ["healthcheck", "1.4"] })).result[1], "1.4.2");
    assert.equal((await call({ id: 2, method: "blockchain.headers.subscribe" })).result.height, 100);
    for (const [method, size] of [["get_balance", 200], ["get_history", 100], ["listunspent", 100]] as const) {
      const rows = await call(Array.from({ length: size }, (_, id) => ({ id,
        method: `blockchain.scripthash.${method}`, params: [sh] })));
      assert.equal(rows.length, size);
      assert.ok(rows.every((row: any) => !row.error));
      if (method === "get_balance") assert.deepEqual(rows[0].result, { confirmed: 125000000, unconfirmed: 50000000 });
      if (method === "get_history") assert.ok(rows[0].result.some((tx: any) => tx.tx_hash === "confirmed" && tx.height === 100));
      if (method === "listunspent") assert.ok(rows[0].result.some((u: any) => u.tx_hash === "pending" && u.value === 50000000 && u.height === 0));
    }
    assert.equal((await call({ id: 3, method: "blockchain.estimatefee", params: [1] })).result, 0.00001);
    const detail = await call({ id: 4, method: "blockchain.transaction.get_detailed", params: ["detailed"] });
    assert.equal(detail.result.vin[0].value, 2);
    assert.equal(detail.result.vin[0].address, address);
    assert.equal((await call({ id: 5, method: "blockchain.transaction.broadcast", params: ["fixture-hex"] })).result, "broadcast-id");
    const rejected = await call(Array.from({ length: 201 }, (_, id) => ({ id, method: "server.ping" })));
    assert.deepEqual(rejected.error, { code: -32600, message: "batch too large" });
  } finally {
    socket?.destroy();
    child.kill();
    await new Promise<void>(resolve => child.once("close", () => resolve()));
    mock.closeAllConnections();
    await new Promise<void>(resolve => mock.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});