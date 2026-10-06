import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer,
} from "recharts";

interface BlockTimePoint {
  timestamp: number;
  avg: number;
  min?: number;
  max?: number;
  /** Present only in per-block mode. */
  height?: number;
}

interface BlockTimeResponse {
  window: string;
  targetBlockTimeSec: number;
  avgBlockTimeSec: number;
  fastestSec: number;
  slowestSec: number;
  sampledIntervals: number;
  series: BlockTimePoint[];
}

type Window = "blocks" | "1d" | "7d" | "30d";
const WINDOWS: { value: Window; label: string }[] = [
  { value: "blocks", label: "Per block" },
  { value: "1d", label: "1D" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
];

const WINDOW_LABEL: Record<Window, string> = {
  blocks: "last ~105 blocks",
  "1d": "24h",
  "7d": "7d",
  "30d": "30d",
};

/** Seconds → "m:ss" (or "h:mm:ss" for extreme outliers). */
function formatDuration(sec: number): string {
  const s = Math.round(sec);
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}:${String(m).padStart(2, "0")}h`;
  }
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function BlockTimeChart() {
  const [win, setWin] = useState<Window>("7d");
  const q = useQuery({
    queryKey: ["block-times", win],
    queryFn: async (): Promise<BlockTimeResponse> => {
      const res = await fetch(
        win === "blocks" ? `/api/v1/block-times?mode=blocks` : `/api/v1/block-times?window=${win}`,
      );
      if (!res.ok) throw new Error(`block-times ${res.status}`);
      return res.json();
    },
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
    retry: 2,
    retryDelay: (a) => 1000 * 2 ** a,
  });

  const target = q.data?.targetBlockTimeSec ?? 180;
  // Bars taller than 2.5× target are "slow" outliers and render in red.
  const slowThreshold = target * 2.5;

  const xTickFormat = (t: number) => {
    const d = new Date(t * 1000);
    if (win === "blocks" || win === "1d")
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  return (
    <div className="rounded-md surface-2 border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-1.5 h-5 bg-primary" />
          <h3 className="font-display text-sm uppercase tracking-widest text-foreground">
            Block Time
          </h3>
        </div>
        <div className="inline-flex rounded-sm border border-border bg-surface-1 p-0.5 font-mono text-[11px]">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              onClick={() => setWin(w.value)}
              className={`px-3 py-1 rounded-sm uppercase tracking-wider transition-colors ${
                win === w.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 border-b border-border">
        <div className="p-4 border-r border-border">
          <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">
            Avg block time
          </p>
          <p className="text-xl font-mono font-bold text-accent">
            {q.data ? formatDuration(q.data.avgBlockTimeSec) : "—"}
          </p>
        </div>
        <div className="p-4 md:border-r border-border">
          <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">
            Target time
          </p>
          <p className="text-xl font-mono font-bold text-foreground">
            {formatDuration(target)}
          </p>
        </div>
        <div className="p-4 border-r border-border border-t md:border-t-0">
          <p className="text-[10px] font-mono text-primary uppercase tracking-widest mb-1">
            Slowest ({WINDOW_LABEL[win]})
          </p>
          <p className="text-xl font-mono font-bold text-primary">
            {q.data ? formatDuration(q.data.slowestSec) : "—"}
          </p>
        </div>
        <div className="p-4 border-t md:border-t-0">
          <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">
            Fastest ({WINDOW_LABEL[win]})
          </p>
          <p className="text-xl font-mono font-bold text-accent">
            {q.data ? formatDuration(q.data.fastestSec) : "—"}
          </p>
        </div>
      </div>

      {/* Chart */}
      {q.isLoading && (
        <div className="h-56 flex items-center justify-center text-xs text-muted-foreground">
          Measuring block intervals…
        </div>
      )}
      {q.isError && (
        <div className="h-56 flex items-center justify-center text-xs text-muted-foreground">
          Couldn't compute block times right now.
        </div>
      )}
      {q.data && q.data.series.length > 0 && (
        <div className="h-56 px-2 pt-4">
          <ResponsiveContainer>
            <BarChart data={q.data.series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="timestamp"
                tickFormatter={xTickFormat}
                stroke="var(--color-muted-foreground)"
                fontSize={10}
              />
              <YAxis
                stroke="var(--color-muted-foreground)"
                fontSize={10}
                tickFormatter={(v: number) => formatDuration(v)}
                width={48}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--color-popover)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                }}
                labelFormatter={(l) => new Date((l as number) * 1000).toLocaleString()}
                formatter={(v: number, name: string) => [
                  formatDuration(v),
                  name === "avg" ? "avg block time" : name,
                ]}
              />
              <ReferenceLine
                y={target}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
                label={{
                  value: `target ${formatDuration(target)}`,
                  position: "insideTopRight",
                  fill: "var(--color-muted-foreground)",
                  fontSize: 9,
                  fontFamily: "var(--font-mono)",
                }}
              />
              <Bar dataKey="avg" radius={[2, 2, 0, 0]}>
                {q.data.series.map((p) => (
                  <Cell
                    key={p.timestamp}
                    fill={
                      p.avg > slowThreshold
                        ? "var(--color-primary)"
                        : "var(--color-accent)"
                    }
                    fillOpacity={p.avg > slowThreshold ? 0.85 : 0.55}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="px-4 py-2 text-[10px] font-mono text-muted-foreground/70 border-t border-border">
        {q.data
          ? `${q.data.sampledIntervals} intervals sampled · red bars = slower than ${formatDuration(slowThreshold)} · cached 5 min`
          : "computed locally from block headers"}
      </p>
    </div>
  );
}
