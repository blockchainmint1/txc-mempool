import { useTxcPrice } from "@/hooks/use-txc-price";

interface Props {
  /** Amount in satoshis (1 TXC = 1e8 sats). */
  sats: number;
  /** Render as a span (default) or block. */
  className?: string;
  /** Hide tiny amounts that would round to $0.00 — useful for fee badges. */
  hideZero?: boolean;
}

const SATS = 100_000_000;

/** Inline USD conversion of a sat amount, gated on the cached TXC price. */
export function UsdValue({ sats, className = "", hideZero = false }: Props) {
  const { data } = useTxcPrice();
  if (!data) return null;
  const usd = (sats / SATS) * data.usd;
  if (hideZero && Math.abs(usd) < 0.005) return null;
  const abs = Math.abs(usd);
  const fmt =
    abs >= 1
      ? usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : abs >= 0.01
        ? usd.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })
        : usd.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  return <span className={`text-muted-foreground ${className}`}>≈ ${fmt}</span>;
}
