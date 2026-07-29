// Pool attribution for TXC blocks.
//
// Our mempool backend runs in bitcoind-only mode, so its /v1/mining/pools/*
// endpoints are not implemented (they hang). We derive pool share ourselves
// from coinbase payout addresses, which on TXC map cleanly to pools.

export interface PoolShare {
  poolId: number;
  name: string;
  slug: string;
  link: string;
  address: string | null;
  blockCount: number;
  rank: number;
  emptyBlocks: number;
}

/** Known TXC pool coinbase payout addresses. */
export const KNOWN_POOLS: Record<string, { name: string; slug: string; link: string }> = {
  TjfL5Kq58h8VaJMWRkHi2T5wxA5eV6HVwB: {
    name: "honest.money",
    slug: "honest-money",
    link: "https://pool.honest.money",
  },
};

export const POOL_WINDOWS = ["24h", "1w", "1m"] as const;
export type PoolWindow = (typeof POOL_WINDOWS)[number];

export const WINDOW_SECONDS: Record<PoolWindow, number> = {
  "24h": 86_400,
  "1w": 604_800,
  "1m": 2_592_000,
};

/** Aggregate sampled coinbase addresses into a ranked pool list. */
export function tallyPools(
  samples: { address: string | null; empty: boolean }[],
): PoolShare[] {
  const byKey = new Map<string, { address: string | null; blocks: number; empty: number }>();
  for (const s of samples) {
    const key = s.address ?? "unknown";
    const cur = byKey.get(key) ?? { address: s.address, blocks: 0, empty: 0 };
    cur.blocks += 1;
    if (s.empty) cur.empty += 1;
    byKey.set(key, cur);
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.blocks - a.blocks)
    .map((p, i) => {
      const known = p.address ? KNOWN_POOLS[p.address] : undefined;
      return {
        poolId: i + 1,
        name: known?.name ?? (p.address ? `Unknown (${p.address.slice(0, 8)}…)` : "Unknown"),
        slug: known?.slug ?? "unknown",
        link: known?.link ?? "",
        address: p.address,
        blockCount: p.blocks,
        rank: i + 1,
        emptyBlocks: p.empty,
      };
    });
}
