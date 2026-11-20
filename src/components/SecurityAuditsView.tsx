import { AlertTriangle, ChevronRight, Layers, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { BotDeployment } from '../types/lyrihost';

interface SecurityAuditsViewProps {
  deployments: BotDeployment[];
  onSelectBot: (botId: string) => void;
  onOpenTemplates: () => void;
}

export function SecurityAuditsView({
  deployments,
  onSelectBot,
  onOpenTemplates,
}: SecurityAuditsViewProps) {
  const scannedBots = deployments.filter((d) => d.scanReport !== null);

  return (
    <div className="space-y-5">
      <section className="atelier-panel relative rounded-lg border border-red-500/25 p-5 sm:p-6">
        <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70" />
        <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-50">
              Repository Security <span className="italic font-medium text-red-400">Audits</span>
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Centralized secret-leak and manifest hygiene reports across your deployed GitHub bot repositories.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenTemplates}
            className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-3.5 py-2 text-xs font-semibold text-white shadow-[0_1px_10px_rgba(220,38,38,0.28)] hover:from-red-500 hover:to-red-600 whitespace-nowrap shrink-0"
          >
            <Layers className="h-3.5 w-3.5" />
            Deploy Bot
          </button>
        </div>
      </section>

      {scannedBots.length === 0 ? (
        <section className="atelier-panel rounded-lg border border-red-950/80 p-10 text-center">
          <ShieldCheck className="mx-auto h-9 w-9 text-red-400/75" />
          <h2 className="mt-3 font-display text-lg font-semibold text-slate-100">
            No Repository Audits Yet
          </h2>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">
            Deploy a bot from Templates or Custom Repo, then open its Inspector and run &quot;Re-Scan GitHub Repo&quot; to inspect source files for exposed tokens and misconfigurations.
          </p>
        </section>
      ) : (
        <div className="space-y-3">
          {scannedBots.map((bot) => {
            const findings = bot.scanReport?.securityFindings ?? [];
            const crits = findings.filter((f) => f.severity === 'critical').length;
            const warns = findings.filter((f) => f.severity === 'warning').length;

            return (
              <section
                key={bot.id}
                onClick={() => onSelectBot(bot.id)}
                className="atelier-panel cursor-pointer rounded-lg border border-red-950/90 p-5 transition-colors hover:border-red-500/45"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <span className="font-display text-lg font-semibold text-slate-100">
                        {bot.name}
                      </span>
                      <span className="font-mono text-[11px] text-rose-300">{bot.repoFullName}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
                      <span className="font-mono tabular-nums">
                        {bot.scanReport?.totalFiles} files inspected
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        Scanned {new Date(bot.scanReport!.scannedAt).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums">
                      <span className={crits > 0 ? 'text-red-400 font-semibold' : 'text-slate-400'}>
                        {crits} critical
                      </span>
                      <span className={warns > 0 ? 'text-amber-300' : 'text-slate-400'}>
                        {warns} warnings
                      </span>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-500" />
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
                  {findings.slice(0, 4).map((f) => (
                    <div
                      key={f.id}
                      className={`flex items-start gap-2 rounded-md border p-2.5 text-[11px] ${
                        f.severity === 'critical'
                          ? 'border-red-500/40 bg-red-500/15 text-red-200'
                          : f.severity === 'warning'
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                            : 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200'
                      }`}
                    >
                      {f.severity === 'critical' ? (
                        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                      ) : f.severity === 'warning' ? (
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                      ) : (
                        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      )}
                      <span className="truncate">{f.title}</span>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
