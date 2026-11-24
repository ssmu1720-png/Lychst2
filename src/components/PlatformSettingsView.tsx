import { useState } from 'react';
import { type User } from 'firebase/auth';
import {
  AlertTriangle,
  Check,
  Cloud,
  CloudOff,
  Database,
  Globe,
  LogOut,
  Mail,
  MessageSquare,
  RefreshCw,
  RotateCw,
  Shield,
  Sliders,
  UserCheck,
} from 'lucide-react';
import { FIRESTORE_DATABASE_ID } from '../lib/firebase';
import type { CloudDeploymentSpec } from '../lib/firestoreStore';
import {
  DEPLOY_REGIONS,
  type AuthUser,
  type DeployRegion,
  type PlatformPreferences,
  type RestartPolicy,
  type RuntimeEnvironment,
} from '../types/lyrihost';

interface PlatformSettingsViewProps {
  authToken: string;
  currentUser: AuthUser;
  preferences: PlatformPreferences;
  firebaseUser: User | null;
  cloudDeployments: CloudDeploymentSpec[];
  cloudSyncing: boolean;
  cloudNotice: { type: 'success' | 'error'; text: string } | null;
  onConnectCloudSync: () => Promise<void>;
  onDisconnectCloudSync: () => Promise<void>;
  onSyncCloudNow: () => Promise<void>;
  onRestoreCloudDeployment: (spec: CloudDeploymentSpec) => Promise<void>;
  onUpdated: (next: PlatformPreferences) => void;
  onUserRefresh: () => Promise<void>;
  onOpenSupport: () => void;
  onLogout: () => void;
}

export function PlatformSettingsView({
  authToken,
  currentUser,
  preferences,
  firebaseUser,
  cloudDeployments,
  cloudSyncing,
  cloudNotice,
  onConnectCloudSync,
  onDisconnectCloudSync,
  onSyncCloudNow,
  onRestoreCloudDeployment,
  onUpdated,
  onUserRefresh,
  onOpenSupport,
  onLogout,
}: PlatformSettingsViewProps) {
  const [defaultRegion, setDefaultRegion] = useState<DeployRegion>(preferences.defaultRegion);
  const [defaultRestartPolicy, setDefaultRestartPolicy] = useState<RestartPolicy>(
    preferences.defaultRestartPolicy
  );
  const [defaultRuntime, setDefaultRuntime] = useState<RuntimeEnvironment>(
    preferences.defaultRuntime ?? 'node-20'
  );
  const [telemetryCadenceSec, setTelemetryCadenceSec] = useState<2 | 5 | 10>(
    preferences.telemetryCadenceSec ?? 2
  );
  const [compactFleetCards, setCompactFleetCards] = useState<boolean>(
    preferences.compactFleetCards ?? false
  );
  const [deployAlertEmails, setDeployAlertEmails] = useState<boolean>(
    preferences.deployAlertEmails ?? true
  );
  const [autoClearStoppedLogs, setAutoClearStoppedLogs] = useState<boolean>(
    preferences.autoClearStoppedLogs ?? false
  );
  const [matrixIntensity, setMatrixIntensity] = useState<PlatformPreferences['matrixIntensity']>(
    preferences.matrixIntensity
  );
  const [webhookSecret, setWebhookSecret] = useState(preferences.webhookSecret);
  const [promoEmailsOptIn, setPromoEmailsOptIn] = useState<boolean>(
    preferences.promoEmailsOptIn ?? currentUser.promoEmailsOptIn
  );
  const [lowCoinAlertThreshold, setLowCoinAlertThreshold] = useState<number>(
    preferences.lowCoinAlertThreshold ?? 10
  );
  const [railwayDomain, setRailwayDomain] = useState<string>(
    preferences.railwayDomain ?? ''
  );
  const [platformWildcardDomain, setPlatformWildcardDomain] = useState<string>(
    preferences.platformWildcardDomain ?? ''
  );

  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const savePreferences = async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      const resp = await fetch('/api/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          defaultRegion,
          defaultRestartPolicy,
          defaultRuntime,
          telemetryCadenceSec,
          compactFleetCards,
          deployAlertEmails,
          autoClearStoppedLogs,
          matrixIntensity,
          webhookSecret,
          promoEmailsOptIn,
          lowCoinAlertThreshold,
          ...(currentUser.isAdmin ? { railwayDomain, platformWildcardDomain } : {}),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to update settings.');
      onUpdated(data as PlatformPreferences);
      await onUserRefresh();
      setStatusMsg({ type: 'success', text: 'Platform & user preferences saved permanently to database.' });
    } catch (err) {
      setStatusMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to save settings.',
      });
    } finally {
      setSaving(false);
    }
  };

  const regenerateWebhook = () => {
    const chars = 'abcdef0123456789';
    let token = 'lh_wh_';
    for (let i = 0; i < 24; i++) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
    setWebhookSecret(token);
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Account Session & Prominent Log Out Bar */}
      <section className="atelier-panel relative rounded-lg border border-red-500/30 p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70" />
        <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70" />

        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-red-500/35 bg-red-500/10">
            <UserCheck className="h-4 w-4 text-red-400" />
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-100">Active Operator Session</div>
            <div className="mt-0.5 font-mono text-xs text-rose-300">{currentUser.email}</div>
            <div className="mt-1 text-[11px] text-slate-400">
              {currentUser.isAdmin ? 'Root Administrator · Unlimited Coins' : `Balance: ${currentUser.coinBalance} Coins · Referral Code: ${currentUser.referralCode}`}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-red-500/50 bg-red-600/20 px-4 py-2 text-xs font-semibold text-red-100 transition-colors hover:bg-red-600/35 whitespace-nowrap shrink-0"
        >
          <LogOut className="h-3.5 w-3.5 text-red-400" />
          Log Out of Account
        </button>
      </section>

      {/* Cloud Firestore Durable Persistence */}
      <section className="atelier-panel relative rounded-lg border border-red-500/25 p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-red-950/70 pb-3.5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-red-500/35 bg-red-500/10">
              <Database className="h-4 w-4 text-red-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Cloud Durable Database (Firestore)
              </h2>
              <p className="mt-0.5 text-[11px] text-slate-400">
                Persist your profile preferences, bot deployment configurations, and complaints permanently in Cloud Firestore ({FIRESTORE_DATABASE_ID}) across container redeploys.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {firebaseUser ? (
              <>
                <button
                  type="button"
                  disabled={cloudSyncing}
                  onClick={() => void onSyncCloudNow()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-60"
                >
                  <RotateCw className={`h-3.5 w-3.5 ${cloudSyncing ? 'animate-spin' : ''}`} />
                  {cloudSyncing ? 'Syncing...' : 'Sync Now'}
                </button>
                <button
                  type="button"
                  onClick={() => void onDisconnectCloudSync()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-red-500/40 hover:text-red-200"
                >
                  <CloudOff className="h-3.5 w-3.5 text-red-400" />
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={cloudSyncing}
                onClick={() => void onConnectCloudSync()}
                className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-3.5 py-1.5 text-xs font-semibold text-white shadow-[0_1px_10px_rgba(220,38,38,0.28)] hover:from-red-500 hover:to-red-600 disabled:opacity-60"
              >
                <Cloud className="h-3.5 w-3.5" />
                {cloudSyncing ? 'Connecting...' : 'Connect Google Cloud Sync'}
              </button>
            )}
          </div>
        </div>

        {firebaseUser && (
          <div className="rounded-md border border-red-950/80 bg-[#080305] px-3.5 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-300">
              Connected Google Identity:{' '}
              <span className="font-mono text-emerald-300">{firebaseUser.email}</span>
            </span>
            <span className="font-mono text-[11px] text-slate-400">
              {cloudDeployments.length} cloud deployment backup{cloudDeployments.length === 1 ? '' : 's'}
            </span>
          </div>
        )}

        {cloudNotice && (
          <div
            className={`flex items-center gap-2 rounded-md border p-2.5 text-xs ${
              cloudNotice.type === 'error'
                ? 'border-red-500/45 bg-red-500/15 text-red-200'
                : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            {cloudNotice.type === 'error' ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            )}
            <span>{cloudNotice.text}</span>
          </div>
        )}

        {firebaseUser && cloudDeployments.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] font-medium text-slate-300">
              Cloud-Backed Deployment Specs
            </div>
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {cloudDeployments.map((spec) => (
                <div
                  key={spec.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-950/80 bg-[#080305] px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-slate-100 truncate">{spec.name}</div>
                    <div className="font-mono text-[11px] text-slate-400 truncate">
                      {spec.repoFullName} · {spec.runtime} · {spec.region}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void onRestoreCloudDeployment(spec)}
                    className="rounded border border-red-500/40 bg-red-600/20 px-2.5 py-1 text-[11px] font-semibold text-red-200 hover:bg-red-600/35 whitespace-nowrap shrink-0"
                  >
                    Re-deploy Spec
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Main Platform & App Settings */}
      <section className="atelier-panel relative rounded-lg border border-red-500/25 p-5 sm:p-6 space-y-5">
        <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70" />
        <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70" />

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-950/70 pb-4">
          <div className="flex items-center gap-3">
            <Sliders className="h-4 w-4 text-red-400" />
            <div>
              <h1 className="font-display text-2xl font-semibold text-slate-50">
                App &amp; Platform <span className="italic font-medium text-red-400">Settings</span>
              </h1>
              <p className="text-xs text-slate-400">
                Configure deployment runtimes, telemetry cadence, fleet density, alert notifications, and webhook security.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenSupport}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-red-500/20 whitespace-nowrap shrink-0"
          >
            <MessageSquare className="h-3.5 w-3.5 text-red-400" />
            Admin Complaints
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-[11px] font-medium text-slate-300">Default Deploy Region</label>
            <select
              value={defaultRegion}
              onChange={(e) => setDefaultRegion(e.target.value as DeployRegion)}
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            >
              {DEPLOY_REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300">Default Restart Policy</label>
            <select
              value={defaultRestartPolicy}
              onChange={(e) => setDefaultRestartPolicy(e.target.value as RestartPolicy)}
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            >
              <option value="always">Always restart on exit</option>
              <option value="on-failure">Restart on failure only</option>
              <option value="never">Never auto-restart</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300">Default Bot Runtime</label>
            <select
              value={defaultRuntime}
              onChange={(e) => setDefaultRuntime(e.target.value as RuntimeEnvironment)}
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            >
              <option value="node-20">Node.js 20 LTS</option>
              <option value="node-22">Node.js 22 Current</option>
              <option value="python-3.12">Python 3.12</option>
              <option value="bun-1">Bun 1.x</option>
              <option value="docker">Docker Container</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300">Telemetry Refresh Cadence</label>
            <select
              value={telemetryCadenceSec}
              onChange={(e) => setTelemetryCadenceSec(Number(e.target.value) as 2 | 5 | 10)}
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            >
              <option value={2}>Real-time (Every 2 seconds)</option>
              <option value={5}>Balanced (Every 5 seconds)</option>
              <option value={10}>Low-bandwidth (Every 10 seconds)</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 border-t border-red-950/70 pt-4 sm:grid-cols-2">
          <div>
            <label className="block text-[11px] font-medium text-slate-300 mb-2">
              Matrix Backdrop Intensity
            </label>
            <div className="inline-flex items-center gap-0.5 rounded-md border border-red-950/80 bg-[#080305] p-0.5">
              {(['full', 'subtle', 'off'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setMatrixIntensity(mode)}
                  className={`rounded px-3.5 py-1 text-[11px] font-semibold capitalize transition-colors ${
                    matrixIntensity === mode
                      ? 'bg-red-600/25 text-red-200 border border-red-500/45'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300">
              Low Coin Alert Threshold (Coins)
            </label>
            <input
              type="number"
              min={0}
              max={10000}
              value={lowCoinAlertThreshold}
              onChange={(e) => setLowCoinAlertThreshold(Number(e.target.value || 0))}
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 font-mono text-xs text-slate-100 tabular-nums focus:border-red-400 focus:outline-none"
            />
          </div>
        </div>

        <div className="space-y-3 border-t border-red-950/70 pt-4">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={promoEmailsOptIn}
              onChange={(e) => setPromoEmailsOptIn(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-red-600"
            />
            <span className="text-xs text-slate-300">
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-100">
                <Mail className="h-3.5 w-3.5 text-red-400" />
                Receive Lyrihost Promotional &amp; Update Emails
              </span>
              <span className="mt-0.5 block text-[11px] text-slate-400">
                Allow Lyrihost announcements, coupon codes, and cluster update alerts to be delivered to {currentUser.email}.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={deployAlertEmails}
              onChange={(e) => setDeployAlertEmails(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-red-600"
            />
            <span className="text-xs text-slate-300">
              <span className="font-medium text-slate-100">Deployment Crash &amp; Plan Expiry Alerts</span>
              <span className="mt-0.5 block text-[11px] text-slate-400">
                Notify me when a running bot stops unexpectedly or its 15-day/30-day coin plan is about to expire.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={compactFleetCards}
              onChange={(e) => setCompactFleetCards(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-red-600"
            />
            <span className="text-xs text-slate-300">
              <span className="font-medium text-slate-100">Compact Bot Fleet Density</span>
              <span className="mt-0.5 block text-[11px] text-slate-400">
                Display tighter deployment rows on the dashboard for managing large bot fleets.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={autoClearStoppedLogs}
              onChange={(e) => setAutoClearStoppedLogs(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-red-600"
            />
            <span className="text-xs text-slate-300">
              <span className="font-medium text-slate-100">Trim Stale Runtime Logs on Stop</span>
              <span className="mt-0.5 block text-[11px] text-slate-400">
                Keep only the latest 50 runtime entries in inspector when stopping an instance manually.
              </span>
            </span>
          </label>
        </div>

        {currentUser.isAdmin && (
          <div className="border-t border-red-950/70 pt-4 space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Globe className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-xs font-semibold text-slate-100">
                    Railway Service Domain (Node Apps &amp; Bots)
                  </span>
                </div>
                <span className="font-mono text-[10px] text-emerald-300">
                  *.up.railway.app
                </span>
              </div>
              <input
                type="text"
                value={railwayDomain}
                onChange={(e) => setRailwayDomain(e.target.value)}
                placeholder="lyrihost-production.up.railway.app"
                className="w-full rounded-md border border-red-950/80 bg-[#080305] px-3 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-400 focus:outline-none"
              />
              <p className="text-[11px] text-slate-400">
                Auto-detected from <code className="font-mono text-emerald-300">RAILWAY_PUBLIC_DOMAIN</code> when deployed on Railway, or enter your <code className="font-mono text-slate-300">.up.railway.app</code> domain here. All Node app links (<code className="font-mono text-rose-300">/app/&lt;slug&gt;/</code>), UptimeRobot URLs, and DNS CNAME instructions use this domain.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Globe className="h-3.5 w-3.5 text-red-400" />
                <span className="text-xs font-semibold text-slate-100">
                  Platform Wildcard Domain (Optional · Subdomains)
                </span>
              </div>
              <input
                type="text"
                value={platformWildcardDomain}
                onChange={(e) => setPlatformWildcardDomain(e.target.value)}
                placeholder="lyrihost.site"
                className="w-full rounded-md border border-red-950/80 bg-[#080305] px-3 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
              />
              <p className="text-[11px] text-slate-400">
                When configured alongside <code className="font-mono text-rose-300">*.yourdomain</code> on Railway, every Node app &amp; bot also gets a <code className="font-mono text-emerald-300">&lt;slug&gt;.yourdomain</code> subdomain in addition to its Railway <code className="font-mono text-slate-300">/app/&lt;slug&gt;/</code> link.
              </p>
            </div>
          </div>
        )}

        <div className="border-t border-red-950/70 pt-4 space-y-2">
          <div className="flex items-center gap-2">
            <Shield className="h-3.5 w-3.5 text-red-400" />
            <span className="text-xs font-semibold text-slate-100">GitHub Webhook Secret</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              readOnly
              value={webhookSecret}
              className="flex-1 rounded-md border border-red-950/80 bg-[#080305] px-3 py-1.5 font-mono text-xs text-red-300"
            />
            <button
              type="button"
              onClick={regenerateWebhook}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-rose-200 hover:bg-red-500/20 whitespace-nowrap shrink-0"
            >
              <RefreshCw className="h-3 w-3" />
              Rotate Secret
            </button>
          </div>
        </div>

        {statusMsg && (
          <div
            className={`flex items-center gap-2 rounded-md border p-2.5 text-xs ${
              statusMsg.type === 'error'
                ? 'border-red-500/45 bg-red-500/15 text-red-200'
                : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            {statusMsg.type === 'error' ? (
              <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
            ) : (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            )}
            <span>{statusMsg.text}</span>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-red-950/70 pt-4">
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#080305] px-3.5 py-2 text-xs font-medium text-slate-300 hover:border-red-500/45 hover:text-red-200"
          >
            <LogOut className="h-3.5 w-3.5 text-red-400" />
            Log Out
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void savePreferences()}
            className="rounded-md bg-gradient-to-b from-red-600 to-red-700 px-4 py-2 text-xs font-semibold text-white shadow-[0_1px_10px_rgba(220,38,38,0.28)] transition-all hover:from-red-500 hover:to-red-600 disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Save Platform Settings'}
          </button>
        </div>
      </section>
    </div>
  );
}
