import { useMemo, useState } from 'react';
import type { BotDeployment } from '../types/lyrihost';

interface FleetSeriesPoint {
  ts: string;
  totalCpu: number;
  totalMemoryMb: number;
  avgLatencyMs: number;
  totalEventsPerMin: number;
}

interface RealtimeFleetChartProps {
  deployments: BotDeployment[];
  streamConnected: boolean;
  lastSyncTime: string;
}

function formatAxisTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour12: false,
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

export function RealtimeFleetChart({
  deployments,
  streamConnected,
  lastSyncTime,
}: RealtimeFleetChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [metricMode, setMetricMode] = useState<'throughput' | 'cpu' | 'ram' | 'latency'>('cpu');

  const series = useMemo<FleetSeriesPoint[]>(() => {
    const sampleCount = 28;
    const result: FleetSeriesPoint[] = [];

    for (let i = 0; i < sampleCount; i++) {
      let totalCpu = 0;
      let totalMemoryMb = 0;
      let latencySum = 0;
      let latencyCount = 0;
      let totalEventsPerMin = 0;
      let ts = '';

      for (const dep of deployments) {
        const hist = dep.telemetryHistory || [];
        const pt = hist[hist.length - sampleCount + i];
        if (pt) {
          if (!ts) ts = pt.ts;
          totalCpu += pt.cpuPercent;
          totalMemoryMb += pt.memoryMb;
          totalEventsPerMin += pt.eventsPerMin;
          if (pt.latencyMs > 0) {
            latencySum += pt.latencyMs;
            latencyCount += 1;
          }
        }
      }

      result.push({
        ts: ts || new Date().toISOString(),
        totalCpu: Number(totalCpu.toFixed(1)),
        totalMemoryMb,
        avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
        totalEventsPerMin,
      });
    }

    return result;
  }, [deployments]);

  const width = 620;
  const height = 160;
  const padX = 8;
  const padY = 14;

  const values = series.map((p) =>
    metricMode === 'throughput'
      ? p.totalEventsPerMin
      : metricMode === 'cpu'
        ? p.totalCpu
        : metricMode === 'ram'
          ? p.totalMemoryMb
          : p.avgLatencyMs
  );

  const maxVal = Math.max(
    metricMode === 'cpu' ? 10 : metricMode === 'ram' ? 128 : metricMode === 'latency' ? 60 : 120,
    ...values.map((v) => v * 1.25)
  );

  const coords = values.map((val, idx) => {
    const x = padX + (idx / Math.max(1, values.length - 1)) * (width - padX * 2);
    const y = height - padY - (val / maxVal) * (height - padY * 2);
    return { x, y, val };
  });

  const linePath = coords
    .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(' ');

  const areaPath =
    coords.length > 0
      ? `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(height - padY).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(height - padY).toFixed(1)} Z`
      : '';

  const activeIdx = hoverIdx !== null ? hoverIdx : series.length - 1;
  const activePoint = series[activeIdx];
  const activeCoord = coords[activeIdx];

  return (
    <div className="atelier-panel flex flex-col justify-between rounded-lg border border-red-950/90 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-950/70 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-lg font-semibold text-slate-100">
              Live Fleet Telemetry
            </h2>
            <span
              className={`inline-flex items-center gap-1.5 font-mono text-[10px] ${
                streamConnected ? 'text-emerald-400' : 'text-amber-300'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  streamConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                }`}
              />
              {streamConnected ? 'SSE LIVE · 1.5s' : 'POLLING'}
            </span>
          </div>
          <p className="text-[11px] text-slate-400">
            Last frame {lastSyncTime ? formatAxisTime(lastSyncTime) : 'syncing...'}
          </p>
        </div>

        <div className="flex items-center gap-0.5 rounded-md border border-red-950/80 bg-[#080305] p-0.5">
          {(
            [
              { id: 'cpu', label: 'CPU %' },
              { id: 'ram', label: 'RAM MB' },
              { id: 'throughput', label: 'Events/m' },
              { id: 'latency', label: 'Ping ms' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMetricMode(tab.id)}
              className={`rounded px-2 py-1 text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                metricMode === tab.id
                  ? 'bg-red-600/25 text-red-200 border border-red-500/40'
                  : 'text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Live Numeric Readout Row */}
      <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
        <div>
          <div className="text-[10px] text-slate-500">Throughput</div>
          <div className="font-mono text-xs font-semibold text-slate-100 tabular-nums">
            {activePoint?.totalEventsPerMin ?? 0} <span className="text-[10px] font-normal text-slate-400">ev/m</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500">Cluster CPU</div>
          <div className="font-mono text-xs font-semibold text-red-300 tabular-nums">
            {(activePoint?.totalCpu ?? 0).toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500">Gateway Ping</div>
          <div className="font-mono text-xs font-semibold text-rose-300 tabular-nums">
            {activePoint?.avgLatencyMs ?? 0} ms
          </div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500">Active RAM</div>
          <div className="font-mono text-xs font-semibold text-slate-200 tabular-nums">
            {activePoint?.totalMemoryMb ?? 0} MB
          </div>
        </div>
      </div>

      {/* Interactive SVG Waveform */}
      <div className="relative mt-2 w-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-36 w-full overflow-visible"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="lyriRedFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity="0.34" />
              <stop offset="100%" stopColor="#ef4444" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* Horizontal Gridlines */}
          {[0.25, 0.5, 0.75].map((ratio) => {
            const y = padY + ratio * (height - padY * 2);
            return (
              <line
                key={ratio}
                x1={padX}
                y1={y}
                x2={width - padX}
                y2={y}
                stroke="rgba(127, 29, 29, 0.35)"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
            );
          })}

          {areaPath && <path d={areaPath} fill="url(#lyriRedFill)" />}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke="#ef4444"
              strokeWidth="1.75"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* Crosshair & Active Node */}
          {activeCoord && (
            <>
              <line
                x1={activeCoord.x}
                y1={padY}
                x2={activeCoord.x}
                y2={height - padY}
                stroke="rgba(248, 113, 113, 0.35)"
                strokeWidth="1"
              />
              <circle
                cx={activeCoord.x}
                cy={activeCoord.y}
                r="3.2"
                fill="#ef4444"
                stroke="#080305"
                strokeWidth="1.5"
              />
            </>
          )}

          {/* Invisible hover columns for precise scrubbing */}
          {coords.map((c, idx) => (
            <rect
              key={idx}
              x={c.x - (width / Math.max(1, coords.length)) / 2}
              y={0}
              width={width / Math.max(1, coords.length)}
              height={height}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(idx)}
            />
          ))}
        </svg>

        <div className="flex items-center justify-between font-mono text-[10px] text-slate-500 tabular-nums">
          <span>{series[0] ? formatAxisTime(series[0].ts) : ''}</span>
          <span>{activePoint ? `@ ${formatAxisTime(activePoint.ts)}` : ''}</span>
          <span>{series[series.length - 1] ? formatAxisTime(series[series.length - 1].ts) : ''}</span>
        </div>
      </div>
    </div>
  );
}

export function MiniSparkline({ values, active }: { values: number[]; active: boolean }) {
  const width = 76;
  const height = 22;
  const sliced = values.slice(-16);
  const maxVal = Math.max(5, ...sliced);

  const pts = sliced.map((v, idx) => {
    const x = (idx / Math.max(1, sliced.length - 1)) * width;
    const y = height - 2 - (v / maxVal) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0">
      <polyline
        fill="none"
        stroke={active ? '#ef4444' : '#475569'}
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts.join(' ')}
      />
    </svg>
  );
}

export function BotCpuRamRealtimeChart({ deployment }: { deployment: BotDeployment }) {
  const history = (deployment.telemetryHistory || []).slice(-28);
  const width = 460;
  const height = 74;
  const padX = 4;
  const padY = 6;

  const cpuValues = history.map((h) => h.cpuPercent);
  const ramValues = history.map((h) => h.memoryMb);

  const maxCpu = Math.max(10, ...cpuValues.map((v) => v * 1.25));
  const maxRam = Math.max(deployment.memoryLimitMb || 256, ...ramValues.map((v) => v * 1.15));

  const buildPath = (vals: number[], maxV: number) =>
    vals
      .map((val, idx) => {
        const x = padX + (idx / Math.max(1, vals.length - 1)) * (width - padX * 2);
        const y = height - padY - (val / maxV) * (height - padY * 2);
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');

  const cpuPath = history.length > 1 ? buildPath(cpuValues, maxCpu) : '';
  const ramPath = history.length > 1 ? buildPath(ramValues, maxRam) : '';

  return (
    <div className="rounded-lg border border-red-950/80 bg-[#0a0406] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] mb-1.5">
        <span className="font-semibold text-slate-200">
          Realtime CPU &amp; RAM Consumption
        </span>
        <div className="flex items-center gap-3 font-mono text-[10px] tabular-nums">
          <span className="inline-flex items-center gap-1 text-red-300">
            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
            CPU {deployment.cpuPercent.toFixed(1)}%
          </span>
          <span className="inline-flex items-center gap-1 text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            RAM {deployment.memoryMb} MB / {deployment.memoryLimitMb} MB
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="h-16 w-full overflow-visible">
        <line
          x1={padX}
          y1={height / 2}
          x2={width - padX}
          y2={height / 2}
          stroke="rgba(127,29,29,0.3)"
          strokeDasharray="3 3"
          strokeWidth="1"
        />
        {ramPath && (
          <path
            d={ramPath}
            fill="none"
            stroke="#34d399"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {cpuPath && (
          <path
            d={cpuPath}
            fill="none"
            stroke="#f87171"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
      </svg>
    </div>
  );
}
