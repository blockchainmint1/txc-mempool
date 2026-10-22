import type { Socket } from "node:net";
import { IDLE_TIMEOUT_MS, MAX_BATCH, mapLimited, TokenBucket } from "./resource-controls.js";

function fault(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Admission happens before async work so queued batches cannot refill their own burst. */
export async function dispatch(parsed: unknown, bucket: TokenBucket,
  handle: (request: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  const batch = Array.isArray(parsed);
  if (batch && parsed.length > MAX_BATCH) return fault(null, -32600, "batch too large");
  if (batch && parsed.length === 0) return fault(null, -32600, "Invalid Request");
  const requests: unknown[] = batch ? parsed : [parsed];
  const admitted = requests.map(request => {
    const valid = request !== null && typeof request === "object" && !Array.isArray(request);
    const req = valid ? request as Record<string, unknown> : undefined;
    if (!bucket.take()) return { error: fault(req?.id ?? null, -32000, "rate limited") };
    if (!req) return { error: fault(null, -32600, "Invalid Request") };
    return { request: req };
  });
  const out = await mapLimited(admitted, 4, async item =>
    item.request ? handle(item.request) : item.error);
  return batch ? out : out[0];
}

/** Only incoming data extends the idle deadline; outgoing notifications do not. */
export function closeWhenIdle(socket: Socket, ms = IDLE_TIMEOUT_MS): void {
  let timer: ReturnType<typeof setTimeout>;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => socket.destroy(), ms);
    timer.unref();
  };
  reset();
  socket.on("data", reset);
  socket.once("close", () => { clearTimeout(timer); socket.off("data", reset); });
}