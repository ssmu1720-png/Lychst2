import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
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
import {
  DEPLOY_REGIONS,
  type BotDeployment,
  type BotSettings,
  type ComputeTier,
  type DeployRegion,
  type LogEntry,
  type RestartPolicy,
  type RuntimeEnvironment,
} from '../types/lyrihost';

interface BotInspectorViewProps {
  authToken: string;
  deployment: BotDeployment;
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
  onBack,
  onUpdated,
  onDeleted,
}: BotInspectorViewProps) {
  const [activeTab, setActiveTab] = useState<'logs' | 'settings' | 'security'>('logs');
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | LogEntry['level']>('all');
  const [logSearch, setLogSearch] = useState('');
  const [copiedLogs, setCopiedLogs] = useState(false);

  const [actionBusy, setActionBusy] = useState(false);
  const [rescanBusy, setRescanBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [draftSettings, setDraftSettings] = useState<BotSettings>(deployment.settings);

  // Keep draft settings synchronized when switching bots
  useEffect(() => {
    setDraftSettings(deployment.settings);
    setConfirmDelete(false);
    setFeedback(null);
  }, [deployment.id]);

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

        {/* Telemetry Bars */}
        <div className="mt-5 grid grid-cols-1 gap-4 border-t border-red-950/70 pt-4 sm:grid-cols-3">
          <div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>CPU Utilization</span>
              <span className="font-mono text-red-300 tabular-nums">
                {deployment.cpuPercent.toFixed(1)}%
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-red-950/80">
              <div
                className="h-full bg-red-500 transition-all duration-300"
                style={{ width: `${Math.min(100, deployment.cpuPercent * 4)}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Memory Usage</span>
              <span className="font-mono text-rose-300 tabular-nums">
                {deployment.memoryMb} / {deployment.memoryLimitMb} MB ({memPct}%)
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-red-950/80">
              <div
                className="h-full bg-rose-500 transition-all duration-300"
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
      <div className="flex items-center gap-1 rounded-lg border border-red-950/80 bg-[#0d0508] p-1 w-fit">
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
