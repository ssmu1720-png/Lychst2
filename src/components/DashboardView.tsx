import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Coins,
  Cpu,
  Flame,
  GitBranch,
  Globe,
  HeartPulse,
  Layers,
  LayoutGrid,
  List,
  MessageSquare,
  Play,
  Plus,
  Radio,
  RotateCw,
  Search,
  ShieldAlert,
  Square,
  Zap,
} from 'lucide-react';
import { MiniSparkline, RealtimeFleetChart } from './RealtimeTelemetryCharts';
import {
  DEPLOYMENT_PLANS,
  type AuthUser,
  type BotDeployment,
  type DeploymentPlanId,
  type DeploymentStatus,
} from '../types/lyrihost';

interface DashboardViewProps {
  deployments: BotDeployment[];
  currentUser: AuthUser;
  loading: boolean;
  streamConnected: boolean;
  lastSyncTime: string;
  railwayDomain?: string;
  onSelectBot: (botId: string, tab?: 'logs' | 'settings' | 'networking' | 'security') => void;
  onOpenDomains: () => void;
  onOpenCustomDeploy: () => void;
  onOpenTemplates: () => void;
  onOpenCoins: () => void;
  onOpenSupport: () => void;
  onClaimStreak: () => Promise<void>;
  onRenewBot: (botId: string, planId: DeploymentPlanId) => Promise<void>;
  onBotAction: (botId: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
}

interface BotHealthSummary {
  score: number | null;
  label: 'Healthy' | 'Degraded' | 'Critical' | 'Deploying' | 'Offline';
  tone: 'emerald' | 'amber' | 'red' | 'slate';
  memPct: number;
  latencyMs: number;
  uptimePct: number;
}

function computeBotHealthSummary(dep: BotDeployment): BotHealthSummary {
  const memLimit = Math.max(1, dep.memoryLimitMb || 512);
  const memPct = Math.min(100, Math.round((dep.memoryMb / memLimit) * 100));
  const latencyMs = dep.gatewayLatencyMs || 0;
  const totalChecks = dep.totalChecks ?? 0;
  const onlineChecks = dep.onlineChecks ?? 0;
  const uptimePct =
    typeof dep.uptimePercentage === 'number' && (dep.uptimePercentage > 0 || totalChecks > 0)
      ? dep.uptimePercentage
      : totalChecks > 0
        ? Math.round((onlineChecks / totalChecks) * 1000) / 10
        : dep.status === 'online'
          ? 100
          : 0;

  if (dep.status === 'building' || dep.status === 'scanning') {
    return {
      score: null,
      label: 'Deploying',
      tone: 'amber',
      memPct,
      latencyMs,
      uptimePct,
    };
  }

  if (dep.status === 'failed') {
    return {
      score: 0,
      label: 'Critical',
      tone: 'red',
      memPct,
      latencyMs,
      uptimePct,
    };
  }

  if (dep.status !== 'online') {
    return {
      score: 0,
      label: 'Offline',
      tone: 'slate',
      memPct,
      latencyMs,
      uptimePct,
    };
  }

  let score = typeof dep.healthScore === 'number' && dep.healthScore > 0 ? dep.healthScore : 0;
  if (score === 0) {
    const latencyScore =
      latencyMs <= 40
        ? 100
        : latencyMs <= 350
          ? Math.round(100 - ((latencyMs - 40) / 310) * 80)
          : Math.max(0, Math.round(20 - (latencyMs - 350) / 25));
    const memRatio = dep.memoryMb / memLimit;
    const memoryScore =
      memRatio <= 0.65
        ? 100
        : memRatio <= 1
          ? Math.round(100 - ((memRatio - 0.65) / 0.35) * 85)
          : Math.max(0, Math.round(15 - (memRatio - 1) * 50));
    score = Math.max(
      0,
      Math.min(100, Math.round(latencyScore * 0.35 + memoryScore * 0.35 + uptimePct * 0.3))
    );
  }

  if (score >= 85) {
    return { score, label: 'Healthy', tone: 'emerald', memPct, latencyMs, uptimePct };
  }
  if (score >= 60) {
    return { score, label: 'Degraded', tone: 'amber', memPct, latencyMs, uptimePct };
  }
  return { score, label: 'Critical', tone: 'red', memPct, latencyMs, uptimePct };
}

function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatExpiryLabel(dep: BotDeployment): { label: string; expired: boolean } {
  if (dep.planId === 'plan_unlimited' || !dep.expiresAt) {
    return { label: 'Unlimited', expired: false };
  }
  const ms = Date.parse(dep.expiresAt) - Date.now();
  if (ms <= 0) {
    return { label: 'Expired', expired: true };
  }
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return { label: `${days}d ${hours}h left`, expired: false };
  return { label: `${Math.max(1, hours)}h left`, expired: false };
}

function StatusBadge({ status }: { status: DeploymentStatus }) {
  if (status === 'online') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
        <Activity className="h-3 w-3 text-emerald-400" />
        Online
      </span>
    );
  }
  if (status === 'building' || status === 'scanning') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
        <RotateCw className="h-3 w-3 animate-spin text-amber-400" />
        {status === 'scanning' ? 'Scanning' : 'Deploying'}
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-red-400">
        <AlertTriangle className="h-3 w-3 text-red-400" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
      <Square className="h-2.5 w-2.5 text-slate-500" />
      Stopped
    </span>
  );
}

function BotHealthIndicator({
  dep,
  streamConnected,
  compact = false,
}: {
  dep: BotDeployment;
  streamConnected: boolean;
  compact?: boolean;
}) {
  const health = computeBotHealthSummary(dep);
  const isOnline = dep.status === 'online';

  const toneText =
    health.tone === 'emerald'
      ? 'text-emerald-400'
      : health.tone === 'amber'
        ? 'text-amber-300'
        : health.tone === 'red'
          ? 'text-red-400'
          : 'text-slate-400';

  const toneBar =
    health.tone === 'emerald'
      ? 'bg-emerald-400'
      : health.tone === 'amber'
        ? 'bg-amber-400'
        : health.tone === 'red'
          ? 'bg-red-500'
          : 'bg-slate-600';

  const toneDot =
    health.tone === 'emerald'
      ? 'bg-emerald-400'
      : health.tone === 'amber'
        ? 'bg-amber-400'
        : health.tone === 'red'
          ? 'bg-red-500'
          : 'bg-slate-500';

  const barWidth = health.score !== null ? `${Math.max(4, health.score)}%` : '35%';

  if (compact) {
    return (
      <div className="min-w-[148px]">
        <div className="flex items-center justify-between gap-2">
          <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${toneText}`}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${toneDot} ${
                isOnline && streamConnected ? 'animate-pulse' : ''
              }`}
            />
            <span>{health.label}</span>
          </span>
          <span className={`font-mono text-[11px] font-semibold tabular-nums ${toneText}`}>
            {health.score !== null ? `${health.score}/100` : '—'}
          </span>
        </div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-red-950/80">
          <div
            className={`h-full rounded-full transition-all duration-300 ${toneBar}`}
            style={{ width: barWidth }}
          />
        </div>
        <div className="mt-1 font-mono text-[10px] text-slate-400 tabular-nums">
          {isOnline ? `${health.latencyMs}ms` : '—'} · {health.memPct}% RAM · {health.uptimePct.toFixed(1)}% up
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-red-950/60 pt-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-1.5">
          <HeartPulse className={`h-3.5 w-3.5 ${toneText}`} />
          <span className="text-slate-400">Health Score</span>
          <span className={`inline-flex items-center gap-1 font-medium ${toneText}`}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${toneDot} ${
                isOnline && streamConnected ? 'animate-pulse' : ''
              }`}
            />
            {health.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5 font-mono font-semibold tabular-nums">
          {health.tone === 'emerald' && isOnline && (
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          )}
          <span className={toneText}>
            {health.score !== null ? `${health.score}` : '—'}
            {health.score !== null && <span className="text-[10px] text-slate-500">/100</span>}
          </span>
        </div>
      </div>

      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-red-950/80">
        <div
          className={`h-full rounded-full transition-all duration-300 ${toneBar}`}
          style={{ width: barWidth }}
        />
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2 font-mono text-[10px] tabular-nums">
        <div>
          <span className="block text-slate-500">LATENCY</span>
          <span className="text-rose-300">
            {isOnline && health.latencyMs > 0 ? `${health.latencyMs} ms` : '—'}
          </span>
        </div>
        <div>
          <span className="block text-slate-500">MEMORY</span>
          <span className="text-slate-200">
            {dep.memoryMb} MB <span className="text-slate-500">({health.memPct}%)</span>
          </span>
        </div>
        <div className="text-right">
          <span className="block text-slate-500">UPTIME %</span>
          <span className="text-slate-200">{health.uptimePct.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}

export function DashboardView({
  deployments,
  currentUser,
  loading,
  streamConnected,
  lastSyncTime,
  railwayDomain,
  onSelectBot,
  onOpenDomains,
  onOpenCustomDeploy,
  onOpenTemplates,
  onOpenCoins,
  onOpenSupport,
  onClaimStreak,
  onRenewBot,
  onBotAction,
}: DashboardViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | DeploymentStatus>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [claimingStreak, setClaimingStreak] = useState(false);
  const [renewMenuId, setRenewMenuId] = useState<string | null>(null);
  const [renewBusyId, setRenewBusyId] = useState<string | null>(null);
  const [renewFeedback, setRenewFeedback] = useState<string | null>(null);

  const metrics = useMemo(() => {
    const onlineBots = deployments.filter((d) => d.status === 'online');
    const totalMemoryAllocated = deployments.reduce((acc, d) => acc + d.memoryLimitMb, 0);
    const totalMemoryUsed = deployments.reduce((acc, d) => acc + d.memoryMb, 0);
    const totalEvents = onlineBots.reduce((acc, d) => acc + (d.eventsPerMin || 0), 0);
    const totalNet = onlineBots.reduce((acc, d) => acc + (d.networkKbps || 0), 0);
    const avgLatency = onlineBots.length
      ? Math.round(onlineBots.reduce((acc, d) => acc + (d.gatewayLatencyMs || 0), 0) / onlineBots.length)
      : 0;
    const securityAlerts = deployments.reduce((acc, d) => {
      const crits = d.scanReport?.securityFindings.filter((f) => f.severity === 'critical').length ?? 0;
      return acc + crits;
    }, 0);

    return {
      total: deployments.length,
      online: onlineBots.length,
      totalMemoryAllocated,
      totalMemoryUsed,
      totalEvents,
      totalNet: Number(totalNet.toFixed(1)),
      avgLatency,
      securityAlerts,
    };
  }, [deployments]);

  const filteredDeployments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return deployments.filter((dep) => {
      const matchesStatus = statusFilter === 'all' || dep.status === statusFilter;
      const matchesQuery =
        !q ||
        dep.name.toLowerCase().includes(q) ||
        dep.repoFullName.toLowerCase().includes(q) ||
        dep.framework.toLowerCase().includes(q) ||
        dep.settings.region.toLowerCase().includes(q);
      return matchesStatus && matchesQuery;
    });
  }, [deployments, searchQuery, statusFilter]);

  const handleAction = async (
    e: React.MouseEvent,
    botId: string,
    action: 'start' | 'stop' | 'restart'
  ) => {
    e.stopPropagation();
    setBusyId(botId);
    try {
      await onBotAction(botId, action);
    } finally {
      setBusyId(null);
    }
  };

  const handleStreakClick = async () => {
    setClaimingStreak(true);
    try {
      await onClaimStreak();
    } finally {
      setClaimingStreak(false);
    }
  };

  const handlePlanRenew = async (
    e: React.MouseEvent,
    botId: string,
    planId: DeploymentPlanId
  ) => {
    e.stopPropagation();
    setRenewFeedback(null);
    setRenewBusyId(botId);
    try {
      await onRenewBot(botId, planId);
      setRenewMenuId(null);
    } catch (err) {
      setRenewFeedback(err instanceof Error ? err.message : 'Unable to renew plan.');
    } finally {
      setRenewBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Wallet, Daily Streak & Quick Shortcuts Strip */}
      <section className="atelier-panel flex flex-col gap-3 rounded-lg border border-red-500/25 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-red-400" />
            <span className="text-slate-400">Balance:</span>
            <span className="font-mono font-semibold text-rose-200 tabular-nums">
              {currentUser.unlimitedCoins ? 'Unlimited' : `${currentUser.coinBalance} Coins`}
            </span>
            {!currentUser.unlimitedCoins && (
              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                ({currentUser.coinBalance} KSH)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-amber-400" />
            <span className="text-slate-400">Daily Streak:</span>
            <span className="font-mono font-semibold text-amber-300 tabular-nums">
              Day {currentUser.streakCount}
            </span>
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
            <span className="text-slate-400">Quota:</span>
            <span className="text-slate-200">
              {currentUser.activeDeploymentsCount}/{currentUser.isAdmin ? '∞' : currentUser.maxDeployments}
            </span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span className="text-slate-400">Ref:</span>
            <span className="text-emerald-400">{currentUser.referralCode}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={!currentUser.canClaimDailyStreak || claimingStreak}
            onClick={() => void handleStreakClick()}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
              currentUser.canClaimDailyStreak
                ? 'border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                : 'border-red-950/90 bg-[#080305] text-slate-400 cursor-default'
            }`}
          >
            <Flame className="h-3.5 w-3.5 text-amber-400" />
            {claimingStreak
              ? 'Claiming...'
              : currentUser.canClaimDailyStreak
                ? 'Claim +1 Daily Coin'
                : 'Streak Claimed Today'}
          </button>

          <button
            type="button"
            onClick={onOpenCoins}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-rose-200 transition-colors hover:bg-red-500/20 whitespace-nowrap shrink-0"
          >
            <Coins className="h-3.5 w-3.5 text-red-400" />
            Buy / Transfer Coins
          </button>

          <button
            type="button"
            onClick={onOpenDomains}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-red-500/40 hover:text-slate-100 whitespace-nowrap shrink-0"
          >
            <Globe className="h-3.5 w-3.5 text-emerald-400" />
            Domains
          </button>

          <button
            type="button"
            onClick={onOpenSupport}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-red-500/40 hover:text-slate-100 whitespace-nowrap shrink-0"
          >
            <MessageSquare className="h-3.5 w-3.5 text-rose-400" />
            Support
          </button>
        </div>
      </section>

      {renewFeedback && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-red-500/45 bg-red-500/15 px-3.5 py-2.5 text-xs text-red-200">
          <span>{renewFeedback}</span>
          <button
            type="button"
            onClick={() => setRenewFeedback(null)}
            className="text-[11px] underline hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Live Interactive Fleet Telemetry Waveform */}
      <section>
        <RealtimeFleetChart
          deployments={deployments}
          streamConnected={streamConnected}
          lastSyncTime={lastSyncTime}
        />
      </section>

      {/* Unified 5-Column Hairline Live Telemetry Ribbon */}
      <section className="atelier-panel grid grid-cols-2 divide-y divide-red-950/80 rounded-lg border border-red-950/90 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x lg:divide-y-0">
        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <div className="text-[10px] text-slate-400">Active Nodes</div>
            <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
              {metrics.online} <span className="text-[11px] font-normal text-slate-500">/ {metrics.total}</span>
            </div>
          </div>
          <Bot className="h-4 w-4 text-red-400/80" />
        </div>

        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <div className="text-[10px] text-slate-400">Gateway Throughput</div>
            <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
              {metrics.totalEvents} <span className="text-[11px] font-normal text-slate-500">ev/min</span>
            </div>
          </div>
          <Zap className="h-4 w-4 text-rose-400/80" />
        </div>

        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <div className="text-[10px] text-slate-400">Network I/O</div>
            <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
              {metrics.totalNet} <span className="text-[11px] font-normal text-slate-500">KB/s</span>
            </div>
          </div>
          <Radio className="h-4 w-4 text-red-400/80" />
        </div>

        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <div className="text-[10px] text-slate-400">Memory Allocated</div>
            <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
              {metrics.totalMemoryUsed} <span className="text-[11px] font-normal text-slate-500">/ {metrics.totalMemoryAllocated} MB</span>
            </div>
          </div>
          <Cpu className="h-4 w-4 text-rose-400/80" />
        </div>

        <div className="col-span-2 flex items-center justify-between px-4 py-3 sm:col-span-1">
          <div>
            <div className="text-[10px] text-slate-400">Security Alerts</div>
            <div
              className={`mt-0.5 font-mono text-base font-semibold tabular-nums ${
                metrics.securityAlerts > 0 ? 'text-red-400' : 'text-emerald-400'
              }`}
            >
              {metrics.securityAlerts}{' '}
              <span className="text-[11px] font-normal text-slate-500">
                {metrics.securityAlerts > 0 ? 'critical' : `· ${metrics.avgLatency}ms avg`}
              </span>
            </div>
          </div>
          <ShieldAlert
            className={`h-4 w-4 ${metrics.securityAlerts > 0 ? 'text-red-400' : 'text-emerald-400'}`}
          />
        </div>
      </section>

      {/* Deployed Bots (8) + Cluster Topology (4) */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start">
        <div className="space-y-3 lg:col-span-8">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-display text-xl font-semibold text-slate-50">
                Deployed Bots
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-48">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter registry..."
                  className="w-full rounded-md border border-red-950/90 bg-[#0d0508] py-1.5 pl-8 pr-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-red-400 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-0.5 rounded-md border border-red-950/80 bg-[#0d0508] p-0.5">
                {(['all', 'online', 'building', 'stopped'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setStatusFilter(tab)}
                    className={`rounded px-2.5 py-1 text-[11px] font-medium capitalize transition-colors whitespace-nowrap shrink-0 ${
                      statusFilter === tab
                        ? 'bg-red-600/25 text-red-200 border border-red-500/35'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-0.5 rounded-md border border-red-950/80 bg-[#0d0508] p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  title="Grid view"
                  className={`rounded p-1 transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-red-600/25 text-red-200'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('table')}
                  title="Table view"
                  className={`rounded p-1 transition-colors ${
                    viewMode === 'table'
                      ? 'bg-red-600/25 text-red-200'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <List className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[1, 2].map((idx) => (
                <div
                  key={idx}
                  className="h-44 animate-pulse rounded-lg border border-red-950/70 bg-[#12070a]/90"
                />
              ))}
            </div>
          ) : filteredDeployments.length === 0 ? (
            <div className="atelier-panel flex flex-col items-center justify-center rounded-lg border border-red-950/80 px-6 py-12 text-center">
              <Bot className="h-8 w-8 text-red-400/75" />
              <h3 className="mt-2.5 font-display text-lg font-semibold text-slate-100">
                {deployments.length === 0 ? 'No bots deployed yet' : 'No matching bot deployments'}
              </h3>
              <p className="mt-1 max-w-sm text-xs text-slate-400">
                {deployments.length === 0
                  ? 'Deploy a curated WhatsApp template bot or launch your own custom Git repository.'
                  : 'Try adjusting your search query or status filter.'}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  onClick={onOpenTemplates}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-500 whitespace-nowrap shrink-0"
                >
                  <Layers className="h-3.5 w-3.5" />
                  Browse Bot Templates
                </button>
                <button
                  type="button"
                  onClick={onOpenCustomDeploy}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3.5 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/20 whitespace-nowrap shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Deploy Custom Repo
                </button>
              </div>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {filteredDeployments.map((dep) => {
                const isBusy = busyId === dep.id;
                const critFindings =
                  dep.scanReport?.securityFindings.filter((f) => f.severity === 'critical').length ?? 0;
                const cpuSeries = (dep.telemetryHistory || []).map((t) => t.cpuPercent);

                return (
                  <article
                    key={dep.id}
                    onClick={() => onSelectBot(dep.id)}
                    className="atelier-panel group cursor-pointer rounded-lg border border-red-950/90 p-4 transition-colors hover:border-red-500/50"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="truncate font-display text-lg font-semibold text-slate-100 group-hover:text-red-300 transition-colors">
                            {dep.name}
                          </h3>
                          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-slate-500 opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-red-400" />
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                          <span>{dep.framework}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{dep.settings.region}</span>
                        </div>
                      </div>
                      <StatusBadge status={dep.status} />
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-2">
                      <div className="min-w-0 space-y-0.5 text-[11px]">
                        <div className="truncate font-mono text-rose-300/90">{dep.repoFullName}</div>
                        <div className="flex items-center gap-1.5 text-slate-400">
                          <GitBranch className="h-3 w-3 text-slate-500" />
                          <span className="font-mono">{dep.settings.branch}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">{dep.commitSha}</span>
                        </div>
                      </div>
                      <MiniSparkline values={cpuSeries} active={dep.status === 'online'} />
                    </div>

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] tabular-nums">
                      <span className="text-slate-400">
                        Plan:{' '}
                        <span className="text-emerald-400">{dep.memoryLimitMb} MB RAM</span>
                      </span>
                      {(() => {
                        const exp = formatExpiryLabel(dep);
                        return (
                          <span className={exp.expired ? 'text-red-400 font-semibold' : 'text-slate-400'}>
                            {exp.label}
                          </span>
                        );
                      })()}
                    </div>

                    <BotHealthIndicator dep={dep} streamConnected={streamConnected} />

                    {renewMenuId === dep.id && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="mt-2.5 rounded border border-red-500/40 bg-[#080305] p-2.5 space-y-2"
                      >
                        <div className="flex items-center justify-between text-[11px] font-medium text-slate-200">
                          <span>Renew / Upgrade Plan</span>
                          <button
                            type="button"
                            onClick={() => setRenewMenuId(null)}
                            className="text-[10px] text-slate-400 hover:text-white"
                          >
                            Close
                          </button>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          {DEPLOYMENT_PLANS.map((plan) => (
                            <button
                              key={plan.id}
                              type="button"
                              disabled={renewBusyId === dep.id}
                              onClick={(e) => void handlePlanRenew(e, dep.id, plan.id)}
                              className="rounded border border-red-950/90 bg-[#12070a] px-2 py-1.5 text-left text-[10px] hover:border-red-500/50 disabled:opacity-50"
                            >
                              <div className="font-semibold text-rose-300">{plan.coinCost}c</div>
                              <div className="text-slate-300">{plan.durationLabel}</div>
                              <div className="font-mono text-emerald-400">{plan.memoryLimitMb}MB</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-2.5 flex items-center justify-between border-t border-red-950/70 pt-2.5 text-[11px]">
                      <div className="font-mono text-slate-400 tabular-nums">
                        <span>Up {formatUptime(dep.uptimeSeconds)}</span>
                        {critFindings > 0 && (
                          <>
                            <span className="mx-1.5 text-slate-600">·</span>
                            <span className="text-red-400">{critFindings} alert{critFindings > 1 ? 's' : ''}</span>
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {(dep.settings.runtime === 'node-20' ||
                          dep.settings.runtime === 'node-22' ||
                          dep.settings.runtime === 'bun-1') && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectBot(dep.id, 'networking');
                            }}
                            title={
                              dep.customDomain
                                ? `Change custom domain (${dep.customDomain})`
                                : 'Add or change custom domain'
                            }
                            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors ${
                              dep.customDomain
                                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                                : 'border-red-950/90 bg-[#080305] text-slate-300 hover:border-red-500/45'
                            }`}
                          >
                            {dep.customDomain ? dep.customDomain : 'Domain'}
                          </button>
                        )}
                        {dep.status === 'online' &&
                          dep.publicAppEnabled !== false &&
                          dep.appSlug &&
                          (dep.settings.runtime === 'node-20' ||
                            dep.settings.runtime === 'node-22' ||
                            dep.settings.runtime === 'bun-1') && (
                            <a
                              href={
                                dep.customDomain
                                  ? `https://${dep.customDomain}/`
                                  : railwayDomain
                                    ? `https://${railwayDomain}/app/${dep.appSlug}/`
                                    : `/app/${dep.appSlug}/`
                              }
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title="Open Node App / Web Endpoint"
                              className="rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
                            >
                              Open
                            </a>
                          )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenewMenuId((prev) => (prev === dep.id ? null : dep.id));
                          }}
                          title="Renew or Upgrade Plan"
                          className="rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-200 transition-colors hover:bg-amber-500/20"
                        >
                          Plan
                        </button>
                        {dep.status === 'online' ? (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={(e) => handleAction(e, dep.id, 'stop')}
                            title="Stop Bot"
                            className="rounded border border-red-500/40 bg-red-500/15 p-1 text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-50"
                          >
                            <Square className="h-3 w-3" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isBusy || dep.status === 'building'}
                            onClick={(e) => handleAction(e, dep.id, 'start')}
                            title="Start Bot"
                            className="rounded border border-emerald-500/35 bg-emerald-500/10 p-1 text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                          >
                            <Play className="h-3 w-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={(e) => handleAction(e, dep.id, 'restart')}
                          title="Restart / Redeploy"
                          className="rounded border border-rose-500/30 bg-rose-500/10 p-1 text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
                        >
                          <RotateCw className={`h-3 w-3 ${isBusy ? 'animate-spin' : ''}`} />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="atelier-panel overflow-x-auto rounded-lg border border-red-950/90">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-red-950/70 text-[11px] font-medium text-slate-400">
                    <th className="py-2.5 pl-4 pr-2">Service</th>
                    <th className="px-2 py-2.5">Status</th>
                    <th className="px-2 py-2.5">Health Score</th>
                    <th className="px-2 py-2.5 text-right">Memory</th>
                    <th className="px-2 py-2.5 text-right">Latency</th>
                    <th className="px-2 py-2.5 text-right">Uptime</th>
                    <th className="py-2.5 pl-2 pr-4 text-right">Controls</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-950/50">
                  {filteredDeployments.map((dep) => {
                    const isBusy = busyId === dep.id;
                    const health = computeBotHealthSummary(dep);
                    return (
                      <tr
                        key={dep.id}
                        onClick={() => onSelectBot(dep.id)}
                        className="cursor-pointer transition-colors hover:bg-red-500/[0.06]"
                      >
                        <td className="py-2.5 pl-4 pr-2">
                          <div className="font-medium text-slate-100">{dep.name}</div>
                          <div className="font-mono text-[10px] text-rose-300/90">
                            {dep.repoFullName} · {dep.settings.branch}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <StatusBadge status={dep.status} />
                        </td>
                        <td className="px-2 py-2.5">
                          <BotHealthIndicator dep={dep} streamConnected={streamConnected} compact />
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-[11px] text-slate-300 tabular-nums">
                          <div>{dep.memoryMb}/{dep.memoryLimitMb} MB</div>
                          <div className="text-[10px] text-slate-500">{health.memPct}% used</div>
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-[11px] text-rose-300 tabular-nums">
                          {dep.status === 'online' && health.latencyMs > 0 ? `${health.latencyMs} ms` : '—'}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-[11px] text-slate-300 tabular-nums">
                          <div>{health.uptimePct.toFixed(1)}%</div>
                          <div className="text-[10px] text-slate-500">{formatUptime(dep.uptimeSeconds)}</div>
                        </td>
                        <td className="py-2.5 pl-2 pr-4 text-right">
                          <div className="inline-flex items-center gap-1">
                            {dep.status === 'online' ? (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={(e) => handleAction(e, dep.id, 'stop')}
                                title="Stop Bot"
                                className="rounded border border-red-500/40 bg-red-500/15 p-1 text-red-300 hover:bg-red-500/25 disabled:opacity-50"
                              >
                                <Square className="h-3 w-3" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={isBusy || dep.status === 'building'}
                                onClick={(e) => handleAction(e, dep.id, 'start')}
                                title="Start Bot"
                                className="rounded border border-emerald-500/35 bg-emerald-500/10 p-1 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                              >
                                <Play className="h-3 w-3" />
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={(e) => handleAction(e, dep.id, 'restart')}
                              title="Redeploy"
                              className="rounded border border-rose-500/30 bg-rose-500/10 p-1 text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                            >
                              <RotateCw className={`h-3 w-3 ${isBusy ? 'animate-spin' : ''}`} />
                            </button>
                            <ChevronRight className="ml-0.5 h-3.5 w-3.5 text-slate-500" />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right 4 Cols: Pipeline Readiness */}
        <aside className="space-y-4 lg:col-span-4">
          <div className="atelier-panel rounded-lg border border-red-950/90 p-4">
            <div className="flex items-center justify-between border-b border-red-950/70 pb-2.5">
              <h3 className="font-display text-base font-semibold text-slate-100">
                Pipeline Readiness
              </h3>
              <button
                type="button"
                onClick={onOpenTemplates}
                className="inline-flex items-center gap-1 rounded border border-red-500/35 bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-200 transition-colors hover:bg-red-500/20 whitespace-nowrap shrink-0"
              >
                <Plus className="h-3 w-3" />
                Deploy Bot
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2.5 font-mono text-[11px] tabular-nums">
              <div className="rounded border border-red-950/70 bg-[#0a0406] px-3 py-2">
                <span className="block text-[10px] text-slate-500">SSE Stream</span>
                <span className={streamConnected ? 'text-emerald-400' : 'text-amber-300'}>
                  {streamConnected ? 'Synchronized' : 'Reconnecting'}
                </span>
              </div>
              <div className="rounded border border-red-950/70 bg-[#0a0406] px-3 py-2">
                <span className="block text-[10px] text-slate-500">Active Fleet</span>
                <span className="text-slate-200">
                  {metrics.online}/{metrics.total} workers
                </span>
              </div>
              <div className="rounded border border-red-950/70 bg-[#0a0406] px-3 py-2">
                <span className="block text-[10px] text-slate-500">Avg Ping</span>
                <span className="text-rose-300">
                  {metrics.avgLatency > 0 ? `${metrics.avgLatency} ms` : '—'}
                </span>
              </div>
              <div className="rounded border border-red-950/70 bg-[#0a0406] px-3 py-2">
                <span className="block text-[10px] text-slate-500">Last Tick</span>
                <span className="truncate block text-slate-300">
                  {lastSyncTime ? new Date(lastSyncTime).toLocaleTimeString([], { hour12: false }) : '—'}
                </span>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}
