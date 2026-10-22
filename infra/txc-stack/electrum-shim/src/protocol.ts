import type { Socket } from "node:net";
import { IDLE_TIMEOUT_MS, MAX_BATCH, mapLimited, TokenBucket, WorkGate } from "./resource-controls.js";

function fault(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Admission happens before async work so queued batches cannot refill their own burst. */
export async function dispatch(parsed: unknown, bucket: TokenBucket,
  handle: (request: Record<string, unknown>) => Promise<unknown>,
  gate = new WorkGate(4, 1000, 30_000)): Promise<unknown> {
  const batch = Array.isArray(parsed);
  if (batch && parsed.length > MAX_BATCH) return fault(null, -32600, "batch too large");
  if (batch && parsed.length === 0) return fault(null, -32600, "Invalid Request");
  const requests: unknown[] = batch ? parsed : [parsed];
  const admitted = requests.map(request => {
    const valid = request !== null && typeof request === "object" && !Array.isArray(request);
    const req = valid ? request as Record<string, unknown> : undefined;
    if (!bucket.take()) return { error: fault(req?.id ?? null, -32000, "rate limited") };
    if (!req) return { error: fault(null, -32600, "Invalid Request") };
    // Reserve now, including queued work across other lines on this socket.
    // Capture rejection immediately so no pending permit can leak or reject unhandled.
    return { request: req, permit: gate.acquire().then(release => ({ release }),
      () => ({ error: fault(req.id ?? null, -32000, "rate limited") })) };
  });
  const out = await mapLimited(admitted, 4, async item => {
    if (!item.request || !item.permit) return item.error;
    const permit = await item.permit;
    if (!("release" in permit)) return permit.error;
    try { return await handle(item.request); }
    catch { return fault(item.request.id ?? null, -32603, "Internal error"); }
    finally { permit.release(); }
  });
  return batch ? out : out[0];
}

/** Count raw TCP arrivals too, including TLS handshakes not yet authenticated. */
export function admitConnection(socket: Socket, sockets: Set<Socket>, max: number): boolean {
  if (sockets.size >= max) { socket.destroy(); return false; }
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return true;
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