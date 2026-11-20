import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Coins,
  Cpu,
  ExternalLink,
  GitBranch,
  Github,
  KeyRound,
  Layers,
  Rocket,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import { TEMPLATE_BOTS, type TemplateBotSpec } from '../catalog/templateBots';
import { TEMPLATE_BOT_IMAGES } from '../catalog/templateImages';
import {
  DEPLOY_REGIONS,
  DEPLOYMENT_PLANS,
  type AuthUser,
  type BotDeployment,
  type BotSettings,
  type DeployRegion,
  type DeploymentPlanId,
  type EnvVarEntry,
  type PlatformPreferences,
  type RestartPolicy,
} from '../types/lyrihost';

interface TemplatesViewProps {
  authToken: string;
  currentUser: AuthUser;
  initialPlanId?: DeploymentPlanId;
  preferences: PlatformPreferences;
  onOpenCustomDeploy: () => void;
  onOpenCoins: () => void;
  onDeployed: (deployment: BotDeployment) => void;
}

export function TemplatesView({
  authToken,
  currentUser,
  initialPlanId = 'plan_15d',
  preferences,
  onOpenCustomDeploy,
  onOpenCoins,
  onDeployed,
}: TemplatesViewProps) {
  const [templates, setTemplates] = useState<TemplateBotSpec[]>(TEMPLATE_BOTS);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateBotSpec | null>(null);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});

  const [botName, setBotName] = useState('');
  const [branch, setBranch] = useState('main');
  const [region, setRegion] = useState<DeployRegion>(preferences.defaultRegion);
  const [planId, setPlanId] = useState<DeploymentPlanId>(initialPlanId);
  const [restartPolicy, setRestartPolicy] = useState<RestartPolicy>(preferences.defaultRestartPolicy);
  const [installCmd, setInstallCmd] = useState('npm install --legacy-peer-deps --ignore-engines');
  const [startCmd, setStartCmd] = useState('npm start');
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/templates')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && Array.isArray(data) && data.length > 0) {
          setTemplates(data as TemplateBotSpec[]);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (initialPlanId) {
      setPlanId(initialPlanId);
    }
  }, [initialPlanId]);

  const selectedPlan = DEPLOYMENT_PLANS.find((p) => p.id === planId) ?? DEPLOYMENT_PLANS[0];
  const hasEnoughCoins = currentUser.unlimitedCoins || currentUser.coinBalance >= selectedPlan.coinCost;
  const quotaReached =
    !currentUser.isAdmin && currentUser.activeDeploymentsCount >= currentUser.maxDeployments;

  const filteredTemplates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.repoFullName.toLowerCase().includes(q) ||
        t.sessionPairHost.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }, [searchQuery, templates]);

  const openQuickDeploy = (tpl: TemplateBotSpec) => {
    setSelectedTemplate(tpl);
    setBotName(tpl.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
    setBranch(tpl.defaultBranch);
    setRegion(preferences.defaultRegion);
    setPlanId(initialPlanId || 'plan_15d');
    setRestartPolicy(preferences.defaultRestartPolicy);
    setInstallCmd(tpl.installCommand);
    setStartCmd(tpl.startCommand);
    const initialEnv: Record<string, string> = {};
    for (const field of tpl.defaultEnvVars) {
      initialEnv[field.key] = field.key === 'PREFIX' ? '.' : '';
    }
    setEnvValues(initialEnv);
    setDeployError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleQuickDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTemplate) return;

    const cleanName = botName.trim();
    if (!cleanName) {
      setDeployError('Please enter a service name for this bot deployment.');
      return;
    }

    setDeploying(true);
    setDeployError(null);

    try {
      const envVars: EnvVarEntry[] = selectedTemplate.defaultEnvVars
        .map((field) => ({
          key: field.key,
          value: (envValues[field.key] || '').trim(),
          isSecret: field.isSecret,
          detectedFrom: `${selectedTemplate.name} template`,
        }))
        .filter((entry) => entry.value.length > 0);

      const settings: BotSettings = {
        name: cleanName,
        branch: branch.trim() || selectedTemplate.defaultBranch,
        region,
        runtime: selectedTemplate.runtime,
        installCommand: installCmd.trim() || selectedTemplate.installCommand,
        buildCommand: selectedTemplate.buildCommand,
        startCommand: startCmd.trim() || selectedTemplate.startCommand,
        computeTier: selectedPlan.computeTier,
        planId: selectedPlan.id,
        restartPolicy,
        autoDeploy: false,
        healthCheckPath: '/health',
        envVars,
      };

      const resp = await fetch('/api/deployments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          repoUrl: selectedTemplate.repoUrl,
          repoFullName: selectedTemplate.repoFullName,
          platform: selectedTemplate.platform,
          framework: selectedTemplate.framework,
          commitSha: 'head',
          planId: selectedPlan.id,
          settings,
          scanReport: null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to launch template bot.');
      }
      onDeployed(data as BotDeployment);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : 'Unable to deploy template bot.');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Search Toolbar */}
      <section className="atelier-panel relative rounded-lg border border-red-500/25 p-5 sm:p-6">
        <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70" />
        <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70" />

        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-50">
              Verified Bot <span className="italic font-medium text-red-400">Templates</span>
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">
              Curated WhatsApp Multi-Device bot repositories paired with their official session generators and protected by the runtime <span className="font-mono text-rose-300">ENOTEMPTY</span> session guard.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <div className="relative w-full md:w-64 shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter templates or repos..."
                className="w-full rounded-md border border-red-950/90 bg-[#080305] py-2 pl-9 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-red-400 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={onOpenCustomDeploy}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-500/35 bg-red-500/10 px-3.5 py-2 text-xs font-medium text-rose-200 transition-colors hover:bg-red-500/20 whitespace-nowrap shrink-0"
            >
              <Github className="h-3.5 w-3.5 text-red-400" />
              Custom Repo
            </button>
          </div>
        </div>
      </section>

      {/* Quick Deploy Panel for Selected Template */}
      {selectedTemplate && (
        <section className="atelier-panel rounded-lg border border-red-500/40 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-red-950/70 pb-4">
            <div className="flex items-center gap-4">
              <div className="hidden h-14 w-24 shrink-0 overflow-hidden rounded-md border border-red-500/30 bg-[#0a0406] sm:block">
                {brokenImages[selectedTemplate.id] ? (
                  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#26090e] to-[#0a0406]">
                    <Bot className="h-5 w-5 text-red-400/70" />
                  </div>
                ) : (
                  <img
                    src={TEMPLATE_BOT_IMAGES[selectedTemplate.id] || selectedTemplate.imageUrl}
                    alt={selectedTemplate.imageAlt}
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setBrokenImages((prev) => ({ ...prev, [selectedTemplate.id]: true }))
                    }
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="font-mono text-rose-300">{selectedTemplate.repoFullName}</span>
                  <span aria-hidden="true">·</span>
                  <span>{selectedTemplate.framework}</span>
                </div>
                <h2 className="mt-1 font-display text-xl font-semibold text-slate-50">
                  Launch {selectedTemplate.name}
                </h2>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {selectedTemplate.sessionPairUrl && (
                <a
                  href={selectedTemplate.sessionPairUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition-colors hover:bg-red-500/20 whitespace-nowrap shrink-0"
                >
                  <KeyRound className="h-3.5 w-3.5 text-red-400" />
                  Open Session Pairer
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              <button
                type="button"
                onClick={() => setSelectedTemplate(null)}
                aria-label="Close quick deploy panel"
                className="rounded-md border border-red-950/80 p-1.5 text-slate-400 hover:border-red-500/40 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <form onSubmit={handleQuickDeploy} className="mt-5 space-y-5">
            {/* Hosting Plan & RAM Selector */}
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium text-slate-200">
                  Select Coin Hosting Plan &amp; RAM Tier (1 Coin = 1 KSH)
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
                      onClick={() => setPlanId(plan.id)}
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
                      ? `You reached your bot deployment limit (${currentUser.maxDeployments}). Contact admin via Support to raise your quota.`
                      : `Insufficient coins for ${selectedPlan.name} (${selectedPlan.coinCost} Coins needed).`}
                  </span>
                  {!hasEnoughCoins && (
                    <button
                      type="button"
                      onClick={onOpenCoins}
                      className="inline-flex items-center gap-1 rounded bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-500"
                    >
                      <Coins className="h-3 w-3" />
                      Top Up on Coins Page
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-slate-300">Bot Service Name</label>
                <input
                  type="text"
                  value={botName}
                  onChange={(e) => setBotName(e.target.value)}
                  className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 focus:border-red-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300">Git Branch</label>
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300">Deploy Region</label>
                <select
                  value={region}
                  onChange={(e) => setRegion(e.target.value as DeployRegion)}
                  className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
                >
                  {DEPLOY_REGIONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {selectedTemplate.defaultEnvVars.map((field) => (
                <div key={field.key}>
                  <label className="flex items-center justify-between text-xs font-medium text-slate-300">
                    <span>{field.label}</span>
                    <span className="font-mono text-[10px] text-rose-300">{field.key}</span>
                  </label>
                  <input
                    type={field.isSecret ? 'password' : 'text'}
                    value={envValues[field.key] ?? ''}
                    onChange={(e) =>
                      setEnvValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                    className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                  />
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-4 border-t border-red-950/70 pt-4 md:grid-cols-3">
              <div>
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
                  <Layers className="h-3.5 w-3.5 text-rose-400" />
                  Install Command
                </label>
                <input
                  type="text"
                  value={installCmd}
                  onChange={(e) => setInstallCmd(e.target.value)}
                  className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 font-mono text-xs text-slate-200 focus:border-red-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
                  <Terminal className="h-3.5 w-3.5 text-red-400" />
                  Start Command
                </label>
                <input
                  type="text"
                  value={startCmd}
                  onChange={(e) => setStartCmd(e.target.value)}
                  className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 font-mono text-xs text-slate-200 focus:border-red-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
                  <GitBranch className="h-3.5 w-3.5 text-rose-400" />
                  Restart Policy
                </label>
                <select
                  value={restartPolicy}
                  onChange={(e) => setRestartPolicy(e.target.value as RestartPolicy)}
                  className="mt-1.5 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 text-xs text-slate-200 focus:border-red-400 focus:outline-none"
                >
                  <option value="always">Always restart on exit</option>
                  <option value="on-failure">Restart on failure only</option>
                  <option value="never">Never auto-restart</option>
                </select>
              </div>
            </div>

            {deployError && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/50 bg-red-500/15 p-3 text-xs text-red-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <span>{deployError}</span>
              </div>
            )}

            <div className="flex flex-col-reverse gap-3 border-t border-red-950/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                <span>
                  Allocates{' '}
                  <span className="font-mono text-emerald-400">{selectedPlan.memoryLimitMb} MB RAM</span>{' '}
                  ({selectedPlan.durationLabel}) ·{' '}
                  {currentUser.unlimitedCoins ? 'Admin Free' : `${selectedPlan.coinCost} Coins`}
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  type="submit"
                  disabled={deploying}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  <Rocket className="h-3.5 w-3.5" />
                  {deploying
                    ? 'Cloning & Launching...'
                    : `Deploy (${currentUser.unlimitedCoins ? 'Unlimited' : `${selectedPlan.coinCost} Coins`})`}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {/* 8 Template Bot Picture Cards */}
      {filteredTemplates.length === 0 ? (
        <div className="atelier-panel rounded-lg border border-red-950/80 px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No template bots match your search filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {filteredTemplates.map((tpl) => {
            const isSelected = selectedTemplate?.id === tpl.id;
            const imgSrc = TEMPLATE_BOT_IMAGES[tpl.id] || tpl.imageUrl;
            const isBroken = Boolean(brokenImages[tpl.id]);

            return (
              <article
                key={tpl.id}
                className={`atelier-panel group flex flex-col justify-between overflow-hidden rounded-lg border transition-colors ${
                  isSelected
                    ? 'border-red-500/70'
                    : 'border-red-950/90 hover:border-red-500/45'
                }`}
              >
                <div>
                  {/* Picture Header with Measured Scrim */}
                  <div className="relative aspect-[16/9] w-full overflow-hidden border-b border-red-950/80 bg-[#090305]">
                    {isBroken ? (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#290910] via-[#120508] to-[#080204]">
                        <Bot className="h-8 w-8 text-red-400/70" />
                        <span className="font-display text-sm font-medium text-slate-300">
                          {tpl.name}
                        </span>
                      </div>
                    ) : (
                      <img
                        src={imgSrc}
                        alt={tpl.imageAlt}
                        referrerPolicy="no-referrer"
                        onError={() =>
                          setBrokenImages((prev) => ({ ...prev, [tpl.id]: true }))
                        }
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                      />
                    )}
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0d0508] via-[#0d0508]/35 to-transparent"
                    />
                    <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 px-4 pb-3">
                      <div className="min-w-0">
                        <h2 className="truncate font-display text-xl font-semibold text-slate-50 drop-shadow-sm">
                          {tpl.name}
                        </h2>
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-300">
                          <span>{tpl.framework}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-rose-200">{tpl.defaultBranch}</span>
                        </div>
                      </div>
                      <a
                        href={tpl.repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={`View ${tpl.repoFullName} on GitHub`}
                        className="inline-flex items-center gap-1 rounded bg-[#0a0406]/85 px-2 py-1 font-mono text-[10px] text-rose-200 backdrop-blur-sm transition-colors hover:text-red-200 whitespace-nowrap shrink-0"
                      >
                        <Github className="h-3 w-3 text-red-400" />
                        {tpl.repoFullName.split('/')[0]}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    </div>
                  </div>

                  {/* Body Copy */}
                  <div className="p-4">
                    <p className="text-xs leading-relaxed text-slate-300">
                      {tpl.description}
                    </p>
                  </div>
                </div>

                {/* Footer Links & Deploy CTA */}
                <div className="space-y-3 border-t border-red-950/70 px-4 py-3.5">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-slate-400">Session Pairer</span>
                    {tpl.sessionPairUrl ? (
                      <a
                        href={tpl.sessionPairUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 truncate font-mono text-red-300 underline decoration-red-500/35 underline-offset-4 hover:text-red-200"
                      >
                        <span className="truncate">{tpl.sessionPairHost}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="font-mono text-slate-500">Direct ENV Config</span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => openQuickDeploy(tpl)}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-3.5 py-2 text-xs font-semibold text-white transition-all hover:from-red-500 hover:to-red-600 whitespace-nowrap shrink-0"
                  >
                    <Rocket className="h-3.5 w-3.5" />
                    Deploy {tpl.name}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
