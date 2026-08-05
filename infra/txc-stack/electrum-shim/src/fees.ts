// Fee estimate cache.
//
// texitcoind's estimatesmartfee can take 20+ seconds to answer on this chain
// (sparse blocks, few fee datapoints). Electrum wallets call
// blockchain.estimatefee on every send screen and block synchronously on the
// reply, so a slow node call shows up to users as "the wallet is spinning".
//
// Strategy: never let a client wait on the node. Answer from cache, refresh in
// the background, and fall back to the relay floor while the cache is cold.

import { estimateSmartFee, getMempoolInfo } from "./rpc.js";

const TTL_MS = Number(process.env.FEE_CACHE_TTL_MS ?? 120_000);
const FLOOR = 0.00001;

interface Entry {
  value: number;
  at: number;
}

const cache = new Map<number, Entry>();
const inflight = new Set<number>();

let relayFee = FLOOR;
let relayAt = 0;

/** sat/kB -> TXC/kB, Electrum's estimatefee unit. */
function normalize(txcPerKvB: number | undefined): number {
  if (!txcPerKvB || !Number.isFinite(txcPerKvB) || txcPerKvB <= 0) return -1;
  return Number(txcPerKvB.toFixed(8));
}

async function refreshRelayFee(): Promise<number> {
  const info = await getMempoolInfo().catch(() => null);
  const floor = Math.max(info?.mempoolminfee ?? 0, info?.minrelaytxfee ?? 0, FLOOR);
  relayFee = Number(floor.toFixed(8));
  relayAt = Date.now();
  return relayFee;
}

/** Relay floor, cached. Cheap RPC, but still worth not hammering under load. */
export async function getRelayFee(): Promise<number> {
  if (Date.now() - relayAt < TTL_MS) return relayFee;
  if (relayAt === 0) return await refreshRelayFee();
  void refreshRelayFee().catch(() => {});
  return relayFee;
}

function refresh(target: number): Promise<void> {
  if (inflight.has(target)) return Promise.resolve();
  inflight.add(target);
  return estimateSmartFee(target)
    .then((est) => {
      const value = normalize(est?.feerate);
      if (value > 0) cache.set(target, { value, at: Date.now() });
    })
    .catch(() => {})
    .finally(() => {
      inflight.delete(target);
    });
}

/**
 * Fee estimate for `target` blocks. Returns immediately: a fresh cache hit, a
 * stale cache hit while a refresh runs, or the relay floor on a cold cache.
 */
export async function getFeeEstimate(target: number): Promise<number> {
  const hit = cache.get(target);
  if (hit) {
    if (Date.now() - hit.at > TTL_MS) void refresh(target);
    return hit.value;
  }

  // Cold cache: kick off the (slow) node call but do not wait on it, and
  // borrow any other target's estimate before falling back to the floor.
  void refresh(target);
  for (const [, entry] of cache) return entry.value;
  return await getRelayFee();
}

/** Keep the common wallet targets warm so clients essentially never miss. */
export function startFeeWarmer(targets: number[] = [1, 2, 3, 6, 10, 25]): void {
  const tick = () => {
    void refreshRelayFee().catch(() => {});
    for (const t of targets) void refresh(t);
  };
  tick();
  const timer = setInterval(tick, Math.max(30_000, TTL_MS));
  timer.unref?.();
}
