import { Link } from "@tanstack/react-router";
import { feeBucket } from "@/lib/txc/format";
import type { BlockSummary } from "@/lib/txc/esplora";
import { Block3D } from "./Block3D";

const FEE_VAR: Record<number, string> = {
  1: "var(--color-fee-1)",
  2: "var(--color-fee-2)",
  3: "var(--color-fee-3)",
  4: "var(--color-fee-4)",
  5: "var(--color-fee-5)",
  6: "var(--color-fee-6)",
};

interface Props {
  blocks: BlockSummary[];
  emptyLabel?: string;
}

/**
 * Confirmed (mined) blocks — a chain of real 3D cubes receding to the right
 * (further into the past). Newest block is closest; older blocks recede.
 */
export function ConfirmedBlocksStrip({ blocks, emptyLabel = "Waiting for blocks…" }: Props) {
  if (!blocks.length) {
    return (
      <div className="rounded-md surface-2 border border-border px-4 py-8 text-sm text-muted-foreground text-center">
        {emptyLabel}
      </div>
    );
  }
  const items = blocks.slice(0, 6);
  return (
    <div className="relative scene-3d pt-8 pb-12 px-2 overflow-hidden rounded-lg surface-2 border border-border">
      <div className="chain-stars" />
      <div className="chain-floor" />
      <div className="chain-row chain-row-confirmed relative flex items-end gap-3 justify-end">
        {items.map((b, i) => {
          const median = b.extras?.medianFee ?? 0;
          const color = FEE_VAR[feeBucket(median || 1)];
          const scale = 1 - i * 0.07;
          const fees = b.extras?.totalFees;
          const reward = b.extras?.reward;
          return (
            <Link
              key={b.id}
              to="/block/$hash"
              params={{ hash: b.id }}
              className="group flex flex-col items-center animate-block-pop"
              style={{
                animationDelay: `${i * 80}ms`,
                transformStyle: "preserve-3d",
              }}
            >
              <Block3D
                color={color}
                size={140}
                depth={44}
                scale={scale}
                emptyPct={0}
                rotateY={32}
                rotateX={-18}
              >
                <div className="font-display text-xl font-bold leading-none drop-shadow-[0_2px_3px_rgba(0,0,0,0.5)]">
                  {b.height.toLocaleString()}
                </div>
                <div className="text-[9px] uppercase tracking-widest opacity-80 mt-1">height</div>
                <div className="text-[10px] font-semibold mt-2 opacity-95">
                  ~{median ? median.toFixed(1) : "—"} sat/vB
                </div>
                {fees != null && (
                  <div className="text-[10px] mt-2 opacity-90">
                    {(fees / 1e8).toFixed(4)} TXC
                  </div>
                )}
                <div className="text-[9px] mt-1 opacity-75">
                  {b.tx_count} tx · {Math.round(b.size / 1024)} kB
                </div>
              </Block3D>
              <div className="mt-4 text-[10px] font-mono text-muted-foreground group-hover:text-primary transition-colors truncate max-w-[140px]">
                {b.extras?.pool?.name ?? (reward ? `${(reward / 1e8).toFixed(2)} TXC` : "—")}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
