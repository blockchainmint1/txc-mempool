// Mining pool share over a time window.
//
// The upstream mempool backend runs bitcoind-only, so its own
// /v1/mining/pools/* endpoints never respond. We compute the answer here by
// sampling recent blocks and attributing each one to the pool that owns its
// coinbase payout address (see src/lib/txc/pools.ts).

import { createFileRoute } from "@tanstack/react-router";
import { CORS_HEADERS, errorResponse, optionsHandler } from "@/lib/api/cors";
import { fetchPoolNetworkStats } from "@/lib/txc/pool";
import {
  POOL_WINDOWS,
  WINDOW_SECONDS,
  tallyPools,
  type PoolWindow,
} from "@/lib/txc/pools";

const BACKEND = "https://api.mempool.texitcoin.org/api";
const BLOCK_TIME = 180;
/** Number of 15-block pages sampled across the window. */
const PAGES = 12;
/** Blocks inspected per sampled page. */
const PER_PAGE = 3;

interface ApiBlock {
  id: string;
  height: number;
  timestamp: number;
  tx_count: number;
}

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** Coinbase payout address for a block, or null if it can't be resolved. */
async function coinbaseAddress(hash: string): Promise<string | null> {
  const txs = await getJson<
    { vout: { scriptpubkey_address?: string; value: number }[] }[]
  >(`${BACKEND}/block/${hash}/txs`);
  const coinbase = txs?.[0];
  if (!coinbase) return null;
  const paid = coinbase.vout
    .filter((v) => v.scriptpubkey_address && v.value > 0)
    .sort((a, b) => b.value - a.value)[0];
  return paid?.scriptpubkey_address ?? null;
}

export const Route = createFileRoute("/api/v1/mining/pools/$window")({
  server: {
    handlers: {
      OPTIONS: optionsHandler,
      GET: async ({ params }) => {
        const win = params.window as PoolWindow;
        if (!POOL_WINDOWS.includes(win))
          return errorResponse("Invalid window. Use 24h, 1w, or 1m.", 400);

        const tipRes = await fetch(`${BACKEND}/v1/blocks/tip/height`, {
          signal: AbortSignal.timeout(8000),
        }).catch(() => null);
        if (!tipRes?.ok) return errorResponse("Upstream unavailable", 502);
        const tip = Number(await tipRes.text());
        if (!Number.isFinite(tip)) return errorResponse("Upstream unavailable", 502);

        const span = Math.floor(WINDOW_SECONDS[win] / BLOCK_TIME);
        const step = Math.max(15, Math.floor(span / PAGES));
        const pageHeights = Array.from({ length: PAGES }, (_, i) =>
          Math.max(15, tip - i * step),
        ).filter((h, i, a) => a.indexOf(h) === i);

        const pages = await mapWithConcurrency(pageHeights, 6, (h) =>
          getJson<ApiBlock[]>(`${BACKEND}/v1/blocks/${h}`),
        );
        const blocks = pages
          .filter((p): p is ApiBlock[] => Array.isArray(p) && p.length > 0)
          .flatMap((p) => p.slice(0, PER_PAGE));

        if (!blocks.length) return errorResponse("No block data available", 502);

        const addresses = await mapWithConcurrency(blocks, 6, (b) =>
          coinbaseAddress(b.id),
        );
        const pools = tallyPools(
          blocks.map((b, i) => ({ address: addresses[i], empty: b.tx_count <= 1 })),
        );

        const stats = await fetchPoolNetworkStats().catch(() => null);

        const body = {
          window: win,
          pools,
          /** Blocks actually inspected (sampled across the window). */
          blockCount: blocks.length,
          /** Blocks estimated to exist in the full window. */
          windowBlockCount: span,
          sampled: true,
          lastEstimatedHashrate: stats?.networkHashrate ?? null,
          tipHeight: tip,
          computedAt: Math.floor(Date.now() / 1000),
          method: "coinbase payout address attribution over a sampled block set",
        };

        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=600, s-maxage=600",
            ...CORS_HEADERS,
          },
        });
      },
    },
  },
});
