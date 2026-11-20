import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Coins,
  Cpu,
  GitBranch,
  Github,
  Layers,
  Rocket,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { EnvVarsEditor } from './EnvVarsEditor';
import {
  DEPLOY_REGIONS,
  DEPLOYMENT_PLANS,
  type AuthUser,
  type BotDeployment,
  type BotPlatform,
  type BotSettings,
  type DeployRegion,
  type DeploymentPlanId,
  type PlatformPreferences,
  type RestartPolicy,
  type RuntimeEnvironment,
} from '../types/lyrihost';

interface CustomRepoDeployViewProps {
  authToken: string;
  currentUser: AuthUser;
  initialPlanId?: DeploymentPlanId;
  preferences: PlatformPreferences;
  onDeployed: (deployment: BotDeployment) => void;
  onOpenTemplates: () => void;
  onOpenCoins: () => void;
}

function deriveRepoInfo(rawInput: string): { repoUrl: string; repoFullName: string; defaultName: string } {
  const trimmed = rawInput.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!trimmed) {
    return { repoUrl: '', repoFullName: '', defaultName: '' };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    const [, repo] = trimmed.split('/');
    return {
      repoUrl: `https://github.com/${trimmed}`,
      repoFullName: trimmed,
      defaultName: repo.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'custom-bot',
    };
  }
  try {
    const normalized = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    const url = new URL(normalized);
    const parts = url.pathname.split('/').filter(Boolean);
    const fullName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : url.hostname;
    const repoPart = parts[1] || parts[0] || 'custom-bot';
    return {
      repoUrl: normalized,
      repoFullName: fullName,
      defaultName: repoPart.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'custom-bot',
    };
  } catch {
    return { repoUrl: trimmed, repoFullName: trimmed, defaultName: 'custom-bot' };
  }
}

export function CustomRepoDeployView({
  authToken,
  currentUser,
  initialPlanId = 'plan_15d',
  preferences,
  onDeployed,
  onOpenTemplates,
  onOpenCoins,
}: CustomRepoDeployViewProps) {
  const [repoInput, setRepoInput] = useState('');
  const [nameEditedManually, setNameEditedManually] = useState(false);

  const [platform, setPlatform] = useState<BotPlatform>('whatsapp');
  const [framework, setFramework] = useState('Node.js Bot');
  const [planId, setPlanId] = useState<DeploymentPlanId>(initialPlanId);

  useEffect(() => {
    if (initialPlanId) {
      setPlanId(initialPlanId);
    }
  }, [initialPlanId]);

  const selectedPlan = DEPLOYMENT_PLANS.find((p) => p.id === planId) ?? DEPLOYMENT_PLANS[0];
  const hasEnoughCoins = currentUser.unlimitedCoins || currentUser.coinBalance >= selectedPlan.coinCost;
  const quotaReached =
    !currentUser.isAdmin && currentUser.activeDeploymentsCount >= currentUser.maxDeployments;

  const [settings, setSettings] = useState<BotSettings>({
    name: '',
    branch: 'main',
    region: preferences.defaultRegion,
    runtime: 'node-20',
    installCommand: 'npm install --legacy-peer-deps --ignore-engines',
    buildCommand: '',
    startCommand: 'npm start',
    computeTier: selectedPlan.computeTier,
    planId: selectedPlan.id,
    restartPolicy: preferences.defaultRestartPolicy,
    autoDeploy: false,
    healthCheckPath: '/health',
    envVars: [
      { key: 'SESSION_ID', value: '', isSecret: true, detectedFrom: 'Bot authentication' },
      { key: 'PREFIX', value: '.', isSecret: false, detectedFrom: 'Command prefix' },
    ],
  });

  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  const handleRepoChange = (val: string) => {
    setRepoInput(val);
    if (!nameEditedManually) {
      const derived = deriveRepoInfo(val);
      setSettings((prev) => ({ ...prev, name: derived.defaultName }));
    }
  };

  const handlePlatformChange = (nextPlatform: BotPlatform) => {
    setPlatform(nextPlatform);
    if (nextPlatform === 'whatsapp') {
      setFramework('WhatsApp MD · Baileys');
    } else if (nextPlatform === 'telegram') {
      setFramework('Telegram Bot');
    } else if (nextPlatform === 'discord') {
      setFramework('Discord Bot');
    } else if (nextPlatform === 'slack') {
      setFramework('Slack Bot');
    } else {
      setFramework('Custom Worker');
    }
  };

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeployError(null);

    const parsed = deriveRepoInfo(repoInput);
    if (!parsed.repoUrl) {
      setDeployError('Please enter a Git repository URL or owner/repo identifier.');
      return;
    }
    const cleanName = settings.name.trim() || parsed.defaultName;
    if (!cleanName) {
      setDeployError('Please enter a name for this bot deployment.');
      return;
    }

    setDeploying(true);
    try {
      const resp = await fetch('/api/deployments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          repoUrl: parsed.repoUrl,
          repoFullName: parsed.repoFullName,
          platform,
          framework,
          commitSha: 'head',
          planId: selectedPlan.id,
          settings: {
            ...settings,
            name: cleanName,
            computeTier: selectedPlan.computeTier,
            planId: selectedPlan.id,
            branch: settings.branch.trim() || 'main',
            installCommand: settings.installCommand.trim(),
            buildCommand: settings.buildCommand.trim(),
            startCommand: settings.startCommand.trim() || 'npm start',
          },
          scanReport: null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Deployment failed to start.');
      }
      onDeployed(data as BotDeployment);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : 'Failed to deploy custom repository.');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="atelier-panel relative rounded-lg border border-red-500/25 p-5 sm:p-6">
        <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70" />
        <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70" />

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-50">
              Custom Git Repository <span className="italic font-medium text-red-400">Deployment</span>
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Clone and launch any Git repository directly with custom build commands, environment variables, and ENOTEMPTY session protection.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenTemplates}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#0d0508] px-3 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-red-500/40 hover:text-slate-100 whitespace-nowrap shrink-0"
            >
              <Layers className="h-3.5 w-3.5 text-red-400" />
              Browse Bot Templates
            </button>
          </div>
        </div>
      </section>

      <form
        onSubmit={handleDeploy}
        className="atelier-panel rounded-lg border border-red-500/30 p-5 sm:p-6 space-y-6"
      >
        {/* Hosting Plan & RAM Selector */}
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-200">
              Hosting Plan &amp; Dedicated RAM (1 Coin = 1 KSH)
            </span>
            <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums">
              <span className="text-slate-400">
                Quota:{' '}
                <span className="text-slate-200">
                  {currentUser.activeDeploymentsCount}/
                  {currentUser.isAdmin ? '∞' : currentUser.maxDeployments}
                </span>
              </span>
              <span className="text-rose-300">
                Balance:{' '}
                {currentUser.unlimitedCoins ? 'Unlimited' : `${currentUser.coinBalance} Coins`}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {DEPLOYMENT_PLANS.map((plan) => {
              const active = plan.id === selectedPlan.id;
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => {
                    setPlanId(plan.id);
                    setSettings((prev) => ({
                      ...prev,
                      planId: plan.id,
                      computeTier: plan.computeTier,
                    }));
                  }}
                  className={`rounded-md border p-3.5 text-left transition-colors ${
                    active
                      ? 'border-red-500/70 bg-red-600/15'
                      : 'border-red-950/90 bg-[#080305] hover:border-red-500/40'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-display text-base font-semibold text-slate-100">
                      {plan.name}
                    </span>
                    <span className="font-mono text-xs font-semibold text-rose-300 tabular-nums">
                      {plan.coinCost} Coins
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-emerald-400 tabular-nums">
                    <Cpu className="h-3 w-3" />
                    <span>{plan.memoryLimitMb} MB RAM</span>
                    <span aria-hidden="true">·</span>
                    <span>{plan.durationLabel}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{plan.summary}</p>
                </button>
              );
            })}
          </div>

          {(!hasEnoughCoins || quotaReached) && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
              <span>
                {quotaReached
                  ? `You reached your deployment cap (${currentUser.maxDeployments}). Submit a request via Support to increase it.`
                  : `Insufficient coins for ${selectedPlan.name} (${selectedPlan.coinCost} Coins required).`}
              </span>
              {!hasEnoughCoins && (
                <button
                  type="button"
                  onClick={onOpenCoins}
                  className="inline-flex items-center gap-1 rounded bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-500"
                >
                  <Coins className="h-3 w-3" />
                  Buy Coins
                </button>
              )}
            </div>
          )}
        </div>

        {/* Repository Source */}
        <div className="grid grid-cols-1 gap-4 border-t border-red-950/70 pt-5 md:grid-cols-12">
          <div className="md:col-span-6">
            <label className="block text-xs font-medium text-slate-300">
              Git Repository URL or <span className="font-mono text-rose-300">owner/repo</span>
            </label>
            <div className="relative mt-1.5">
              <Github className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-red-400" />
              <input
                type="text"
                value={repoInput}
                onChange={(e) => handleRepoChange(e.target.value)}
                placeholder="https://github.com/username/my-bot-repo"
                className="w-full rounded-md border border-red-900/80 bg-[#080305] py-2 pl-9 pr-3 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
              />
            </div>
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-medium text-slate-300">Bot Service Name</label>
            <input
              type="text"
              value={settings.name}
              onChange={(e) => {
                setNameEditedManually(true);
                setSettings({ ...settings, name: e.target.value });
              }}
              placeholder="my-custom-bot"
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
            />
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-medium text-slate-300">Git Branch</label>
            <div className="relative mt-1.5">
              <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-rose-400" />
              <input
                type="text"
                value={settings.branch}
                onChange={(e) => setSettings({ ...settings, branch: e.target.value })}
                placeholder="main"
                className="w-full rounded-md border border-red-950/90 bg-[#080305] py-2 pl-9 pr-3 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Platform & Cluster Settings */}
        <div className="grid grid-cols-1 gap-4 border-t border-red-950/70 pt-5 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="block text-xs font-medium text-slate-300">Platform</label>
            <select
              value={platform}
              onChange={(e) => handlePlatformChange(e.target.value as BotPlatform)}
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            >
              <option value="whatsapp">WhatsApp MD</option>
              <option value="telegram">Telegram</option>
              <option value="discord">Discord</option>
              <option value="slack">Slack</option>
              <option value="custom">Custom Worker</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300">Runtime</label>
            <select
              value={settings.runtime}
              onChange={(e) =>
                setSettings({ ...settings, runtime: e.target.value as RuntimeEnvironment })
              }
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            >
              <option value="node-20">Node.js 20 LTS</option>
              <option value="node-22">Node.js 22 Current</option>
              <option value="bun-1">Bun 1.1</option>
              <option value="python-3.12">Python 3.12</option>
              <option value="docker">Dockerfile</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300">Deploy Region</label>
            <select
              value={settings.region}
              onChange={(e) => setSettings({ ...settings, region: e.target.value as DeployRegion })}
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
            <label className="block text-xs font-medium text-slate-300">Restart Policy</label>
            <select
              value={settings.restartPolicy}
              onChange={(e) =>
                setSettings({ ...settings, restartPolicy: e.target.value as RestartPolicy })
              }
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            >
              <option value="always">Always restart</option>
              <option value="on-failure">On failure only</option>
              <option value="never">Never auto-restart</option>
            </select>
          </div>
        </div>

        {/* Install / Build / Start Commands */}
        <div className="grid grid-cols-1 gap-4 border-t border-red-950/70 pt-5 md:grid-cols-3">
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <Layers className="h-3.5 w-3.5 text-rose-400" />
              Install Command
            </label>
            <input
              type="text"
              value={settings.installCommand}
              onChange={(e) => setSettings({ ...settings, installCommand: e.target.value })}
              placeholder="npm install --legacy-peer-deps"
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <Cpu className="h-3.5 w-3.5 text-rose-400" />
              Build Command (optional)
            </label>
            <input
              type="text"
              value={settings.buildCommand}
              onChange={(e) => setSettings({ ...settings, buildCommand: e.target.value })}
              placeholder="npm run build"
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <Terminal className="h-3.5 w-3.5 text-red-400" />
              Start Command
            </label>
            <input
              type="text"
              value={settings.startCommand}
              onChange={(e) => setSettings({ ...settings, startCommand: e.target.value })}
              placeholder="npm start"
              className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
            />
          </div>
        </div>

        {/* Environment Variables */}
        <div className="border-t border-red-950/70 pt-5">
          <EnvVarsEditor
            envVars={settings.envVars}
            onChange={(envVars) => setSettings({ ...settings, envVars })}
          />
        </div>

        {deployError && (
          <div className="flex items-start gap-2.5 rounded-md border border-red-500/50 bg-red-500/15 p-3 text-xs text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <span>{deployError}</span>
          </div>
        )}

        <div className="flex flex-col-reverse gap-3 border-t border-red-950/70 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <span>
              Allocates{' '}
              <span className="font-mono text-emerald-400">{selectedPlan.memoryLimitMb} MB RAM</span>{' '}
              ({selectedPlan.durationLabel}) ·{' '}
              <span className="font-mono text-rose-300">{settings.region}</span>
            </span>
          </div>
          <button
            type="submit"
            disabled={deploying}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-5 py-2 text-xs font-semibold text-white shadow-[0_1px_12px_rgba(220,38,38,0.28)] transition-all hover:from-red-500 hover:to-red-600 disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            <Rocket className="h-3.5 w-3.5" />
            {deploying
              ? 'Cloning & Launching...'
              : `Deploy (${currentUser.unlimitedCoins ? 'Unlimited' : `${selectedPlan.coinCost} Coins`})`}
          </button>
        </div>
      </form>
    </div>
  );
}
