import { createFileRoute } from "@tanstack/react-router";
import { proxy } from "@/lib/api/backend";
import { optionsHandler, errorResponse } from "@/lib/api/cors";

// Recent Omni-Layer token transactions touching one address.
const isAddr = (a: string) => /^[A-Za-z0-9]{14,120}$/.test(a);

export const Route = createFileRoute("/api/v1/address/$addr/token-txs")({
  server: {
    handlers: {
      OPTIONS: optionsHandler,
      GET: async ({ params }) => {
        if (!isAddr(params.addr)) return errorResponse("Invalid address", 400);
        return proxy(`/v1/address/${params.addr}/token-txs`, { cacheSeconds: 5 });
      },
    },
  },
});
