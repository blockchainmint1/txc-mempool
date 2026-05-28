import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { feeBucket } from "@/lib/txc/format";
import type { BlockSummary } from "@/lib/txc/esplora";

const FEE_CLASS: Record<number, string> = {
  1: "bg-fee-1",
  2: "bg-fee-2",
  3: "bg-fee-3",
  4: "bg-fee-4",
  5: "bg-fee-5",
  6: "bg-fee-6",
};

interface Props {
  blocks: BlockSummary[];
  emptyLabel?: string;
}

/** Confirmed blocks ribbon, mempool.space-style. */
export function ConfirmedBlocksStrip({ blocks, emptyLabel = "Waiting for blocks…" }: Props) {
  if (!blocks.length) {
    return (
      <div className="rounded-md surface-2 border border-border px-4 py-6 text-sm text-muted-foreground text-center">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
      {blocks.slice(0, 8).map((b) => {
        const median = b.extras?.medianFee ?? 0;
        const cls = FEE_CLASS[feeBucket(median || 1)];
        const fees = b.extras?.totalFees;
        const reward = b.extras?.reward;
        return (
          <Link
            key={b.id}
            to="/block/$hash"
            params={{ hash: b.id }}
            className="group flex-shrink-0 w-36 rounded-md overflow-hidden border border-border shadow-card hover:shadow-glow-red transition-shadow animate-block-pop"
          >
            <div
              className={cn(
                "h-28 flex flex-col items-center justify-center text-white p-2 relative",
                cls,
              )}
            >
              <div className="font-display text-2xl font-bold tracking-tight">
                {b.height.toLocaleString()}
              </div>
              <div className="text-[10px] uppercase opacity-80 mt-1">
                ~{median ? median.toFixed(1) : "—"} sat/vB
              </div>
              {fees != null && (
                <div className="text-[10px] opacity-80">
                  {(fees / 1e8).toFixed(4)} TXC fees
                </div>
              )}
            </div>
            <div className="bg-card px-2 py-1.5 text-[11px] text-muted-foreground font-mono flex flex-col gap-0.5">
              <div className="flex justify-between">
                <span>{b.tx_count} tx</span>
                <span>{Math.round(b.size / 1024)} kB</span>
              </div>
              <div className="truncate">
                {b.extras?.pool?.name ?? (reward ? `${(reward / 1e8).toFixed(2)} TXC` : "—")}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
