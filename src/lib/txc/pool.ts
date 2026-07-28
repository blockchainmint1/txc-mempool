// Live network stats straight from the TEXITcoin pool (yiimp `/api/currencies`).
//
// Why prefer the pool over our own chain-derived math: the pool tracks the
// live difficulty and target spacing continuously, so its `network_hashrate`
// is a smooth, authoritative figure. Our block-header estimator is honest but
// noisy (Poisson solve times). We use the pool for the headline "now" number
// and keep the chain math for history + as a fallback if the pool is down.

// Primary is the new honest.money pool API; the legacy yiimp host stays as a
// fallback. Some deployments report `network_hashrate: 0`, in which case we
// derive it from the live difficulty and the 180s target spacing.
const POOL_APIS = [
  "https://pool.honest.money/api/currencies",
  "https://pool.texitcoin.org/api/currencies",
];

/** TXC target block spacing, seconds. */
const TARGET_SPACING = 180;

export interface PoolNetworkStats {
  /** Network hashrate in H/s. */
  networkHashrate: number;
  difficulty: number;
  height: number;
  reward: number | null;
  blocks24h: number | null;
  poolWorkers: number | null;
}

async function fetchOne(
  url: string,
  timeoutMs: number,
): Promise<PoolNetworkStats | null> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  // The endpoint prefixes its JSON with whitespace/newlines, and some
  // deployments emit a stray BOM — slice from the first brace.
  const text = await res.text();
  const start = text.indexOf("{");
  if (start < 0) return null;
  const json = JSON.parse(text.slice(start)) as Record<string, unknown>;
  const txc = json.TXC as Record<string, unknown> | undefined;
  if (!txc) return null;

  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const difficulty = num(txc.difficulty) ?? 0;
  // Prefer the pool's published figure; if it reports 0 (some yiimp builds
  // never populate it), derive it from difficulty and target spacing.
  const hashrate =
    num(txc.network_hashrate) ??
    (difficulty > 0 ? (difficulty * 2 ** 32) / TARGET_SPACING : null);
  if (!hashrate) return null;

  return {
    networkHashrate: hashrate,
    difficulty,
    height: num(txc.height) ?? 0,
    reward: num(txc.reward),
    blocks24h: num(txc["24h_blocks"]),
    poolWorkers: Number.isFinite(Number(txc.workers)) ? Number(txc.workers) : null,
  };
}

/**
 * Fetch TXC network stats from the pool. Tries each host in order and returns
 * null if all fail, so callers can fall back to locally-computed values.
 */
export async function fetchPoolNetworkStats(
  timeoutMs = 4000,
): Promise<PoolNetworkStats | null> {
  for (const url of POOL_APIS) {
    try {
      const stats = await fetchOne(url, timeoutMs);
      if (stats) return stats;
    } catch {
      // try the next host
    }
  }
  return null;
}
