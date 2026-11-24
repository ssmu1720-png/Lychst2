import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Rocket,
  Server,
  Settings,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type {
  AuthUser,
  BotDeployment,
  DeploymentNetworkingInfo,
  PlatformPreferences,
} from '../types/lyrihost';

interface DomainsViewProps {
  authToken: string;
  deployments: BotDeployment[];
  currentUser: AuthUser;
  preferences: PlatformPreferences;
  onDeploymentUpdated: (updated: BotDeployment) => void;
  onSelectBot: (botId: string, tab?: 'logs' | 'settings' | 'networking' | 'security') => void;
  onOpenSettings: () => void;
  onOpenCustomDeploy: () => void;
}

function isNodeRuntime(runtime?: string): boolean {
  return runtime === 'node-20' || runtime === 'node-22' || runtime === 'bun-1';
}

export function DomainsView({
  authToken,
  deployments,
  currentUser,
  preferences,
  onDeploymentUpdated,
  onSelectBot,
  onOpenSettings,
  onOpenCustomDeploy,
}: DomainsViewProps) {
  const nodeDeployments = useMemo(
    () => deployments.filter((d) => isNodeRuntime(d.settings?.runtime)),
    [deployments]
  );
  const nonNodeDeployments = useMemo(
    () => deployments.filter((d) => !isNodeRuntime(d.settings?.runtime)),
    [deployments]
  );

  const [networkingMap, setNetworkingMap] = useState<Record<string, DeploymentNetworkingInfo>>({});
  const [domainInputs, setDomainInputs] = useState<Record<string, string>>({});
  const [busyMap, setBusyMap] = useState<Record<string, 'save' | 'verify' | 'toggle' | 'test' | undefined>>({});
  const [feedbackMap, setFeedbackMap] = useState<
    Record<string, { type: 'success' | 'error'; text: string } | undefined>
  >({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchNetworkingAll = useCallback(async () => {
    if (nodeDeployments.length === 0) return;
    const entries = await Promise.all(
      nodeDeployments.map(async (dep) => {
        try {
          const resp = await fetch(`/api/deployments/${dep.id}/networking`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (!resp.ok) return null;
          const info = (await resp.json()) as DeploymentNetworkingInfo;
          return [dep.id, info] as const;
        } catch {
          return null;
        }
      })
    );

    const nextMap: Record<string, DeploymentNetworkingInfo> = {};
    for (const entry of entries) {
      if (entry) {
        nextMap[entry[0]] = entry[1];
      }
    }
    setNetworkingMap(nextMap);
    setDomainInputs((prev) => {
      const next = { ...prev };
      for (const dep of nodeDeployments) {
        if (next[dep.id] === undefined) {
          next[dep.id] = nextMap[dep.id]?.customDomain ?? dep.customDomain ?? '';
        }
      }
      return next;
    });
  }, [authToken, nodeDeployments]);

  useEffect(() => {
    void fetchNetworkingAll();
  }, [fetchNetworkingAll]);

  const sampleInfo = useMemo(() => {
    const firstId = nodeDeployments[0]?.id;
    return firstId ? networkingMap[firstId] : undefined;
  }, [nodeDeployments, networkingMap]);

  const activeRailwayHost =
    sampleInfo?.railwayDomain ||
    preferences.railwayDomain ||
    sampleInfo?.serverHost ||
    (typeof window !== 'undefined' ? window.location.hostname : 'your-service.up.railway.app');

  const copyValue = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleSaveDomain = async (
    dep: BotDeployment,
    payload: { customDomain?: string | null; publicAppEnabled?: boolean },
    actionType: 'save' | 'toggle'
  ) => {
    setBusyMap((prev) => ({ ...prev, [dep.id]: actionType }));
    setFeedbackMap((prev) => ({ ...prev, [dep.id]: undefined }));
    try {
      const resp = await fetch(`/api/deployments/${dep.id}/domain`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to update domain.');
      }
      if (data.networking) {
        setNetworkingMap((prev) => ({
          ...prev,
          [dep.id]: data.networking as DeploymentNetworkingInfo,
        }));
      }
      if (payload.customDomain !== undefined) {
        setDomainInputs((prev) => ({
          ...prev,
          [dep.id]: (data.networking?.customDomain as string) || '',
        }));
      }
      if (data.deployment) {
        onDeploymentUpdated(data.deployment as BotDeployment);
      }

      const savedDomain = data.networking?.customDomain as string | null | undefined;
      setFeedbackMap((prev) => ({
        ...prev,
        [dep.id]: {
          type: 'success',
          text:
            payload.publicAppEnabled !== undefined
              ? payload.publicAppEnabled
                ? 'Public Railway & custom domain links enabled.'
                : 'Public links disabled for this bot.'
              : savedDomain
                ? `Saved "${savedDomain}". Point a CNAME record to ${activeRailwayHost} and click Verify DNS.`
                : 'Custom domain removed.',
        },
      }));
    } catch (err) {
      setFeedbackMap((prev) => ({
        ...prev,
        [dep.id]: {
          type: 'error',
          text: err instanceof Error ? err.message : 'Unable to save custom domain.',
        },
      }));
    } finally {
      setBusyMap((prev) => ({ ...prev, [dep.id]: undefined }));
    }
  };

  const handleVerifyDns = async (dep: BotDeployment) => {
    setBusyMap((prev) => ({ ...prev, [dep.id]: 'verify' }));
    setFeedbackMap((prev) => ({ ...prev, [dep.id]: undefined }));
    try {
      const resp = await fetch(`/api/deployments/${dep.id}/domain/verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'DNS verification failed.');
      }
      if (data.networking) {
        setNetworkingMap((prev) => ({
          ...prev,
          [dep.id]: data.networking as DeploymentNetworkingInfo,
        }));
      }
      if (data.deployment) {
        onDeploymentUpdated(data.deployment as BotDeployment);
      }
      setFeedbackMap((prev) => ({
        ...prev,
        [dep.id]: {
          type: data.verified ? 'success' : 'error',
          text: String(data.message || (data.verified ? 'DNS verified.' : 'DNS not matching yet.')),
        },
      }));
    } catch (err) {
      setFeedbackMap((prev) => ({
        ...prev,
        [dep.id]: {
          type: 'error',
          text: err instanceof Error ? err.message : 'Unable to check DNS right now.',
        },
      }));
    } finally {
      setBusyMap((prev) => ({ ...prev, [dep.id]: undefined }));
    }
  };

  const handleTestMonitor = async (dep: BotDeployment, url: string) => {
    setBusyMap((prev) => ({ ...prev, [dep.id]: 'test' }));
    try {
      const resp = await fetch(url);
      const data = await resp.json().catch(() => null);
      setFeedbackMap((prev) => ({
        ...prev,
        [dep.id]: {
          type: resp.ok ? 'success' : 'error',
          text: `UptimeRobot probe returned HTTP ${resp.status}${
            data?.status ? ` (${String(data.status)})` : ''
          }${typeof data?.latencyMs === 'number' ? ` · ${data.latencyMs}ms` : ''}`,
        },
      }));
    } catch {
      setFeedbackMap((prev) => ({
        ...prev,
        [dep.id]: {
          type: 'error',
          text: 'Could not reach monitor URL from browser.',
        },
      }));
    } finally {
      setBusyMap((prev) => ({ ...prev, [dep.id]: undefined }));
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <section className="atelier-panel relative rounded-lg border border-red-500/25 p-5 sm:p-6">
        <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70" />
        <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70" />

        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-50">
              Custom <span className="italic font-medium text-red-400">Domains</span> &amp; Railway Links
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Add or change custom domains for your Node.js apps and Node bots, copy Railway server URLs, and manage UptimeRobot endpoints in one place.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="rounded-md border border-emerald-500/35 bg-emerald-500/10 px-3 py-1.5 font-mono text-[11px] text-emerald-200">
              CNAME Target: <span className="font-semibold text-emerald-300">{activeRailwayHost}</span>
            </div>
            {currentUser.isAdmin && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#0d0508] px-3 py-1.5 text-[11px] font-medium text-slate-200 hover:border-red-500/45"
              >
                <Settings className="h-3.5 w-3.5 text-red-400" />
                Change Railway Domain
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Empty State */}
      {nodeDeployments.length === 0 ? (
        <section className="atelier-panel rounded-lg border border-dashed border-red-500/30 p-10 text-center space-y-3">
          <Globe className="mx-auto h-8 w-8 text-red-400" />
          <h2 className="font-display text-lg font-semibold text-slate-100">
            No Node.js Apps or Node Bots Deployed Yet
          </h2>
          <p className="mx-auto max-w-md text-xs text-slate-400">
            Public links, UptimeRobot monitors, and custom domains are available for Node.js (20/22) and Bun deployments. Deploy a Node app or Node bot to configure its custom domain here.
          </p>
          <button
            type="button"
            onClick={onOpenCustomDeploy}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500"
          >
            <Rocket className="h-3.5 w-3.5" />
            Deploy Node App / Bot
          </button>
        </section>
      ) : (
        <div className="space-y-4">
          {nodeDeployments.map((dep) => {
            const info = networkingMap[dep.id];
            const currentCustomDomain = info?.customDomain ?? dep.customDomain ?? '';
            const currentVerified = info?.customDomainVerified ?? dep.customDomainVerified ?? false;
            const inputVal = domainInputs[dep.id] ?? currentCustomDomain;
            const busy = busyMap[dep.id];
            const feedback = feedbackMap[dep.id];
            const publicEnabled = info ? info.publicAppEnabled : dep.publicAppEnabled !== false;
            const pathUrl =
              info?.pathAppUrl ||
              (publicEnabled && dep.appSlug
                ? preferences.railwayDomain
                  ? `https://${preferences.railwayDomain}/app/${dep.appSlug}/`
                  : `/app/${dep.appSlug}/`
                : null);

            return (
              <section
                key={dep.id}
                className="atelier-panel rounded-lg border border-red-500/25 p-5 space-y-4"
              >
                {/* Card Header */}
                <div className="flex flex-col gap-3 border-b border-red-950/70 pb-3.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-lg font-semibold text-slate-50 truncate">
                        {dep.name}
                      </h2>
                      <span
                        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] font-semibold ${
                          dep.status === 'online'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : 'bg-slate-800/80 text-slate-300 border border-slate-700'
                        }`}
                      >
                        {dep.status.toUpperCase()}
                      </span>
                      <span className="rounded border border-red-950/80 bg-[#080305] px-2 py-0.5 font-mono text-[10px] text-rose-300">
                        {dep.settings.runtime}
                      </span>
                      {info?.internalPort && (
                        <span className="font-mono text-[11px] text-slate-400">
                          Port {info.internalPort}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-slate-400 truncate">
                      {dep.repoFullName} · Slug: {info?.appSlug || dep.appSlug || dep.id}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void handleSaveDomain(dep, { publicAppEnabled: !publicEnabled }, 'toggle')
                      }
                      className={`rounded-md border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                        publicEnabled
                          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                          : 'border-red-950/90 bg-[#080305] text-slate-300 hover:border-red-500/45'
                      }`}
                    >
                      {publicEnabled ? 'Public Links Enabled' : 'Public Links Disabled'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectBot(dep.id, 'logs')}
                      className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 text-[11px] font-medium text-slate-200 hover:border-red-500/45"
                    >
                      <Terminal className="h-3.5 w-3.5 text-red-400" />
                      Logs
                    </button>
                  </div>
                </div>

                {/* Add / Change Custom Domain Controls */}
                <div className="rounded-lg border border-red-950/80 bg-[#080305] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                      <Globe className="h-3.5 w-3.5 text-red-400" />
                      <span>
                        {currentCustomDomain ? 'Change or Verify Custom Domain' : 'Add Custom Domain'}
                      </span>
                    </div>
                    {currentCustomDomain ? (
                      <span
                        className={`inline-flex items-center gap-1 font-mono text-[11px] font-semibold ${
                          currentVerified ? 'text-emerald-400' : 'text-amber-300'
                        }`}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {currentVerified ? 'DNS Verified' : 'Pending DNS Verification'}
                      </span>
                    ) : (
                      <span className="font-mono text-[11px] text-slate-500">
                        No custom domain connected
                      </span>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 lg:flex-row">
                    <input
                      type="text"
                      value={inputVal}
                      onChange={(e) =>
                        setDomainInputs((prev) => ({ ...prev, [dep.id]: e.target.value }))
                      }
                      placeholder="api.yourdomain.com or mybot.up.railway.app"
                      className="flex-1 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                    />
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void handleSaveDomain(dep, { customDomain: inputVal }, 'save')
                        }
                        className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                      >
                        {busy === 'save'
                          ? 'Saving...'
                          : currentCustomDomain
                            ? 'Change Domain'
                            : 'Add Domain'}
                      </button>

                      {currentCustomDomain && (
                        <>
                          <button
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => void handleVerifyDns(dep)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                          >
                            {busy === 'verify' ? 'Checking...' : 'Verify DNS'}
                          </button>
                          <a
                            href={`https://${currentCustomDomain}/`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-2 text-xs text-slate-200 hover:border-red-500/45"
                          >
                            Open
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          <button
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              void handleSaveDomain(dep, { customDomain: '' }, 'save')
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-red-950/90 bg-[#12070a] px-3 py-2 text-xs text-slate-300 hover:text-red-300 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-400">
                    Point a <code className="font-mono text-rose-300">CNAME</code> record from your domain to{' '}
                    <code className="font-mono text-emerald-300">{activeRailwayHost}</code> and add the domain under Railway Service → Settings → Networking for automatic HTTPS.
                  </p>
                </div>

                {/* Default Railway Link + UptimeRobot URL */}
                {publicEnabled && (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {pathUrl && (
                      <div className="rounded-md border border-red-950/75 bg-[#080305] p-3 space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-200">
                          <Link2 className="h-3.5 w-3.5 text-red-400" />
                          <span>Railway / Server App URL</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            readOnly
                            value={pathUrl}
                            className="flex-1 min-w-0 rounded border border-red-950/80 bg-[#12070a] px-2.5 py-1.5 font-mono text-[11px] text-rose-200"
                          />
                          <button
                            type="button"
                            onClick={() => void copyValue(`app_${dep.id}`, pathUrl)}
                            className="rounded border border-red-950/90 bg-[#12070a] px-2.5 py-1.5 text-[11px] text-slate-200 hover:border-red-500/45 shrink-0"
                          >
                            {copiedKey === `app_${dep.id}` ? (
                              <Check className="h-3.5 w-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <a
                            href={pathUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded border border-red-500/40 bg-red-600/20 px-2.5 py-1.5 text-[11px] font-medium text-rose-200 hover:bg-red-600/30 shrink-0"
                          >
                            Open
                          </a>
                        </div>
                      </div>
                    )}

                    {info?.uptimeMonitorUrl && (
                      <div className="rounded-md border border-red-950/75 bg-[#080305] p-3 space-y-1.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="inline-flex items-center gap-1.5 font-semibold text-slate-200">
                            <Activity className="h-3.5 w-3.5 text-emerald-400" />
                            UptimeRobot Monitor URL
                          </span>
                          <span className="font-mono text-[10px] text-emerald-400">200 UP · 503 DOWN</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            readOnly
                            value={info.uptimeMonitorUrl}
                            className="flex-1 min-w-0 rounded border border-red-950/80 bg-[#12070a] px-2.5 py-1.5 font-mono text-[11px] text-emerald-300"
                          />
                          <button
                            type="button"
                            onClick={() => void copyValue(`up_${dep.id}`, info.uptimeMonitorUrl!)}
                            className="rounded border border-red-950/90 bg-[#12070a] px-2.5 py-1.5 text-[11px] text-slate-200 hover:border-red-500/45 shrink-0"
                          >
                            {copiedKey === `up_${dep.id}` ? (
                              <Check className="h-3.5 w-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => void handleTestMonitor(dep, info.uptimeMonitorUrl!)}
                            className="rounded border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/25 shrink-0"
                          >
                            {busy === 'test' ? '...' : 'Test'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {feedback && (
                  <div
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                      feedback.type === 'success'
                        ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
                        : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
                    }`}
                  >
                    {feedback.type === 'success' ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    )}
                    <span>{feedback.text}</span>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* Non-Node notice if user also runs Python/Docker bots */}
      {nonNodeDeployments.length > 0 && (
        <section className="rounded-lg border border-red-950/70 bg-[#0d0508]/80 px-4 py-3 text-xs text-slate-400 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Server className="h-3.5 w-3.5 text-slate-500" />
            <span>
              {nonNodeDeployments.length} non-Node deployment{nonNodeDeployments.length > 1 ? 's' : ''} ({nonNodeDeployments.map((d) => d.name).join(', ')}) run in worker mode only — custom domains and public links are enabled for Node.js &amp; Bun apps/bots.
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
