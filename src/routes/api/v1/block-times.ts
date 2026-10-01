// Block time statistics: average / fastest / slowest block intervals over
// 1d / 7d / 30d windows, plus a per-chunk time series for the homepage chart.
//
// Computed from the same sampled block chunks as the hashrate endpoint —
// `/api/v1/blocks/{height}` returns 15 consecutive blocks, and the intervals
// between their timestamps are the block times.

import { createFileRoute } from "@tanstack/react-router";
import { CORS_HEADERS, errorResponse, optionsHandler } from "@/lib/api/cors";
import { sampleHeights, type BlockHeaderLite } from "@/lib/txc/hashrate";

const BACKEND = "https://api.mempool.texitcoin.org/api";

type BlockTimeWindow = "1d" | "7d" | "30d";
const VALID_WINDOWS: BlockTimeWindow[] = ["1d", "7d", "30d"];
const WINDOW_TO_SAMPLE: Record<BlockTimeWindow, "1d" | "1w" | "1m"> = {
  "1d": "1d",
  "7d": "1w",
  "30d": "1m",
};

/** TXC targets 3-minute blocks. */
export const TARGET_BLOCK_TIME_SEC = 180;

interface ApiBlock {
  height: number;
  timestamp: number;
  difficulty: number;
}

async function fetchWithRetry(
  url: string,
  { tries = 3, timeoutMs = 8000 }: { tries?: number; timeoutMs?: number } = {},
): Promise<Response | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json, text/plain, */*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      if (res.status < 500) return null;
    } catch {
      // network/timeout — retry
    }
    if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  return null;
}

async function fetchBlocksAt(height: number): Promise<BlockHeaderLite[]> {
  const res = await fetchWithRetry(`${BACKEND}/v1/blocks/${height}`);
  if (!res) return [];
  let arr: ApiBlock[];
  try {
    arr = (await res.json()) as ApiBlock[];
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((b) => ({ height: b.height, timestamp: b.timestamp, difficulty: b.difficulty }));
}

async function fetchTipHeight(): Promise<number> {
  const res = await fetchWithRetry(`${BACKEND}/v1/blocks/tip/height`, { timeoutMs: 6000 });
  if (!res) throw new Error("tip unavailable");
  const height = Number((await res.text()).trim());
  if (!Number.isFinite(height) || height <= 0) throw new Error("tip invalid");
  return height;
}

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

/** Consecutive-block intervals (seconds) within one chunk, oldest-first. */
function intervalsFromChunk(chunk: BlockHeaderLite[]): number[] {
  if (chunk.length < 2) return [];
  const sorted = [...chunk].sort((a, b) => a.timestamp - b.timestamp);
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i].timestamp - sorted[i - 1].timestamp;
    // Guard against negative/insane values from timewarped headers.
    if (dt >= 0 && dt < 24 * 3600) out.push(dt);
  }
  return out;
}

export const Route = createFileRoute("/api/v1/block-times")({
  server: {
    handlers: {
      OPTIONS: optionsHandler,
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const windowParam = (url.searchParams.get("window") ?? "7d") as BlockTimeWindow;
        if (!VALID_WINDOWS.includes(windowParam)) {
          return errorResponse(`invalid window — use one of ${VALID_WINDOWS.join(", ")}`, 400);
        }

        let tip: number;
        try {
          tip = await fetchTipHeight();
        } catch (e) {
          console.error("tip lookup failed", e);
          return errorResponse("Upstream unavailable", 502);
        }

        const heights = sampleHeights(tip, WINDOW_TO_SAMPLE[windowParam]);
        const chunks = (await mapWithConcurrency(heights, 8, fetchBlocksAt)).filter(
          (c) => c.length > 1,
        );
        if (chunks.length === 0) {
          return errorResponse("no block data returned from backend", 502);
        }

        // One series point per chunk.
        const series = chunks
          .map((chunk) => {
            const intervals = intervalsFromChunk(chunk);
            if (intervals.length === 0) return null;
            const ts =
              chunk.reduce((s, b) => s + b.timestamp, 0) / chunk.length;
            return {
              timestamp: Math.round(ts),
              avg: intervals.reduce((a, b) => a + b, 0) / intervals.length,
              min: Math.min(...intervals),
              max: Math.max(...intervals),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null)
          .sort((a, b) => a.timestamp - b.timestamp);

        // Overall stats across every sampled interval.
        const all = chunks.flatMap(intervalsFromChunk);
        if (all.length === 0) return errorResponse("no intervals computed", 502);
        const avg = all.reduce((a, b) => a + b, 0) / all.length;

        const body = {
          window: windowParam,
          tipHeight: tip,
          computedAt: Math.floor(Date.now() / 1000),
          targetBlockTimeSec: TARGET_BLOCK_TIME_SEC,
          avgBlockTimeSec: avg,
          fastestSec: Math.min(...all),
          slowestSec: Math.max(...all),
          sampledIntervals: all.length,
          series,
        };

        const cacheSeconds = windowParam === "1d" ? 120 : 600;
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
