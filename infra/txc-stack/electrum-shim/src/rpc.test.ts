import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("real RPC transport limits 50 requests to eight simultaneous node calls", async () => {
  let active = 0; let peak = 0;
  const server = http.createServer((req, res) => {
    peak = Math.max(peak, ++active);
    req.resume();
    setTimeout(() => {
      active--;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: 371737, error: null }));
    }, 10);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.RPC_URL = `http://127.0.0.1:${address.port}`;
  process.env.RPC_MAX_INFLIGHT = "8";
  process.env.RPC_MAX_QUEUE = "200";
  try {
    const { rpc, rpcWorkStats } = await import("./rpc.js");
    const results = await Promise.all(Array.from({ length: 50 }, () => rpc("getblockcount")));
    assert.equal(peak, 8);
    assert.equal(results.length, 50);
    assert.ok(results.every(height => height === 371737));
    assert.deepEqual(rpcWorkStats(), { active: 0, queued: 0 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});