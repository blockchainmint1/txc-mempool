import { createFileRoute } from "@tanstack/react-router";
import { proxy } from "@/lib/api/backend";
import { optionsHandler } from "@/lib/api/cors";

// Token scanner progress: scanned Omni height vs indexed tip.
export const Route = createFileRoute("/api/v1/address/_omni/status")({
  server: {
    handlers: {
      OPTIONS: optionsHandler,
      GET: async () => proxy(`/v1/address/_omni/status`, { cacheSeconds: 5 }),
    },
  },
});
