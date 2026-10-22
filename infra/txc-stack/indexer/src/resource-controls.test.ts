import { test } from "node:test";
import assert from "node:assert/strict";
import { CompactParents, mapLimited, OverloadError, rewardWindow, WorkGate } from "./resource-controls.js";

test("RPC permits and queue are finite, overflow rejects and permits recover", async () => {
  const gate = new WorkGate(2, 1);
  const a = await gate.acquire(); const b = await gate.acquire();
  const pending = gate.acquire();
  assert.deepEqual(gate.stats(), { active: 2, queued: 1 });
  await assert.rejects(gate.acquire(), OverloadError);
  a(); const c = await pending;
  assert.deepEqual(gate.stats(), { active: 2, queued: 0 });
  a(); b(); c();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});
test("timed-out and cancelled waiters leave no retained queue entries", async () => {
  const gate = new WorkGate(1, 2, 5);
  const release = await gate.acquire();
  await assert.rejects(gate.acquire(), OverloadError);
  const ctrl = new AbortController();
  const pending = gate.acquire(ctrl.signal); ctrl.abort();
  await assert.rejects(pending);
  assert.deepEqual(gate.stats(), { active: 1, queued: 0 });
  release(); (await gate.acquire())();
  assert.equal(gate.stats().active, 0);
});
test("input hydration uses at most four workers and preserves order", async () => {
  let active = 0; let peak = 0;
  const out = await mapLimited(Array.from({length: 40}, (_, i) => i), 4, async i => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 1)); active--; return i * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(out, Array.from({length: 40}, (_, i) => i * 2));
});
test("worker failure drains active tasks and stops scheduling", async () => {
  let active = 0; let started = 0;
  await assert.rejects(mapLimited([0,1,2,3,4,5], 2, async i => {
    active++; started++;
    try { if (i === 0) throw new Error('failure'); await new Promise(r => setTimeout(r, 5)); return i; }
    finally { active--; }
  }));
  assert.equal(active, 0); assert.ok(started <= 2);
});
test("duplicate concurrent parent lookups issue one load and cache is bounded", async () => {
  let calls = 0;
  const cache = new CompactParents(async id => { calls++; await new Promise(r => setTimeout(r, 1)); return {id}; }, 4);
  const rows = await Promise.all(Array.from({length: 50}, () => cache.get('parent')));
  assert.equal(calls, 1); assert.equal(rows[49].id, 'parent');
  for (let i=0; i<100; i++) await cache.get(String(i));
  assert.equal(cache.size, 4);
});
test("failed parent lookup is removed and can retry", async () => {
  let calls=0;
  const cache = new CompactParents(async () => { if (++calls === 1) throw new Error('offline'); return 42; });
  await assert.rejects(cache.get('parent'));
  assert.equal(cache.size, 0); assert.equal(await cache.get('parent'), 42);
});
test("fractional reward windows cannot create unlimited cache keys", () => {
  const keys = new Set(Array.from({length: 10000}, (_, i) => rewardWindow(String(100 + i/10000))));
  assert.deepEqual([...keys], [100]);
  assert.equal(rewardWindow('Infinity'), 500);
  assert.equal(rewardWindow('-1'), 1);
  assert.equal(rewardWindow('NaN'), 100);
});