// Network hashrate / difficulty time series.
//
// `currentHashrate` is read live from the TEXITcoin pool
// (pool.texitcoin.org/api/currencies), which tracks difficulty and target
// spacing continuously and is therefore far steadier than a chain-derived
// estimate. If the pool is unreachable we fall back to computing it from
// block headers ourselves:
//
//     hashrate = difficulty * 2^32 / avg_block_time
//
// The historical series is always chain-derived — the pool only publishes a
// single "now" value. See src/lib/txc/hashrate.ts.

import { createFileRoute } from "@tanstack/react-router";
import { CORS_HEADERS, errorResponse, optionsHandler } from "@/lib/api/cors";
import { fetchPoolNetworkStats } from "@/lib/txc/pool.server";
import {
  difficultyFromChunks,
  hashrateFromBlocks,
  sampleHeights,
  seriesFromChunks,
  type BlockHeaderLite,
  type Window,
} from "@/lib/txc/hashrate";


const BACKEND = "https://api.mempool.texitcoin.org/api";
const VALID_WINDOWS: Window[] = ["1d", "1w", "1m", "3m", "1y"];

interface ApiBlock {
  height: number;
  timestamp: number;
  difficulty: number;
}

async function fetchBlocksAt(height: number): Promise<BlockHeaderLite[]> {
  const url = `${BACKEND}/v1/blocks/${height}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  const arr = (await res.json()) as ApiBlock[];
  return arr.map((b) => ({
    height: b.height,
    timestamp: b.timestamp,
    difficulty: b.difficulty,
  }));
}

async function fetchTipHeight(): Promise<number> {
  const res = await fetch(`${BACKEND}/v1/blocks/tip/height`);
  if (!res.ok) throw new Error(`tip ${res.status}`);
  return Number(await res.text());
}

// Run promises with limited concurrency to be polite to the backend.
async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export const Route = createFileRoute("/api/v1/mining/hashrate")({
  server: {
    handlers: {
      OPTIONS: optionsHandler,
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const windowParam = (url.searchParams.get("window") ?? "1w") as Window;
        if (!VALID_WINDOWS.includes(windowParam)) {
          return errorResponse(
            `invalid window — use one of ${VALID_WINDOWS.join(", ")}`,
            400,
          );
        }

        // Pool stats and tip lookup run in parallel — the pool call is
        // best-effort and never blocks the response.
        const poolPromise = fetchPoolNetworkStats();

        let tip: number;
        try {
          tip = await fetchTipHeight();
        } catch (e) {
          console.error("tip lookup failed", e);
          return errorResponse("Upstream unavailable", 502);
        }

        const heights = sampleHeights(tip, windowParam);
        const chunks = await mapWithConcurrency(heights, 8, fetchBlocksAt);
        const populated = chunks.filter((c) => c.length > 0);

        if (populated.length === 0) {
          return errorResponse("no block data returned from backend", 502);
        }

        // Fallback "current": median of the 3 most-recent chunk estimates.
        // Chunks are non-contiguous so we can't pool their blocks (the gaps
        // would inflate the time span); a median across them kills luck-driven
        // outliers that made a single 15-block chunk swing 2-3x.
        const byHeight = [...populated].sort(
          (a, b) => Math.max(...b.map((x) => x.height)) - Math.max(...a.map((x) => x.height)),
        );
        const recent = byHeight.slice(0, 3).map(hashrateFromBlocks).filter((h) => h > 0).sort((a, b) => a - b);
        const computedHashrate = recent.length
          ? recent.length % 2
            ? recent[recent.length >> 1]
            : (recent[recent.length / 2 - 1] + recent[recent.length / 2]) / 2
          : 0;
        const computedDifficulty = byHeight[0]?.[0]?.difficulty ?? 0;

        const pool = await poolPromise;
        const currentHashrate = pool?.networkHashrate ?? computedHashrate;
        const currentDifficulty = pool?.difficulty || computedDifficulty;

        const body = {
          window: windowParam,
          tipHeight: tip,
          computedAt: Math.floor(Date.now() / 1000),
          currentHashrate,
          currentDifficulty,
          /** Where `currentHashrate` came from. */
          source: pool ? ("pool" as const) : ("chain" as const),
          /** Chain-derived estimate, always present for comparison. */
          computedHashrate,
          poolWorkers: pool?.poolWorkers ?? null,
          blocks24h: pool?.blocks24h ?? null,
          blockReward: pool?.reward ?? null,
          hashrates: seriesFromChunks(populated),
          difficulty: difficultyFromChunks(populated),
          formula: "hashrate = difficulty * 2^32 / avg_block_time_sec",
          sampleSizePerPoint: 15,
        };


        // Edge-cache: 1d window churns; 1y is basically static.
        const cacheSeconds = windowParam === "1d" ? 60 : windowParam === "1w" ? 300 : 1800;

        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`,
            ...CORS_HEADERS,
          },
        });
      },
    },
  },
});
