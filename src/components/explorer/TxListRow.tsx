import { Link } from "@tanstack/react-router";
import { shortHash, timeAgo, satsToTxc } from "@/lib/txc/format";
import type { Tx } from "@/lib/txc/esplora";
import { txFeeRate } from "@/lib/txc/esplora";
import { isOpReturn } from "@/lib/txc/omni";

export function TxListRow({ tx }: { tx: Tx }) {
  const fr = txFeeRate(tx);
  const totalOut = tx.vout.reduce((s, v) => s + v.value, 0);
  const hasOmni = tx.vout.some(
    (v) => isOpReturn(v) && /^6a[0-9a-f]{0,8}6f6d6e69/i.test(v.scriptpubkey),
  );
  return (
    <Link
      to="/tx/$txid"
      params={{ txid: tx.txid }}
      className="block surface-2 border border-border rounded-md px-3 py-2.5 hover:border-primary/60 transition-colors"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-xs truncate text-foreground">{shortHash(tx.txid, 14, 14)}</div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {hasOmni && (
            <span className="px-1.5 py-0.5 rounded-sm bg-accent/20 text-accent text-[10px] uppercase font-semibold">
              Omni
            </span>
          )}
          {tx.vin[0]?.is_coinbase && (
            <span className="px-1.5 py-0.5 rounded-sm bg-warning/20 text-warning text-[10px] uppercase font-semibold">
              Coinbase
            </span>
          )}
          <span className="font-mono text-xs text-foreground">{satsToTxc(totalOut)} TXC</span>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground font-mono">
        <span>
          {tx.vin.length} → {tx.vout.length}
          {" · "}
          {fr.toFixed(2)} sat/vB
        </span>
        <span>
          {tx.status.confirmed
            ? timeAgo(tx.status.block_time)
            : "in mempool"}
        </span>
      </div>
    </Link>
  );
}
