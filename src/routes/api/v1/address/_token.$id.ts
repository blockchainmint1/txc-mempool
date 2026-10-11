import { createFileRoute } from "@tanstack/react-router";
import { proxy } from "@/lib/api/backend";
import { optionsHandler, errorResponse } from "@/lib/api/cors";

// One token's details plus its top holders. `_token` is a literal segment,
// so it is never treated as an address.
export const Route = createFileRoute("/api/v1/address/_token/$id")({
  server: {
    handlers: {
      OPTIONS: optionsHandler,
      GET: async ({ params, request }) => {
        if (!/^\d{1,6}$/.test(params.id)) return errorResponse("Invalid property id", 400);
        const url = new URL(request.url);
        const raw = Number(url.searchParams.get("limit") ?? 100);
        const limit = Math.max(1, Math.min(1000, Number.isFinite(raw) ? raw : 100));
        return proxy(`/v1/address/_token/${params.id}?limit=${limit}`, { cacheSeconds: 10 });
      },
    },
  },
});
