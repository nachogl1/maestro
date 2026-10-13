import { useSystemMetrics } from "@/hooks/useSystemMetrics";
import { formatGiB } from "@/lib/format";

function barColor(percent: number): string {
  if (percent < 50) return "bg-maestro-green";
  if (percent <= 70) return "bg-maestro-yellow";
  return "bg-maestro-red";
}

/**
 * Compact CPU + RAM readout for the footer. Mirrors the typography of
 * `UsageBar` (small muted text with a thin progress bar). Renders nothing
 * until the first metrics poll resolves.
 */
export function SystemMetrics() {
  const metrics = useSystemMetrics();

  if (!metrics) return null;

  const cpu = Number.isFinite(metrics.cpuPercent)
    ? Math.min(100, Math.max(0, metrics.cpuPercent))
    : 0;
  const mem = Number.isFinite(metrics.memPercent)
    ? Math.min(100, Math.max(0, metrics.memPercent))
    : 0;

  const ramTitle = `RAM: ${Math.round(mem)}% (${formatGiB(metrics.memUsedBytes)}/${formatGiB(
    metrics.memTotalBytes,
  )} GB)`;

  return (
    <div className="flex items-center gap-3" title={`CPU: ${Math.round(cpu)}%\n${ramTitle}`}>
      <Metric label="CPU" percent={cpu} detail={`${Math.round(cpu)}%`} />
      <Metric
        label="RAM"
        percent={mem}
        detail={`${formatGiB(metrics.memUsedBytes)}/${formatGiB(metrics.memTotalBytes)} GB`}
      />
    </div>
  );
}

function Metric({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  return (
    <div className="flex flex-col gap-1 w-24">
      <div className="flex items-baseline justify-between gap-1 text-[11px] leading-none">
        <span className="text-maestro-muted/70">{label}</span>
        <span className="text-maestro-muted/60">{detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-maestro-border/50">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor(percent)}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-[10px] leading-none text-maestro-muted/50 truncate"> </div>
    </div>
  );
}
