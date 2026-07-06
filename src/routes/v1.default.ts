import { createFileRoute } from "@tanstack/react-router";
import { optionsHandler, jsonResponse, errorResponse } from "@/lib/api/cors";
import { getTxcPrice } from "@/lib/txc/price.functions";

// Legacy compatibility endpoint for the old iOS/Android TEXITcoin app,
// which hardcodes GET /v1/default and reads `json.price` as a bare number.
// Point price.texitcoin.org (CNAME) at this project to keep those clients working.
export const Route = createFileRoute("/v1/default")({
  server: {
    handlers: {
      OPTIONS: optionsHandler,
      GET: async () => {
        try {
          const p = await getTxcPrice();
          if (!p) return errorResponse("unavailable", 503);
          return jsonResponse(
            { price: p.usd, updatedAt: p.updatedAt, source: p.source },
            { headers: { "Cache-Control": "public, max-age=60, s-maxage=60" } },
          );
        } catch (e) {
          return errorResponse((e as Error).message, 502);
        }
      },
    },
  },
});
