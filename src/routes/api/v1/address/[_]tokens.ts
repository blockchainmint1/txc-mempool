import { createFileRoute } from "@tanstack/react-router";
import { proxy } from "@/lib/api/backend";
import { optionsHandler } from "@/lib/api/cors";

// All known Omni-Layer tokens (properties) with holder counts.
export const Route = createFileRoute("/api/v1/address/_tokens")({
  server: {
    handlers: {
      OPTIONS: optionsHandler,
      GET: async () => proxy(`/v1/address/_tokens`, { cacheSeconds: 10 }),
    },
  },
});
