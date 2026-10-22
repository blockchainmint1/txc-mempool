import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.RPC_RETRIES = "1";
const parentId = "a".repeat(64);
const spendId = "b".repeat(64);
let parentCalls = 0;
let fail = false;
let block = false;
let unblock: (() => void) | undefined;
const barrier = new Promise<void>(resolve => { unblock = resolve; });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  const call = JSON.parse(String(options?.body));
  if (block) await barrier;
  if (fail) return new Response("Work queue depth exceeded", { status: 500 });
  if (call.params[0] === parentId) parentCalls++;
  const parent = {
    txid: parentId, vin: [], vout: Array.from({ length: 8 }, (_, n) => ({ n, value: 1, scriptPubKey: { hex: '76a9', type: 'pubkeyhash', address: 'fixture' } })),
  };
  const spend = {
    txid: spendId, version: 1, locktime: 0, size: 200, weight: 800,
    vin: Array.from({length: 8}, (_, vout) => ({txid: parentId, vout, sequence: 1})),
    vout: [{n: 0, value: 7.99, scriptPubKey: {hex: '76a9', type: 'pubkeyhash', address: 'fixture'}}],
    blockhash: 'c'.repeat(64), confirmations: 1, blocktime: 1000,
  };
  return new Response(JSON.stringify({ result: call.params[0] === parentId ? parent : spend, error: null }));
};

test("real history handlers deduplicate inputs, preserve amounts, reject overload and recover", async () => {
  const { app } = await import('./esplora.js');
  const { db } = await import('./db.js');
  try {
    db.prepare('INSERT INTO blocks VALUES (?, ?, ?)').run(100, 'c'.repeat(64), 1000);
    db.prepare('INSERT INTO address_txs VALUES (?, ?, ?)').run('fixture', spendId, 100);
    for (let i=0;i<8;i++) db.prepare('INSERT INTO outputs(txid,vout,address,value,height) VALUES (?,?,?,?,?)').run(parentId,i,'fixture',100000000,99);
    const response = await app.inject({method:'GET',url:'/address/fixture/txs'});
    assert.equal(response.statusCode, 200);
    const rows = response.json();
    assert.equal(rows.length, 1); assert.equal(parentCalls, 1);
    assert.equal(rows[0].vin.length, 8); assert.equal(rows[0].vin[0].prevout.value, 100000000);
    assert.equal(rows[0].vin[0].prevout.scriptpubkey, '76a9');
    assert.equal(rows[0].fee, 1000000); assert.equal(rows[0].status.block_height, 100);
    fail = true;
    const offline = await app.inject({method:'GET',url:'/address/fixture/txs'});
    assert.notEqual(offline.statusCode, 200); assert.equal(Array.isArray(offline.json()), false);
    fail = false; block = true;
    const pending = Array.from({length:8}, () => app.inject({method:'GET',url:'/address/fixture/txs'}));
    await new Promise(r => setTimeout(r, 20));
    const excess = await app.inject({method:'GET',url:'/address/fixture/txs'});
    assert.equal(excess.statusCode, 503); assert.equal(excess.headers['retry-after'], '5');
    const health = (await app.inject({method:'GET',url:'/health'})).json();
    assert.equal(health.hydration.active, 8); assert.ok(health.rpc.active <= 16);
    block = false; unblock?.();
    assert.ok((await Promise.all(pending)).every(r => r.statusCode === 200));
    assert.equal((await app.inject({method:'GET',url:'/address/fixture/txs'})).statusCode,200);
    const finalHealth = (await app.inject({method:'GET',url:'/health'})).json();
    assert.equal(finalHealth.hydration.active,0); assert.equal(finalHealth.rpc.active,0);
  } finally { await app.close(); db.close(); globalThis.fetch = originalFetch; }
});