export class OverloadError extends Error {
  constructor(message = "Service busy; retry shortly") { super(message); }
}

/** A finite waiting room: permits include retry/backoff time. */
export class WorkGate {
  private active = 0;
  private waiters: Array<{ grant: () => void }> = [];
  constructor(private readonly limit: number, private readonly maxQueue: number, private readonly waitMs = 2000) {}
  stats() { return { active: this.active, queued: this.waiters.length }; }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
      return this.releaseOnce();
    }
    if (this.waiters.length >= this.maxQueue) throw new OverloadError();
    await new Promise<void>((resolve, reject) => {
      const remove = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => { remove(); reject(signal?.reason ?? new OverloadError()); };
      const waiter = { grant: () => { remove(); resolve(); } };
      const timer = setTimeout(() => { remove(); reject(new OverloadError("RPC waiting room timed out")); }, this.waitMs);
      this.waiters.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
    // The releasing caller transfers its existing permit to us.
    return this.releaseOnce();
  }
  private releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters[0];
      if (next) next.grant(); else this.active--;
    };
  }
}

export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  let failure: unknown;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i]); }
      catch (error) { failed = true; failure = error; }
    }
  }));
  if (failed) throw failure;
  return out;
}

/** Store pending promises immediately, and cap retained parent-output data. */
export class CompactParents<T> {
  private entries = new Map<string, Promise<T>>();
  private sizes = new Map<string, number>();
  private bytes = 0;
  constructor(private readonly load: (id: string) => Promise<T>, private readonly limit = 64,
    private readonly weigh: (value: T) => number = () => 0, private readonly maxBytes = 4 * 1024 * 1024) {}
  private drop(id: string) {
    this.entries.delete(id);
    this.bytes -= this.sizes.get(id) ?? 0;
    this.sizes.delete(id);
  }
  get(id: string): Promise<T> {
    const cached = this.entries.get(id);
    if (cached) return cached;
    while (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    const pending = this.load(id).then(value => {
      if (this.entries.get(id) === pending) {
        const size = this.weigh(value);
        if (size > this.maxBytes) this.drop(id);
        else {
          this.sizes.set(id, size); this.bytes += size;
          while (this.bytes > this.maxBytes) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.drop(oldest);
          }
        }
      }
      return value;
    }).catch(error => {
      if (this.entries.get(id) === pending) this.drop(id);
      throw error;
    });
    this.entries.set(id, pending);
    return pending;
  }
  get size() { return this.entries.size; }
  get retainedBytes() { return this.bytes; }
}

export function rewardWindow(raw: string): number {
  return Math.min(Math.max(Math.floor(Number(raw) || 100), 1), 500);
}