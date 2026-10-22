/** All limits are local to the AWS Node service, never imported by the site. */
export class OverloadError extends Error {}

export class WorkGate {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number, private readonly maxQueue: number,
    private readonly waitMs = 2000) {}
  stats() { return { active: this.active, queued: this.waiters.length }; }
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      if (this.waiters.length >= this.maxQueue) throw new OverloadError("rpc queue full");
      await new Promise<void>((resolve, reject) => {
        const grant = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const i = this.waiters.indexOf(grant);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new OverloadError("rpc queue full"));
        }, this.waitMs);
        this.waiters.push(grant);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(); else this.active--;
    };
  }
}

export async function mapLimited<T, R>(items: T[], limit: number,
  fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export function positiveInteger(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Debit each request, not each line or batch. Refill uses monotonic time. */
export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(private readonly rate = positiveInteger(process.env.CLIENT_REQUESTS_PER_SECOND, 200),
    private readonly burst = positiveInteger(process.env.CLIENT_REQUEST_BURST, 1000),
    private readonly clock = () => performance.now()) {
    this.tokens = burst;
    this.at = clock();
  }
  take(): boolean {
    const now = this.clock();
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.at) * this.rate / 1000);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

// Existing mobile wallets batch 200 balances and 100 history/UTXO requests.
export const MAX_BATCH = positiveInteger(process.env.MAX_BATCH, 200);
export const MAX_HEADERS = 500;
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export function headerCount(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(MAX_HEADERS, Math.max(0, Math.floor(n))) : 0;
}