import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

// The UTXO endpoint is bounded: default 1000 rows, max 5000, and an
// X-Truncated header when the address has more than was returned.
test("address UTXO list is capped and flags truncation", async () => {
  const { app } = await import('./esplora.js');
  const { db } = await import('./db.js');
  try {
    db.prepare('INSERT INTO blocks VALUES (?, ?, ?)').run(100, 'c'.repeat(64), 1000);
    const insert = db.prepare('INSERT INTO outputs(txid,vout,address,value,height) VALUES (?,?,?,?,?)');
    for (let i = 0; i < 1200; i++) insert.run('a'.repeat(64), i, 'whale', 100, 100);

    const def = await app.inject({ method: 'GET', url: '/address/whale/utxo' });
    assert.equal(def.statusCode, 200);
    assert.equal(def.json().length, 1000);
    assert.equal(def.headers['x-truncated'], 'true');

    const small = await app.inject({ method: 'GET', url: '/address/whale/utxo?limit=10' });
    assert.equal(small.json().length, 10);
    assert.equal(small.headers['x-truncated'], 'true');

    const under = await app.inject({ method: 'GET', url: '/address/whale/utxo?limit=5000' });
    assert.equal(under.json().length, 1200);
    assert.equal(under.headers['x-truncated'], undefined);
  } finally { await app.close(); db.close(); }
});
