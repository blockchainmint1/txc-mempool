import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}

export function StatTile({ label, value, hint, className }: Props) {
  return (
    <div className={cn("rounded-md surface-2 border border-border p-4 flex flex-col gap-1", className)}>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="font-display text-2xl font-semibold leading-tight">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground font-mono">{hint}</div>}
    </div>
  );
}
