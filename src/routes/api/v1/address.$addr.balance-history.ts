import { createFileRoute } from "@tanstack/react-router";
import { proxy } from "@/lib/api/backend";
import { optionsHandler, errorResponse } from "@/lib/api/cors";

// Backed by the TXC indexer (infra/txc-stack/indexer). Computes a balance
// time-series for an address from every credit/debit event in our DB —
// far more accurate than walking a recent page of txs in the browser.
export const Route = createFileRoute("/api/v1/address/$addr/balance-history")({
  server: {
    handlers: {
      OPTIONS: optionsHandler,
      GET: async ({ params, request }) => {
        if (!/^T[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(params.addr)) {
          return errorResponse("Invalid address", 400);
        }
        const url = new URL(request.url);
        const bucket = url.searchParams.get("bucket") === "hour" ? "hour" : "day";
        const limit = url.searchParams.get("limit") ?? "400";
        return proxy(
          `/v1/address/${params.addr}/balance-history?bucket=${bucket}&limit=${encodeURIComponent(limit)}`,
          { cacheSeconds: 30 },
        );
      },
    },
  },
});
