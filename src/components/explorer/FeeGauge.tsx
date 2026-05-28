import { cn } from "@/lib/utils";
import { feeBucket } from "@/lib/txc/format";
import type { FeeRecommendations } from "@/lib/txc/esplora";

interface Props {
  fees: FeeRecommendations | null;
}

const TIERS: Array<{ key: keyof FeeRecommendations; label: string; eta: string }> = [
  { key: "fastestFee", label: "Next block", eta: "~3 min" },
  { key: "halfHourFee", label: "30 minutes", eta: "~10 blocks" },
  { key: "hourFee", label: "1 hour", eta: "~20 blocks" },
  { key: "economyFee", label: "Economy", eta: "Eventually" },
];

const FEE_BG: Record<number, string> = {
  1: "bg-fee-1", 2: "bg-fee-2", 3: "bg-fee-3", 4: "bg-fee-4", 5: "bg-fee-5", 6: "bg-fee-6",
};

export function FeeGauge({ fees }: Props) {
  return (
    <div className="rounded-md surface-2 border border-border p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-display text-base uppercase tracking-wide">Fee estimates</h3>
        <span className="text-[10px] uppercase text-muted-foreground">sat/vB</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {TIERS.map((t) => {
          const v = fees?.[t.key];
          const bg = v ? FEE_BG[feeBucket(v)] : "bg-muted";
          return (
            <div
              key={t.key}
              className={cn("rounded-sm p-3 text-white relative overflow-hidden", bg)}
            >
              <div className="text-[10px] uppercase opacity-80">{t.label}</div>
              <div className="font-display text-2xl font-bold leading-tight">
                {v != null ? v : "—"}
              </div>
              <div className="text-[10px] opacity-75">{t.eta}</div>
            </div>
          );
        })}
      </div>
      {fees && (
        <div className="mt-3 text-[11px] text-muted-foreground font-mono">
          minimum relay: {fees.minimumFee} sat/vB
        </div>
      )}
    </div>
  );
}
