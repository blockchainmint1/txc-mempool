import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { compactTx } from "./compact-mempool.js";
import { closeWhenIdle, dispatch } from "./protocol.js";
import { headerCount, IDLE_TIMEOUT_MS, mapLimited, TokenBucket, WorkGate } from "./resource-controls.js";

test("51-entry batches are rejected without invoking handlers", async () => {
  let called = 0;
  const out = await dispatch(Array.from({ length: 51 }, (_, id) => ({ id })),
    new TokenBucket(), async () => { called++; });
  assert.deepEqual(out, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large" } });
  assert.equal(called, 0);
});

test("100 requests at once admit 40, reject 60, and refill 20 per second", async () => {
  let now = 0;
  const bucket = new TokenBucket(20, 40, () => now);
  let called = 0;
  const responses = await Promise.all(Array.from({ length: 100 }, (_, id) =>
    dispatch({ id }, bucket, async req => { called++; return { id: req.id, result: null }; })));
  assert.equal(called, 40);
  assert.equal(responses.filter(out => (out as { error?: { code: number } }).error?.code === -32000).length, 60);
  assert.deepEqual(responses[40], { jsonrpc: "2.0", id: 40, error: { code: -32000, message: "rate limited" } });
  now = 1000;
  for (let i = 0; i < 20; i++) assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
});

test("batch handlers use four workers and retain IDs and response ordering", async () => {
  let active = 0;
  let peak = 0;
  const responses = await dispatch(Array.from({ length: 40 }, (_, id) => ({ id })),
    new TokenBucket(), async req => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return { id: req.id, result: req.id };
    });
  assert.equal(peak, 4);
  assert.deepEqual(responses, Array.from({ length: 40 }, (_, id) => ({ id, result: id })));
});

test("RPC gate bounds work to eight and waiting callers to 200", async () => {
  const gate = new WorkGate(8, 200);
  const releases = await Promise.all(Array.from({ length: 8 }, () => gate.acquire()));
  const queued = Array.from({ length: 200 }, () => gate.acquire());
  assert.deepEqual(gate.stats(), { active: 8, queued: 200 });
  await assert.rejects(gate.acquire(), /rpc queue full/);
  for (const release of releases) release();
  for (const waiting of queued) (await waiting)();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test("RPC waiting deadline removes timed-out callers", async () => {
  const gate = new WorkGate(1, 1, 10);
  const release = await gate.acquire();
  await assert.rejects(gate.acquire(), /rpc queue full/);
  release(); release();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test("headers are capped at 500", () => {
  assert.equal(headerCount(2016), 500);
  assert.equal(headerCount(3), 3);
  assert.equal(headerCount(-1), 0);
  assert.equal(headerCount(Infinity), 0);
});

test("input resolution uses four workers", async () => {
  let active = 0; let peak = 0;
  const out = await mapLimited(Array.from({ length: 100 }, (_, i) => i), 4, async i => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--; return i;
  });
  assert.equal(peak, 4);
  assert.equal(out.length, 100);
});

test("compact pending transactions preserve spent inputs, values and both address forms without hex", () => {
  assert.deepEqual(compactTx({ hex: "f".repeat(10000), vin: [{ txid: "parent", vout: 2, scriptSig: { hex: "ff" } }, { coinbase: "ff" }],
    vout: [{ n: 0, value: 1.25, scriptPubKey: { address: "one", hex: "ff" } },
      { n: 1, value: 2, scriptPubKey: { addresses: ["two", "three"] } }] }), {
    vin: [{ txid: "parent", vout: 2 }],
    vout: [{ n: 0, value: 1.25, addresses: ["one"] }, { n: 1, value: 2, addresses: ["two", "three"] }],
  });
});

test("idle policy is ten minutes and closes silent real TCP sockets", async () => {
  assert.equal(IDLE_TIMEOUT_MS, 600000);
  const server = net.createServer(socket => closeWhenIdle(socket, 30));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = net.connect(address.port, "127.0.0.1");
  await once(socket, "connect");
  await once(socket, "close");
  await new Promise<void>(resolve => server.close(() => resolve()));
});