import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  Globe,
  Link2,
  Play,
  Rocket,
  RotateCw,
  Save,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import { EnvVarsEditor } from './EnvVarsEditor';
import { BotCpuRamRealtimeChart } from './RealtimeTelemetryCharts';
import {
  DEPLOY_REGIONS,
  type BotDeployment,
  type BotSettings,
  type ComputeTier,
  type DeployRegion,
  type DeploymentNetworkingInfo,
  type LogEntry,
  type RestartPolicy,
  type RuntimeEnvironment,
} from '../types/lyrihost';

interface BotInspectorViewProps {
  authToken: string;
  deployment: BotDeployment;
  initialTab?: 'logs' | 'settings' | 'networking' | 'security';
  onBack: () => void;
  onUpdated: (updated: BotDeployment) => void;
  onDeleted: (deletedId: string) => void;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function BotInspectorView({
  authToken,
  deployment,
  initialTab = 'logs',
  onBack,
  onUpdated,
  onDeleted,
}: BotInspectorViewProps) {
  const [activeTab, setActiveTab] = useState<'logs' | 'settings' | 'networking' | 'security'>(initialTab);
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, deployment.id]);
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | LogEntry['level']>('all');
  const [logSearch, setLogSearch] = useState('');
  const [copiedLogs, setCopiedLogs] = useState(false);

  const [actionBusy, setActionBusy] = useState(false);
  const [rescanBusy, setRescanBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const isNodeDeployment =
    deployment.settings.runtime === 'node-20' ||
    deployment.settings.runtime === 'node-22' ||
    deployment.settings.runtime === 'bun-1';

  const [networking, setNetworking] = useState<DeploymentNetworkingInfo | null>(null);
  const [domainInput, setDomainInput] = useState(deployment.customDomain || '');
  const [slugInput, setSlugInput] = useState(deployment.appSlug || '');
  const [domainBusy, setDomainBusy] = useState(false);
  const [inlineDomainOpen, setInlineDomainOpen] = useState(false);
  const [inlineLinkOpen, setInlineLinkOpen] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [dnsCheckResult, setDnsCheckResult] = useState<{ verified: boolean; message: string } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [uptimeProbeResult, setUptimeProbeResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [draftSettings, setDraftSettings] = useState<BotSettings>(deployment.settings);

  // Keep draft settings synchronized when switching bots
  useEffect(() => {
    setDraftSettings(deployment.settings);
    setDomainInput(deployment.customDomain || '');
    setSlugInput(deployment.appSlug || '');
    setDnsCheckResult(null);
    setUptimeProbeResult(null);
    setConfirmDelete(false);
    setFeedback(null);
  }, [deployment.id]);

  useEffect(() => {
    if (!isNodeDeployment) {
      setNetworking(null);
      if (activeTab === 'networking') setActiveTab('logs');
      return;
    }
    let active = true;
    const loadNetworking = async () => {
      try {
        const resp = await fetch(`/api/deployments/${deployment.id}/networking`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as DeploymentNetworkingInfo;
        if (active) {
          setNetworking(data);
          if (data.appSlug) {
            setSlugInput((prev) => prev || data.appSlug);
          }
        }
      } catch {
        // ignore transient fetch failure
      }
    };
    void loadNetworking();
    return () => {
      active = false;
    };
  }, [deployment.id, deployment.customDomain, deployment.publicAppEnabled, deployment.appSlug, isNodeDeployment, authToken, activeTab]);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return deployment.logs.filter((entry) => {
      const matchesLevel = logLevelFilter === 'all' || entry.level === logLevelFilter;
      const matchesText =
        !q ||
        entry.message.toLowerCase().includes(q) ||
        entry.stage.toLowerCase().includes(q);
      return matchesLevel && matchesText;
    });
  }, [deployment.logs, logLevelFilter, logSearch]);

  const runAction = async (action: 'start' | 'stop' | 'restart' | 'redeploy') => {
    setActionBusy(true);
    setFeedback(null);
    try {
      const resp = await fetch(`/api/deployments/${deployment.id}/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ action }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Action failed.');
      onUpdated(data as BotDeployment);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to execute action.',
      });
    } finally {
      setActionBusy(false);
    }
  };

  const handleSaveSettings = async (redeploy: boolean) => {
    setSaveBusy(true);
    setFeedback(null);
    try {
      const resp = await fetch(`/api/deployments/${deployment.id}/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ settings: draftSettings, redeploy }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to save settings.');
      onUpdated(data as BotDeployment);
      setFeedback({
        type: 'success',
        text: redeploy
          ? 'Settings saved and new deployment pipeline triggered.'
          : 'Configuration saved.',
      });
      if (redeploy) setActiveTab('logs');
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save settings.',
      });
    } finally {
      setSaveBusy(false);
    }
  };

  const handleRescan = async () => {
    setRescanBusy(true);
    setFeedback(null);
    try {
      const resp = await fetch(`/api/deployments/${deployment.id}/rescan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'GitHub rescan failed.');
      onUpdated(data as BotDeployment);
      setFeedback({
        type: 'success',
        text: 'Completed fresh GitHub repository inspection.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to rescan repository.',
      });
    } finally {
      setRescanBusy(false);
    }
  };

  const handleDelete = async () => {
    setActionBusy(true);
    try {
      const resp = await fetch(`/api/deployments/${deployment.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!resp.ok) throw new Error('Failed to delete deployment.');
      onDeleted(deployment.id);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to delete bot.',
      });
      setActionBusy(false);
    }
  };

  const copyAllLogs = async () => {
    const text = deployment.logs
      .map((l) => `[${formatTime(l.timestamp)}] [${l.stage.toUpperCase()}] ${l.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLogs(true);
      setTimeout(() => setCopiedLogs(false), 1800);
    } catch {
      // ignore clipboard restrictions
    }
  };

  const copyLinkValue = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(key);
      setTimeout(() => setCopiedField(null), 1800);
    } catch {
      // ignore clipboard restrictions
    }
  };

  const handleDomainSave = async (opts: {
    customDomain?: string | null;
    publicAppEnabled?: boolean;
    appSlug?: string | null;
  }) => {
    setDomainBusy(true);
    setFeedback(null);
    setDnsCheckResult(null);
    try {
      const resp = await fetch(`/api/deployments/${deployment.id}/domain`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(opts),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to update link settings.');
      if (data.deployment) onUpdated(data.deployment as BotDeployment);
      if (data.networking) setNetworking(data.networking as DeploymentNetworkingInfo);
      if (opts.customDomain !== undefined) {
        setDomainInput((data.networking?.customDomain as string) || '');
      }
      if (opts.appSlug !== undefined && data.networking?.appSlug) {
        setSlugInput(String(data.networking.appSlug));
      }
      setFeedback({
        type: 'success',
        text:
          opts.publicAppEnabled !== undefined
            ? `Public app & UptimeRobot links ${opts.publicAppEnabled ? 'enabled' : 'disabled'}.`
            : opts.appSlug !== undefined
              ? `Live app link updated to ${data.networking?.pathAppUrl || `/app/${data.networking?.appSlug}/`}.`
              : opts.customDomain
                ? 'Custom domain saved. Point your DNS CNAME record and click Verify DNS.'
                : 'Custom domain removed.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to save domain.',
      });
    } finally {
      setDomainBusy(false);
    }
  };

  const handleVerifyDns = async () => {
    setVerifyBusy(true);
    setFeedback(null);
    try {
      const resp = await fetch(`/api/deployments/${deployment.id}/domain/verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'DNS verification failed.');
      if (data.deployment) onUpdated(data.deployment as BotDeployment);
      if (data.networking) setNetworking(data.networking as DeploymentNetworkingInfo);
      setDnsCheckResult({
        verified: Boolean(data.verified),
        message: String(data.message || ''),
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'DNS verification failed.',
      });
    } finally {
      setVerifyBusy(false);
    }
  };

  const handleTestMonitorUrl = async (url: string) => {
    setUptimeProbeResult(null);
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      const data = (await resp.json()) as {
        status?: string;
        httpListening?: boolean;
        latencyMs?: number | null;
      };
      setUptimeProbeResult({
        ok: resp.ok,
        text: `HTTP ${resp.status} · ${data.status || (resp.ok ? 'UP' : 'DOWN')}${
          data.httpListening ? ` · Web port listening (${data.latencyMs ?? 1}ms)` : ''
        }`,
      });
    } catch {
      setUptimeProbeResult({ ok: false, text: 'Unable to reach monitor endpoint.' });
    }
  };

  const memPct = deployment.memoryLimitMb
    ? Math.min(100, Math.round((deployment.memoryMb / deployment.memoryLimitMb) * 100))
    : 0;

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <section className="rounded-xl border border-red-500/30 bg-[#12070a]/95 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-red-300 hover:text-red-200"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to Deployments
            </button>

            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-2xl font-semibold text-slate-50">
                {deployment.name}
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                  deployment.status === 'online'
                    ? 'text-emerald-400'
                    : deployment.status === 'building'
                      ? 'text-amber-300'
                      : deployment.status === 'failed'
                        ? 'text-red-400'
                        : 'text-slate-400'
                }`}
              >
                {deployment.status === 'online' ? (
                  <Activity className="h-3.5 w-3.5 text-emerald-400" />
                ) : deployment.status === 'building' ? (
                  <RotateCw className="h-3.5 w-3.5 animate-spin text-amber-400" />
                ) : (
                  <Square className="h-3 w-3" />
                )}
                <span className="capitalize">{deployment.status}</span>
              </span>
              <span className="rounded border border-red-950/90 bg-[#0a0406] px-2 py-0.5 font-mono text-[11px] text-rose-300">
                {deployment.id}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <a
                href={deployment.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-rose-300 hover:text-red-200"
              >
                {deployment.repoFullName}
                <ExternalLink className="h-3 w-3" />
              </a>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 font-mono">
                <GitBranch className="h-3 w-3 text-slate-500" />
                {deployment.settings.branch}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{deployment.settings.runtime}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{deployment.settings.region}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {deployment.status === 'online' ? (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => void runAction('stop')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/45 bg-red-500/15 px-3.5 py-2 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Square className="h-3.5 w-3.5" />
                Stop Bot
              </button>
            ) : (
              <button
                type="button"
                disabled={actionBusy || deployment.status === 'building'}
                onClick={() => void runAction('start')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-2 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Play className="h-3.5 w-3.5" />
                Start Bot
              </button>
            )}

            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void runAction('restart')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RotateCw className={`h-3.5 w-3.5 ${actionBusy ? 'animate-spin' : ''}`} />
              Redeploy
            </button>

            {!confirmDelete ? (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-red-500/45 hover:text-red-300 whitespace-nowrap shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            ) : (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/50 bg-red-500/15 px-2.5 py-1.5">
                <span className="text-xs text-red-200">Confirm delete?</span>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  className="rounded bg-red-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-red-500"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded px-1.5 py-0.5 text-xs text-slate-300 hover:text-white"
                >
                  No
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Telemetry Bars + Live CPU/RAM Waveform */}
        <div className="mt-5 space-y-4 border-t border-red-950/70 pt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      deployment.status === 'online' ? 'bg-red-400 animate-pulse' : 'bg-slate-600'
                    }`}
                  />
                  Realtime CPU
                </span>
                <span className="font-mono text-red-300 font-semibold tabular-nums">
                  {deployment.cpuPercent.toFixed(1)}%
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-red-950/80">
                <div
                  className="h-full bg-red-500 transition-all duration-300"
                  style={{ width: `${Math.min(100, deployment.cpuPercent)}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      deployment.status === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                    }`}
                  />
                  Realtime RAM
                </span>
                <span className="font-mono text-emerald-300 font-semibold tabular-nums">
                  {deployment.memoryMb} / {deployment.memoryLimitMb} MB ({memPct}%)
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-red-950/80">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${memPct}%` }}
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-red-950/80 bg-[#0a0406] px-3.5 py-2 text-xs">
              <span className="text-slate-400">Start Command</span>
              <span className="truncate pl-3 font-mono text-slate-200 max-w-[220px]">
                {deployment.settings.startCommand}
              </span>
            </div>
          </div>

          <BotCpuRamRealtimeChart deployment={deployment} />
        </div>

        {isNodeDeployment &&
          networking?.publicAppEnabled !== false &&
          (networking?.customDomainUrl || networking?.pathAppUrl) && (
            <div className="mt-4 space-y-2.5 rounded-lg border border-emerald-500/30 bg-[#0a0406] px-3.5 py-2.5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="font-semibold text-slate-200 shrink-0">Live URL:</span>
                  <a
                    href={networking.customDomainUrl || networking.pathAppUrl!}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-mono text-emerald-300 hover:underline"
                  >
                    {networking.customDomainUrl || networking.pathAppUrl}
                  </a>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      void copyLinkValue(
                        'headerUrl',
                        (networking.customDomainUrl || networking.pathAppUrl)!
                      )
                    }
                    className="inline-flex items-center gap-1 rounded border border-red-950/90 bg-[#12070a] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-red-500/45"
                  >
                    {copiedField === 'headerUrl' ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copiedField === 'headerUrl' ? 'Copied' : 'Copy Link'}
                  </button>
                  <a
                    href={networking.customDomainUrl || networking.pathAppUrl!}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500"
                  >
                    Open App
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      setInlineLinkOpen((v) => !v);
                      setInlineDomainOpen(false);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-red-950/90 bg-[#12070a] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-red-500/45 hover:text-white"
                  >
                    <Link2 className="h-3 w-3 text-emerald-400" />
                    Edit Link
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInlineDomainOpen((v) => !v);
                      setInlineLinkOpen(false);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-red-950/90 bg-[#12070a] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-red-500/45 hover:text-white"
                  >
                    <Globe className="h-3 w-3 text-red-400" />
                    {networking.customDomain ? 'Change Domain' : 'Add Custom Domain'}
                  </button>
                </div>
              </div>

              {inlineLinkOpen && (
                <div className="flex flex-col gap-2 border-t border-red-950/70 pt-2.5 sm:flex-row sm:items-center">
                  <div className="flex flex-1 items-center rounded-md border border-red-950/90 bg-[#12070a] px-3 py-1.5 font-mono text-xs">
                    <span className="text-slate-500 shrink-0 select-none">
                      {networking.railwayDomain ? `https://${networking.railwayDomain}/app/` : '/app/'}
                    </span>
                    <input
                      type="text"
                      value={slugInput}
                      onChange={(e) => setSlugInput(e.target.value)}
                      placeholder="my-web-app"
                      className="min-w-0 flex-1 bg-transparent text-emerald-300 placeholder:text-slate-600 focus:outline-none"
                    />
                    <span className="text-slate-500 shrink-0 select-none">/</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={domainBusy}
                      onClick={() => void handleDomainSave({ appSlug: slugInput })}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {domainBusy ? 'Saving...' : 'Save Link'}
                    </button>
                  </div>
                </div>
              )}

              {inlineDomainOpen && (
                <div className="flex flex-col gap-2 border-t border-red-950/70 pt-2.5 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    placeholder="api.yourdomain.com or mybot.up.railway.app"
                    className="flex-1 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={domainBusy}
                      onClick={() => void handleDomainSave({ customDomain: domainInput })}
                      className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      {domainBusy ? 'Saving...' : 'Save Domain'}
                    </button>
                    {networking.customDomain && (
                      <button
                        type="button"
                        disabled={verifyBusy}
                        onClick={() => void handleVerifyDns()}
                        className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                      >
                        {verifyBusy ? 'Checking...' : 'Verify DNS'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveTab('networking')}
                      className="rounded-md border border-red-950/90 bg-[#12070a] px-2.5 py-1.5 text-[11px] text-slate-300 hover:text-white"
                    >
                      Full DNS Setup
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
      </section>

      {feedback && (
        <div
          className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
            feedback.type === 'error'
              ? 'border-red-500/50 bg-red-500/15 text-red-200'
              : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {feedback.type === 'error' ? (
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
          ) : (
            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Workspace Tabs */}
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-red-950/80 bg-[#0d0508] p-1 w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('logs')}
          className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'logs'
              ? 'bg-red-600/20 text-red-300 border border-red-500/40'
              : 'text-slate-400 hover:text-slate-200 border border-transparent'
          }`}
        >
          <Terminal className="h-3.5 w-3.5" />
          Console Logs
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('settings')}
          className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'settings'
              ? 'bg-red-600/20 text-red-300 border border-red-500/40'
              : 'text-slate-400 hover:text-slate-200 border border-transparent'
          }`}
        >
          <Save className="h-3.5 w-3.5" />
          Settings & Env
        </button>
        {isNodeDeployment && (
          <button
            type="button"
            onClick={() => setActiveTab('networking')}
            className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'networking'
                ? 'bg-red-600/20 text-red-300 border border-red-500/40'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            Links & Domain
          </button>
        )}
        <button
          type="button"
          onClick={() => setActiveTab('security')}
          className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'security'
              ? 'bg-red-600/20 text-red-300 border border-red-500/40'
              : 'text-slate-400 hover:text-slate-200 border border-transparent'
          }`}
        >
          <ShieldAlert className="h-3.5 w-3.5" />
          Security Scan
        </button>
      </div>

      {/* Tab 1: Console Logs */}
      {activeTab === 'logs' && (
        <section className="rounded-xl border border-red-500/25 bg-[#0a0406]/95">
          <div className="flex flex-col gap-3 border-b border-red-950/70 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              {(['all', 'info', 'success', 'warn', 'error'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setLogLevelFilter(lvl)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                    logLevelFilter === lvl
                      ? 'bg-red-600/25 text-red-300 border border-red-500/35'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Search logs..."
                className="rounded-md border border-red-950/90 bg-[#12070a] px-3 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-red-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void copyAllLogs()}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-red-500/40 hover:text-red-300 whitespace-nowrap shrink-0"
              >
                {copiedLogs ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedLogs ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="max-h-[460px] overflow-y-auto p-4 font-mono text-xs leading-6">
            {filteredLogs.length === 0 ? (
              <div className="py-10 text-center text-slate-500">No log lines match your filter.</div>
            ) : (
              filteredLogs.map((entry) => (
                <div key={entry.id} className="flex items-start gap-3 border-b border-red-950/30 py-1">
                  <span className="shrink-0 text-slate-500 tabular-nums">
                    {formatTime(entry.timestamp)}
                  </span>
                  <span
                    className={`w-16 shrink-0 uppercase ${
                      entry.level === 'success'
                        ? 'text-emerald-400'
                        : entry.level === 'warn'
                          ? 'text-amber-300'
                          : entry.level === 'error'
                            ? 'text-red-400 font-semibold'
                            : 'text-rose-400'
                    }`}
                  >
                    [{entry.stage}]
                  </span>
                  <span
                    className={
                      entry.level === 'error'
                        ? 'text-red-300'
                        : entry.level === 'warn'
                          ? 'text-amber-200'
                          : entry.level === 'success'
                            ? 'text-emerald-200'
                            : 'text-slate-200'
                    }
                  >
                    {entry.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* Tab 2: Settings & Environment Variables */}
      {activeTab === 'settings' && (
        <section className="rounded-xl border border-red-500/25 bg-[#12070a]/95 p-6 space-y-6">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-slate-300">Bot Service Name</label>
              <input
                type="text"
                value={draftSettings.name}
                onChange={(e) => setDraftSettings({ ...draftSettings, name: e.target.value })}
                className="mt-1.5 w-full rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 text-sm text-slate-100 focus:border-red-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300">Git Branch</label>
              <input
                type="text"
                value={draftSettings.branch}
                onChange={(e) => setDraftSettings({ ...draftSettings, branch: e.target.value })}
                className="mt-1.5 w-full rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 font-mono text-sm text-slate-100 focus:border-red-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300">Runtime Environment</label>
              <select
                value={draftSettings.runtime}
                onChange={(e) =>
                  setDraftSettings({ ...draftSettings, runtime: e.target.value as RuntimeEnvironment })
                }
                className="mt-1.5 w-full rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 font-mono text-sm text-slate-100 focus:border-red-400 focus:outline-none"
              >
                <option value="node-20">Node.js 20 LTS</option>
                <option value="node-22">Node.js 22 Current</option>
                <option value="bun-1">Bun 1.1</option>
                <option value="python-3.12">Python 3.12</option>
                <option value="docker">Dockerfile Container</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300">Deploy Region</label>
              <select
                value={draftSettings.region}
                onChange={(e) =>
                  setDraftSettings({ ...draftSettings, region: e.target.value as DeployRegion })
                }
                className="mt-1.5 w-full rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 font-mono text-sm text-slate-100 focus:border-red-400 focus:outline-none"
              >
                {DEPLOY_REGIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300">Compute Tier</label>
              <select
                value={draftSettings.computeTier}
                onChange={(e) =>
                  setDraftSettings({ ...draftSettings, computeTier: e.target.value as ComputeTier })
                }
                className="mt-1.5 w-full rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 text-sm text-slate-100 focus:border-red-400 focus:outline-none"
              >
                <option value="nano">Nano (256 MB)</option>
                <option value="standard">Standard (512 MB)</option>
                <option value="pro">Pro (1024 MB)</option>
                <option value="cluster">Cluster (2048 MB)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300">Restart Policy</label>
              <select
                value={draftSettings.restartPolicy}
                onChange={(e) =>
                  setDraftSettings({
                    ...draftSettings,
                    restartPolicy: e.target.value as RestartPolicy,
                  })
                }
                className="mt-1.5 w-full rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 text-sm text-slate-100 focus:border-red-400 focus:outline-none"
              >
                <option value="always">Always</option>
                <option value="on-failure">On Failure</option>
                <option value="never">Never</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300">Install Command</label>
              <input
                type="text"
                value={draftSettings.installCommand}
                onChange={(e) =>
                  setDraftSettings({ ...draftSettings, installCommand: e.target.value })
                }
                className="mt-1.5 w-full rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300">Build Command</label>
              <input
                type="text"
                value={draftSettings.buildCommand}
                onChange={(e) =>
                  setDraftSettings({ ...draftSettings, buildCommand: e.target.value })
                }
                className="mt-1.5 w-full rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300">Start Command</label>
              <input
                type="text"
                value={draftSettings.startCommand}
                onChange={(e) =>
                  setDraftSettings({ ...draftSettings, startCommand: e.target.value })
                }
                className="mt-1.5 w-full rounded-lg border border-red-950/90 bg-[#0a0406] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
              />
            </div>
          </div>

          <div className="border-t border-red-950/70 pt-5">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={draftSettings.autoDeploy}
                onChange={(e) =>
                  setDraftSettings({ ...draftSettings, autoDeploy: e.target.checked })
                }
                className="h-4 w-4 rounded border-red-900 bg-[#0a0406] text-red-500 accent-red-500"
              />
              <span className="text-sm text-slate-200">
                Auto-deploy when new commits push to <span className="font-mono text-red-300">{draftSettings.branch}</span>
              </span>
            </label>
          </div>

          <div className="border-t border-red-950/70 pt-5">
            <EnvVarsEditor
              envVars={draftSettings.envVars}
              onChange={(envVars) => setDraftSettings({ ...draftSettings, envVars })}
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-red-950/70 pt-5">
            <button
              type="button"
              disabled={saveBusy}
              onClick={() => void handleSaveSettings(false)}
              className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/15 px-4 py-2 text-sm font-semibold text-rose-200 transition-colors hover:bg-red-500/25 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Save Settings
            </button>
            <button
              type="button"
              disabled={saveBusy}
              onClick={() => void handleSaveSettings(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            >
              <Rocket className="h-4 w-4" />
              Save & Redeploy
            </button>
          </div>
        </section>
      )}

      {/* Tab 2.5: Public Links, UptimeRobot & Custom Domain (Node apps & Node bots) */}
      {activeTab === 'networking' && isNodeDeployment && (
        <section className="rounded-xl border border-red-500/25 bg-[#12070a]/95 p-6 space-y-6">
          <div className="flex flex-col gap-3 border-b border-red-950/70 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-50">
                App Access, UptimeRobot &amp; Custom Domain
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Available for Node.js apps and Node bots. Share your server link for web access, add an independent UptimeRobot check, or bind a custom domain.
              </p>
            </div>
            <button
              type="button"
              disabled={domainBusy}
              onClick={() =>
                void handleDomainSave({ publicAppEnabled: !(networking?.publicAppEnabled ?? true) })
              }
              className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                networking?.publicAppEnabled !== false
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                  : 'border-red-950/90 bg-[#0a0406] text-slate-300 hover:border-red-500/45'
              }`}
            >
              {networking?.publicAppEnabled !== false ? 'Public Links Enabled' : 'Public Links Disabled'}
            </button>
          </div>

          {networking && !networking.publicAppEnabled ? (
            <div className="rounded-lg border border-dashed border-red-950/80 bg-[#0a0406] p-5 text-xs text-slate-400">
              Public app proxy and UptimeRobot monitor links are disabled for this bot. Click{' '}
              <span className="text-slate-200 font-medium">Public Links Disabled</span> above to re-enable them.
            </div>
          ) : (
            <div className="space-y-5">
              {/* Random Server App Link */}
              <div className="rounded-lg border border-red-950/80 bg-[#0a0406] p-4 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                    <Link2 className="h-3.5 w-3.5 text-red-400" />
                    <span>
                      {networking?.railwayDomain
                        ? `Railway Public URL (Internal Port ${networking?.internalPort ?? '—'})`
                        : `Live Node App URL (Internal Port ${networking?.internalPort ?? '—'})`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    {networking?.railwayDomain && (
                      <span className="rounded border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
                        Railway: {networking.railwayDomain}
                      </span>
                    )}
                    <span className="text-slate-400">
                      Slug: {networking?.appSlug || deployment.appSlug}
                    </span>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">
                  Edit the app link slug below to customize your live Railway URL, forwarding HTTP &amp; WebSocket traffic directly to your Node app.
                </p>
                {networking?.pathAppUrl && (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="flex flex-1 items-center rounded-md border border-red-950/90 bg-[#12070a] px-3 py-2 font-mono text-xs">
                      <span className="text-slate-500 shrink-0 select-none">
                        {networking.railwayDomain ? `https://${networking.railwayDomain}/app/` : '/app/'}
                      </span>
                      <input
                        type="text"
                        value={slugInput}
                        onChange={(e) => setSlugInput(e.target.value)}
                        placeholder="my-web-app"
                        className="min-w-0 flex-1 bg-transparent text-rose-200 placeholder:text-slate-600 focus:outline-none"
                      />
                      <span className="text-slate-500 shrink-0 select-none">/</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={domainBusy}
                        onClick={() => void handleDomainSave({ appSlug: slugInput })}
                        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {domainBusy ? 'Saving...' : 'Save Link'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyLinkValue('appUrl', networking.pathAppUrl!)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-2 text-xs font-medium text-slate-200 hover:border-red-500/40"
                      >
                        {copiedField === 'appUrl' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                        {copiedField === 'appUrl' ? 'Copied' : 'Copy'}
                      </button>
                      <a
                        href={networking.pathAppUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-500"
                      >
                        Open App
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                )}

                {networking?.subdomainAppUrl && (
                  <div className="pt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <span className="text-[11px] text-slate-400 shrink-0">Platform Subdomain:</span>
                    <input
                      type="text"
                      readOnly
                      value={networking.subdomainAppUrl}
                      className="flex-1 rounded-md border border-emerald-500/30 bg-[#12070a] px-3 py-1.5 font-mono text-xs text-emerald-300"
                    />
                    <a
                      href={networking.subdomainAppUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-emerald-300 hover:underline shrink-0"
                    >
                      Open
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
              </div>

              {/* UptimeRobot Monitor Link */}
              <div className="rounded-lg border border-red-950/80 bg-[#0a0406] p-4 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                    <Activity className="h-3.5 w-3.5 text-emerald-400" />
                    <span>UptimeRobot Independent Monitor URL</span>
                  </div>
                  <span className="font-mono text-[11px] text-emerald-400">
                    200 UP · 503 DOWN
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Add this URL as an <span className="text-slate-200">HTTP(s)</span> or <span className="text-slate-200">Keyword ("UP")</span> monitor in UptimeRobot. It checks real process health and returns HTTP 503 immediately if stopped or crashed.
                </p>
                {networking?.uptimeMonitorUrl && (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="text"
                      readOnly
                      value={networking.uptimeMonitorUrl}
                      className="flex-1 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-2 font-mono text-xs text-emerald-300"
                    />
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void copyLinkValue('uptimeUrl', networking.uptimeMonitorUrl!)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-2 text-xs font-medium text-slate-200 hover:border-red-500/40"
                      >
                        {copiedField === 'uptimeUrl' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                        {copiedField === 'uptimeUrl' ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleTestMonitorUrl(networking.uptimeMonitorUrl!)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/35 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25"
                      >
                        Test Link
                      </button>
                    </div>
                  </div>
                )}
                {uptimeProbeResult && (
                  <div
                    className={`font-mono text-[11px] ${
                      uptimeProbeResult.ok ? 'text-emerald-300' : 'text-amber-300'
                    }`}
                  >
                    {uptimeProbeResult.text}
                  </div>
                )}
              </div>

              {/* In-App Custom Domain Manager */}
              <div className="rounded-lg border border-red-950/80 bg-[#0a0406] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                    <Globe className="h-3.5 w-3.5 text-red-400" />
                    <span>Connect Custom Domain</span>
                  </div>
                  {networking?.customDomain && (
                    <span
                      className={`font-mono text-[11px] font-semibold ${
                        networking.customDomainVerified ? 'text-emerald-400' : 'text-amber-300'
                      }`}
                    >
                      {networking.customDomainVerified ? 'DNS Verified' : 'Pending DNS Verification'}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    placeholder="api.yourdomain.com"
                    className="flex-1 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={domainBusy}
                      onClick={() => void handleDomainSave({ customDomain: domainInput })}
                      className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      {domainBusy ? 'Saving...' : 'Save Domain'}
                    </button>
                    {networking?.customDomain && (
                      <>
                        <button
                          type="button"
                          disabled={verifyBusy}
                          onClick={() => void handleVerifyDns()}
                          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                        >
                          {verifyBusy ? 'Checking...' : 'Verify DNS'}
                        </button>
                        <button
                          type="button"
                          disabled={domainBusy}
                          onClick={() => void handleDomainSave({ customDomain: '' })}
                          className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-2 text-xs text-slate-300 hover:text-red-300"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="rounded border border-red-950/60 bg-[#12070a] p-3 text-[11px] text-slate-400 space-y-1">
                  <div>
                    <span className="text-slate-200 font-medium">Custom Domain DNS:</span> Point a{' '}
                    <code className="font-mono text-rose-300">CNAME</code> record from your custom domain to{' '}
                    <code className="font-mono text-emerald-300">
                      {networking?.railwayDomain || networking?.serverHost || 'your-service.up.railway.app'}
                    </code>
                    .
                  </div>
                  <div>
                    <span className="text-slate-200 font-medium">Railway Domain Option:</span> You can also enter an extra{' '}
                    <code className="font-mono text-emerald-300">*.up.railway.app</code> or custom domain added under Railway Service → Settings → Networking so TLS certificates issue automatically.
                  </div>
                </div>

                {dnsCheckResult && (
                  <div
                    className={`rounded-md border p-2.5 text-xs ${
                      dnsCheckResult.verified
                        ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
                        : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
                    }`}
                  >
                    {dnsCheckResult.message}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Tab 3: Security Scan */}
      {activeTab === 'security' && (
        <section className="rounded-xl border border-red-500/30 bg-[#12070a]/95 p-6 space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-50">
                Repository Security & Manifest Audit
              </h2>
              <p className="text-xs text-slate-400">
                Pulls the latest file tree from GitHub to check for committed secrets, `.gitignore` rules, and dependency hygiene.
              </p>
            </div>
            <button
              type="button"
              disabled={rescanBusy}
              onClick={() => void handleRescan()}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <ScanSearch className={`h-4 w-4 ${rescanBusy ? 'animate-spin' : ''}`} />
              {rescanBusy ? 'Scanning GitHub...' : 'Re-Scan GitHub Repo'}
            </button>
          </div>

          {!deployment.scanReport ? (
            <div className="rounded-lg border border-dashed border-red-950/80 bg-[#0a0406] p-8 text-center">
              <ShieldCheck className="mx-auto h-8 w-8 text-red-400/75" />
              <p className="mt-2 text-sm text-slate-300">
                No fresh scan snapshot attached to this deployment yet.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Click "Re-Scan GitHub Repo" above to run a live inspection against {deployment.repoFullName}.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>Scanned at {new Date(deployment.scanReport.scannedAt).toLocaleString()}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{deployment.scanReport.totalFiles} files</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">commit {deployment.scanReport.latestCommitSha}</span>
              </div>

              {deployment.scanReport.securityFindings.map((finding) => (
                <div
                  key={finding.id}
                  className={`rounded-lg border p-3.5 ${
                    finding.severity === 'critical'
                      ? 'border-red-500/45 bg-red-500/15'
                      : finding.severity === 'warning'
                        ? 'border-amber-500/35 bg-amber-500/10'
                        : 'border-emerald-500/25 bg-emerald-500/[0.06]'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {finding.severity === 'critical' ? (
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                    ) : finding.severity === 'warning' ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    ) : (
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    )}
                    <div>
                      <div className="text-sm font-medium text-slate-100">{finding.title}</div>
                      <p className="mt-0.5 text-xs text-slate-300">{finding.detail}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
