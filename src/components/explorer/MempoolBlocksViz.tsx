import { Link } from "@tanstack/react-router";
import { feeBucket } from "@/lib/txc/format";
import type { MempoolBlock } from "@/lib/txc/esplora";

const FEE_VAR: Record<number, string> = {
  1: "var(--color-fee-1)",
  2: "var(--color-fee-2)",
  3: "var(--color-fee-3)",
  4: "var(--color-fee-4)",
  5: "var(--color-fee-5)",
  6: "var(--color-fee-6)",
};

interface Props {
  blocks: MempoolBlock[];
}

/**
 * Isometric 3D mempool blocks — the iconic mempool.space look.
 * The block "fills up" from the bottom proportional to its weight.
 */
export function MempoolBlocksViz({ blocks }: Props) {
  if (!blocks.length) {
    return (
      <div className="rounded-md surface-2 border border-border px-4 py-6 text-sm text-muted-foreground text-center">
        Mempool is empty — next block has nothing waiting.
      </div>
    );
  }
  return (
    <div className="flex gap-5 overflow-x-auto pb-4 pt-2 px-1">
      {blocks.slice(0, 6).map((b, i) => (
        <IsoBlock key={i} block={b} index={i} />
      ))}
    </div>
  );
}

interface IsoProps {
  block: MempoolBlock;
  index: number;
}

const W = 130; // front face width
const H = 130; // front face height
const D = 22;  // isometric depth
const VW = W + D;
const VH = H + D;

function IsoBlock({ block, index }: IsoProps) {
  const color = FEE_VAR[feeBucket(block.medianFee || 1)];
  const filledPct = Math.max(2, Math.min(100, (block.blockVSize / 1_000_000) * 100));
  const filledH = (H * filledPct) / 100;
  const emptyH = H - filledH;

  // Face polygons
  const topFace = `0,${D} ${D},0 ${W + D},0 ${W},${D}`;
  const rightFace = `${W},${D} ${W + D},0 ${W + D},${H} ${W},${H + D}`;

  return (
    <Link
      to="/mempool/block/$index"
      params={{ index: String(index) }}
      className="group flex-shrink-0 animate-block-pop"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="relative" style={{ width: VW, height: VH }}>
        <svg
          viewBox={`0 0 ${VW} ${VH}`}
          width={VW}
          height={VH}
          className="overflow-visible drop-shadow-[0_8px_18px_rgba(0,0,0,0.55)] transition-transform group-hover:-translate-y-1"
        >
          <defs>
            <linearGradient id={`front-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.95" />
              <stop offset="100%" stopColor={color} stopOpacity="1" />
            </linearGradient>
            <linearGradient id={`top-${index}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.55" />
              <stop offset="100%" stopColor={color} stopOpacity="0.35" />
            </linearGradient>
            <linearGradient id={`right-${index}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={color} stopOpacity="0.65" />
              <stop offset="100%" stopColor={color} stopOpacity="0.4" />
            </linearGradient>
          </defs>

          {/* Top face */}
          <polygon points={topFace} fill={`url(#top-${index})`} stroke="rgba(0,0,0,0.25)" strokeWidth="0.5" />

          {/* Right face */}
          <polygon points={rightFace} fill={`url(#right-${index})`} stroke="rgba(0,0,0,0.25)" strokeWidth="0.5" />

          {/* Front face — empty (dark) top, filled bottom */}
          <rect x="0" y={D} width={W} height={emptyH} fill="rgba(0,0,0,0.55)" />
          <rect x="0" y={D + emptyH} width={W} height={filledH} fill={`url(#front-${index})`} />
          <rect x="0" y={D} width={W} height={H} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="0.75" />

          {/* Centered text on front face */}
          <text
            x={W / 2}
            y={D + H / 2 - 14}
            textAnchor="middle"
            className="font-display"
            fill="white"
            fontSize="18"
            fontWeight="700"
            style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.35)", strokeWidth: 0.5 }}
          >
            ~{block.medianFee.toFixed(1)}
          </text>
          <text
            x={W / 2}
            y={D + H / 2}
            textAnchor="middle"
            fill="white"
            fontSize="8"
            opacity="0.85"
            letterSpacing="0.05em"
          >
            sat/vB
          </text>
          <text
            x={W / 2}
            y={D + H / 2 + 18}
            textAnchor="middle"
            fill="white"
            fontSize="10"
            fontWeight="600"
          >
            {block.feeRange?.length >= 2
              ? `${block.feeRange[0].toFixed(1)} – ${block.feeRange[block.feeRange.length - 1].toFixed(1)}`
              : ""}
          </text>
          <text
            x={W / 2}
            y={D + H - 16}
            textAnchor="middle"
            fill="white"
            fontSize="10"
            opacity="0.9"
          >
            {block.nTx.toLocaleString()} tx
          </text>
          <text
            x={W / 2}
            y={D + H - 5}
            textAnchor="middle"
            fill="white"
            fontSize="9"
            opacity="0.75"
          >
            {(block.blockVSize / 1000).toFixed(0)} kvB
          </text>
        </svg>
      </div>
      <div className="mt-2 text-center text-[11px] font-mono text-muted-foreground group-hover:text-primary transition-colors">
        {index === 0 ? "next block" : `in ~${(index + 1) * 3} min`}
      </div>
    </Link>
  );
}
