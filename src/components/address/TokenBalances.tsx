import { useQuery } from "@tanstack/react-query";
import { TXC_API_BASE } from "@/lib/txc/network";
import { formatNumber } from "@/lib/txc/format";

interface TokenRow {
  property_id: number;
  name: string;
  divisible: boolean;
  balance: string;
}
interface TokensResponse {
  omni_height: number;
  indexed_tip: number;
  synced: boolean;
  tokens: TokenRow[];
}

function prettyAmount(s: string) {
  const [i, d] = s.split(".");
  const int = formatNumber(Number(i));
  return d ? `${int}.${d}` : int;
}

export function TokenBalances({ address }: { address: string }) {
  const q = useQuery({
    queryKey: ["mempool", "addr-tokens", address],
    queryFn: async () => {
      const r = await fetch(`${TXC_API_BASE}/v1/address/${address}/tokens`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as TokensResponse;
    },
    refetchInterval: 30_000,
    retry: 1,
  });

  if (q.isError) return null; // token service not deployed yet — stay quiet
  const d = q.data;

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Tokens</h2>
        {d && !d.synced && (
          <span className="text-xs text-warning">
            Still scanning history — block {formatNumber(d.omni_height)} of {formatNumber(d.indexed_tip)}
          </span>
        )}
      </div>
      {q.isLoading && <div className="text-sm text-muted-foreground">Loading tokens…</div>}
      {d && d.tokens.length === 0 && (
        <div className="text-sm text-muted-foreground">No token balances{d.synced ? "" : " found so far"}.</div>
      )}
      {d && d.tokens.length > 0 && (
        <ul className="divide-y divide-border">
          {d.tokens.map((t) => (
            <li key={t.property_id} className="flex items-center justify-between py-2 text-sm">
              <span>
                <span className="font-medium">{t.name}</span>
                <span className="ml-2 text-xs text-muted-foreground font-mono">#{t.property_id}</span>
              </span>
              <span className="font-mono">{prettyAmount(t.balance)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
