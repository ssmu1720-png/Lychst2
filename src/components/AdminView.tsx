import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Coins,
  Database,
  Download,
  Mail,
  MessageSquare,
  Plus,
  RotateCw,
  Search,
  Send,
  Shield,
  Ticket,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import {
  ADMIN_EMAIL,
  type AdminAppDetails,
  type AdminUserSummary,
  type BotDeployment,
  type BotPlatform,
  type CouponRecord,
  type EmailCampaign,
  type RuntimeEnvironment,
  type SupportTicket,
  type SupportTicketStatus,
} from '../types/lyrihost';
import type { TemplateBotSpec } from '../catalog/templateBots';
import { firebaseAuth } from '../lib/firebase';
import { syncTemplateToFirestore } from '../lib/firestoreStore';

interface AdminViewProps {
  authToken: string;
  onSelectBot: (botId: string) => void;
  onBotAction: (botId: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
}

type AdminTab = 'overview' | 'users' | 'coupons' | 'emails' | 'complaints' | 'bots' | 'templates';

export function AdminView({ authToken, onSelectBot, onBotAction }: AdminViewProps) {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const [details, setDetails] = useState<AdminAppDetails | null>(null);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [coupons, setCoupons] = useState<CouponRecord[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [campaigns, setCampaigns] = useState<EmailCampaign[]>([]);
  const [emailStatus, setEmailStatus] = useState<{
    configured: boolean;
    activeProvider: string;
    resendSandboxOnly: boolean;
    resendFromIgnoredWarning: string | null;
    brevoConfigured: boolean;
    smtpConfigured: boolean;
    guidance: string;
  } | null>(null);
  const [testingEmail, setTestingEmail] = useState(false);
  const [testRecipientEmail, setTestRecipientEmail] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [deployments, setDeployments] = useState<BotDeployment[]>([]);
  const [customTemplates, setCustomTemplates] = useState<TemplateBotSpec[]>([]);

  // User search & per-row edit state
  const [userSearch, setUserSearch] = useState('');
  const [limitEdits, setLimitEdits] = useState<Record<string, string>>({});
  const [coinGrants, setCoinGrants] = useState<Record<string, string>>({});

  // Custom bot template form state
  const [tplName, setTplName] = useState('');
  const [tplRepoInput, setTplRepoInput] = useState('');
  const [tplBranch, setTplBranch] = useState('main');
  const [tplPlatform, setTplPlatform] = useState<BotPlatform>('whatsapp');
  const [tplFramework, setTplFramework] = useState('Baileys MD');
  const [tplRuntime, setTplRuntime] = useState<RuntimeEnvironment>('node-20');
  const [tplInstallCmd, setTplInstallCmd] = useState('npm install --legacy-peer-deps --ignore-engines');
  const [tplBuildCmd, setTplBuildCmd] = useState('');
  const [tplStartCmd, setTplStartCmd] = useState('npm start');
  const [tplPairUrl, setTplPairUrl] = useState('');
  const [tplImageUrl, setTplImageUrl] = useState('');
  const [tplDescription, setTplDescription] = useState('');
  const [tplEnvKeys, setTplEnvKeys] = useState('SESSION_ID, PREFIX, OWNER_NUMBER');
  const [creatingTemplate, setCreatingTemplate] = useState(false);

  // Coupon form state
  const [couponCode, setCouponCode] = useState('');
  const [couponCoins, setCouponCoins] = useState('25');
  const [couponMaxUses, setCouponMaxUses] = useState('1');
  const [couponTargetEmail, setCouponTargetEmail] = useState('');
  const [couponExpiryDays, setCouponExpiryDays] = useState('14');
  const [couponSendEmail, setCouponSendEmail] = useState(false);
  const [creatingCoupon, setCreatingCoupon] = useState(false);

  // Email Broadcast form state
  const [emailScope, setEmailScope] = useState<'all' | 'promo_opted_in' | 'custom'>(
    'promo_opted_in'
  );
  const [customEmails, setCustomEmails] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailHeading, setEmailHeading] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);

  // Ticket reply drafts
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyStatuses, setReplyStatuses] = useState<Record<string, SupportTicketStatus>>({});
  const [notifyTicketEmail, setNotifyTicketEmail] = useState<Record<string, boolean>>({});

  const headers = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };

  const loadAllAdmin = useCallback(async () => {
    setLoading(true);
    try {
      const [ovRes, usrRes, cpnRes, tktRes, emlRes, emlStatusRes, depRes, tplRes] = await Promise.all([
        fetch('/api/admin/overview', { headers: { Authorization: `Bearer ${authToken}` } }),
        fetch('/api/admin/users', { headers: { Authorization: `Bearer ${authToken}` } }),
        fetch('/api/admin/coupons', { headers: { Authorization: `Bearer ${authToken}` } }),
        fetch('/api/admin/tickets', { headers: { Authorization: `Bearer ${authToken}` } }),
        fetch('/api/admin/emails', { headers: { Authorization: `Bearer ${authToken}` } }),
        fetch('/api/admin/email-status', { headers: { Authorization: `Bearer ${authToken}` } }),
        fetch('/api/admin/deployments', { headers: { Authorization: `Bearer ${authToken}` } }),
        fetch('/api/admin/templates', { headers: { Authorization: `Bearer ${authToken}` } }),
      ]);

      if (ovRes.ok) {
        const d = (await ovRes.json()) as { details: AdminAppDetails };
        setDetails(d.details);
      }
      if (usrRes.ok) {
        const d = (await usrRes.json()) as { users: AdminUserSummary[] };
        setUsers(d.users);
        const limits: Record<string, string> = {};
        for (const u of d.users) limits[u.id] = String(u.maxDeployments);
        setLimitEdits(limits);
      }
      if (cpnRes.ok) {
        const d = (await cpnRes.json()) as { coupons: CouponRecord[] };
        setCoupons(d.coupons);
      }
      if (tktRes.ok) {
        const d = (await tktRes.json()) as { tickets: SupportTicket[] };
        setTickets(d.tickets);
      }
      if (emlRes.ok) {
        const d = (await emlRes.json()) as { campaigns: EmailCampaign[] };
        setCampaigns(d.campaigns);
      }
      if (emlStatusRes.ok) {
        const d = (await emlStatusRes.json()) as NonNullable<typeof emailStatus>;
        setEmailStatus(d);
      }
      if (depRes.ok) {
        const d = (await depRes.json()) as { deployments: BotDeployment[] };
        setDeployments(d.deployments);
      }
      if (tplRes.ok) {
        const d = (await tplRes.json()) as { templates: TemplateBotSpec[] };
        setCustomTemplates(d.templates);
      }
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    void loadAllAdmin();
  }, [loadAllAdmin]);

  const handleUpdateUser = async (userId: string) => {
    setFeedback(null);
    const maxDeployments = Number(limitEdits[userId]);
    const grantCoinsDelta = Number(coinGrants[userId] || 0);

    try {
      const resp = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          maxDeployments: Number.isFinite(maxDeployments) ? maxDeployments : undefined,
          grantCoinsDelta: Number.isFinite(grantCoinsDelta) ? grantCoinsDelta : 0,
        }),
      });
      const data = (await resp.json()) as { user?: AdminUserSummary; error?: string };
      if (!resp.ok || !data.user) throw new Error(data.error || 'Failed to update user.');
      setUsers((prev) => prev.map((u) => (u.id === userId ? data.user! : u)));
      setCoinGrants((prev) => ({ ...prev, [userId]: '' }));
      setFeedback({
        type: 'success',
        text: `Updated limits/balance for ${data.user.email}.`,
      });
      void loadAllAdmin();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to update user.',
      });
    }
  };

  const handleCreateCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    setCreatingCoupon(true);
    try {
      const resp = await fetch('/api/admin/coupons', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          code: couponCode.trim() || undefined,
          coins: Number(couponCoins),
          maxUses: Number(couponMaxUses || 1),
          targetEmail: couponTargetEmail.trim() || undefined,
          expiresInDays: Number(couponExpiryDays || 0) || undefined,
          sendEmail: couponSendEmail,
        }),
      });
      const data = (await resp.json()) as {
        coupon?: CouponRecord;
        emailResult?: { attempted: boolean; ok?: boolean; error?: string };
        error?: string;
      };
      if (!resp.ok || !data.coupon) throw new Error(data.error || 'Coupon creation failed.');

      setCoupons((prev) => [data.coupon!, ...prev]);
      setCouponCode('');
      setCouponTargetEmail('');
      let msg = `Created coupon ${data.coupon.code} worth ${data.coupon.coins} Coins.`;
      if (data.emailResult?.attempted) {
        msg += data.emailResult.ok
          ? ' Coupon emailed to recipient.'
          : ` Email notice: ${data.emailResult.error}`;
      }
      setFeedback({ type: 'success', text: msg });
      void loadAllAdmin();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to create coupon.',
      });
    } finally {
      setCreatingCoupon(false);
    }
  };

  const handleToggleCoupon = async (code: string, isActive: boolean) => {
    const resp = await fetch(`/api/admin/coupons/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ isActive }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { coupon: CouponRecord };
      setCoupons((prev) => prev.map((c) => (c.code === code ? data.coupon : c)));
    }
  };

  const handleDeleteCoupon = async (code: string) => {
    const resp = await fetch(`/api/admin/coupons/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (resp.ok) {
      setCoupons((prev) => prev.filter((c) => c.code !== code));
    }
  };

  const handleSendCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    setSendingEmail(true);
    try {
      const resp = await fetch('/api/admin/emails/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          scope: emailScope,
          customEmails,
          subject: emailSubject.trim(),
          heading: emailHeading.trim() || emailSubject.trim(),
          message: emailBody.trim(),
        }),
      });
      const data = (await resp.json()) as {
        campaign?: EmailCampaign;
        results?: Array<{ email: string; ok: boolean; error?: string }>;
        error?: string;
      };
      if (!resp.ok || !data.campaign) throw new Error(data.error || 'Email broadcast failed.');
      setCampaigns((prev) => [data.campaign!, ...prev]);
      setEmailSubject('');
      setEmailHeading('');
      setEmailBody('');
      const firstErr = data.results?.find((r) => !r.ok)?.error;
      setFeedback({
        type: data.campaign.sentCount > 0 ? 'success' : 'error',
        text: `Campaign completed: ${data.campaign.sentCount} sent, ${data.campaign.failedCount} failed.${firstErr ? ` (${firstErr})` : ''}`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to send promotional emails.',
      });
    } finally {
      setSendingEmail(false);
    }
  };

  const handleReplyTicket = async (ticketId: string) => {
    setFeedback(null);
    const adminReply = (replyDrafts[ticketId] || '').trim();
    const status = replyStatuses[ticketId] || 'resolved';
    const notifyByEmail = Boolean(notifyTicketEmail[ticketId]);
    try {
      const resp = await fetch(`/api/admin/tickets/${ticketId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status, adminReply, notifyByEmail }),
      });
      const data = (await resp.json()) as {
        ticket?: SupportTicket;
        emailResult?: { attempted: boolean; ok?: boolean; error?: string };
        error?: string;
      };
      if (!resp.ok || !data.ticket) throw new Error(data.error || 'Failed to update ticket.');
      setTickets((prev) => prev.map((t) => (t.id === ticketId ? data.ticket! : t)));
      setReplyDrafts((prev) => ({ ...prev, [ticketId]: '' }));
      setFeedback({
        type: 'success',
        text: `Updated ticket ${ticketId} (${data.ticket.status}).`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to respond to ticket.',
      });
    }
  };

  const handleCreateTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    setCreatingTemplate(true);
    try {
      const resp = await fetch('/api/admin/templates', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: tplName.trim(),
          repoInput: tplRepoInput.trim(),
          defaultBranch: tplBranch.trim() || 'main',
          platform: tplPlatform,
          framework: tplFramework.trim() || 'Baileys MD',
          runtime: tplRuntime,
          installCommand: tplInstallCmd.trim(),
          buildCommand: tplBuildCmd.trim(),
          startCommand: tplStartCmd.trim(),
          sessionPairUrl: tplPairUrl.trim(),
          imageUrl: tplImageUrl.trim(),
          description: tplDescription.trim(),
          defaultEnvKeys: tplEnvKeys.trim(),
        }),
      });
      const data = (await resp.json()) as { template?: TemplateBotSpec; error?: string };
      if (!resp.ok || !data.template) {
        throw new Error(data.error || 'Could not add bot template.');
      }
      setCustomTemplates((prev) => [data.template!, ...prev]);
      if (firebaseAuth.currentUser?.emailVerified) {
        void syncTemplateToFirestore(firebaseAuth.currentUser, data.template!).catch(() => {});
      }
      setTplName('');
      setTplRepoInput('');
      setTplPairUrl('');
      setTplImageUrl('');
      setTplDescription('');
      setFeedback({
        type: 'success',
        text: `Published custom bot template "${data.template.name}" (${data.template.repoFullName}) to Templates catalog.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to add bot template.',
      });
    } finally {
      setCreatingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (templateId: string) => {
    setFeedback(null);
    const resp = await fetch(`/api/admin/templates/${encodeURIComponent(templateId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (resp.ok) {
      setCustomTemplates((prev) => prev.filter((t) => t.id !== templateId));
      setFeedback({ type: 'success', text: 'Custom bot template removed from catalog.' });
    }
  };

  const filteredUsers = users.filter(
    (u) => !userSearch.trim() || u.email.toLowerCase().includes(userSearch.trim().toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="atelier-panel relative rounded-lg border border-red-500/35 p-5 sm:p-6">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70"
        />

        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Shield className="h-3.5 w-3.5 text-red-400" />
              <span>Root Administrator Console</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-rose-300">{ADMIN_EMAIL}</span>
              <span aria-hidden="true">·</span>
              <span className="text-emerald-400">Unlimited Coins</span>
            </div>
            <h1 className="mt-1 font-display text-3xl font-semibold text-slate-50">
              Lyrihost <span className="italic font-medium text-red-400">Administration</span>
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Manage operator deployment quotas, issue coin grants and coupons, broadcast promotional &amp; update emails via Resend, inspect bots, and answer user complaints.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void loadAllAdmin()}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/20 whitespace-nowrap shrink-0"
          >
            <RotateCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh Telemetry
          </button>
        </div>

        {/* Sub-Navigation */}
        <div className="mt-5 flex flex-wrap gap-1.5 border-t border-red-950/70 pt-4">
          {(
            [
              { id: 'overview', label: 'App Details' },
              { id: 'users', label: `Users (${users.length})` },
              { id: 'coupons', label: `Coupons (${coupons.length})` },
              { id: 'emails', label: 'Promo Emails' },
              {
                id: 'complaints',
                label: `Complaints (${tickets.filter((t) => t.status !== 'resolved').length})`,
              },
              { id: 'bots', label: `All Bots (${deployments.length})` },
              { id: 'templates', label: `Bot Templates (${customTemplates.length})` },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                tab === item.id
                  ? 'border-red-500/50 bg-red-600/25 text-red-200'
                  : 'border-red-950/80 bg-[#080305] text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>

      {feedback && (
        <div
          className={`flex items-start gap-2.5 rounded-md border p-3.5 text-xs ${
            feedback.type === 'error'
              ? 'border-red-500/50 bg-red-500/15 text-red-200'
              : 'border-emerald-500/45 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {feedback.type === 'error' ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* TAB 1: APP DETAILS */}
      {tab === 'overview' && details && (
        <section className="space-y-5">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="atelier-panel rounded-lg border border-red-950/90 p-4">
              <div className="text-[11px] text-slate-400">Verified Operators</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-slate-100 tabular-nums">
                {details.verifiedUsers}
                <span className="text-xs text-slate-500"> / {details.totalUsers}</span>
              </div>
            </div>

            <div className="atelier-panel rounded-lg border border-red-950/90 p-4">
              <div className="text-[11px] text-slate-400">Fleet Bots Online</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-emerald-400 tabular-nums">
                {details.onlineDeployments}
                <span className="text-xs text-slate-500"> / {details.totalDeployments}</span>
              </div>
            </div>

            <div className="atelier-panel rounded-lg border border-red-950/90 p-4">
              <div className="text-[11px] text-slate-400">Total KSH Purchased</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-rose-300 tabular-nums">
                {details.totalKshPurchased} KSH
              </div>
              <div className="font-mono text-[10px] text-slate-500">
                {details.totalPurchasesCount} purchases · {details.totalCoinsInCirculation} user coins
              </div>
            </div>

            <div className="atelier-panel rounded-lg border border-red-950/90 p-4">
              <div className="text-[11px] text-slate-400">Open Complaints</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-amber-300 tabular-nums">
                {details.openTicketsCount}
              </div>
              <div className="font-mono text-[10px] text-slate-500">
                {details.emailsSentTotal} promo emails sent
              </div>
            </div>
          </div>

          <div className="atelier-panel rounded-lg border border-red-950/90 p-5">
            <div className="flex items-center gap-2 border-b border-red-950/70 pb-3">
              <Database className="h-4 w-4 text-red-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">
                Infrastructure &amp; Database Details
              </h2>
            </div>

            <dl className="mt-4 grid grid-cols-1 gap-4 font-mono text-xs sm:grid-cols-2 lg:grid-cols-3 tabular-nums">
              <div>
                <dt className="text-slate-500">Admin Account (Saved in Code)</dt>
                <dd className="mt-0.5 text-rose-300">{details.adminEmail}</dd>
              </div>
              <div>
                <dt className="text-slate-500">SQLite Database Size</dt>
                <dd className="mt-0.5 text-slate-200">{details.dbSizeKb} KB (WAL enabled)</dd>
              </div>
              <div>
                <dt className="text-slate-500">Runtime Engine</dt>
                <dd className="mt-0.5 text-slate-200">
                  Node {details.nodeVersion} · {details.platform}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Server Uptime</dt>
                <dd className="mt-0.5 text-slate-200">{details.uptimeSeconds} seconds</dd>
              </div>
              <div>
                <dt className="text-slate-500">Successful Referrals</dt>
                <dd className="mt-0.5 text-emerald-400">
                  {details.totalReferrals} ({details.totalReferrals * 2} Coins awarded)
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Active Coupons</dt>
                <dd className="mt-0.5 text-slate-200">{details.activeCouponsCount}</dd>
              </div>
            </dl>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-red-950/70 pt-4">
              <div className="text-[11px] text-slate-400">
                Export or restore all users, coin balances, transactions, tickets, templates, and deployment configs.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={backupBusy}
                  onClick={async () => {
                    setBackupBusy(true);
                    setFeedback(null);
                    try {
                      const resp = await fetch('/api/admin/backup', {
                        headers: { Authorization: `Bearer ${authToken}` },
                      });
                      if (!resp.ok) throw new Error('Failed to export database backup.');
                      const blob = await resp.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `lyrihost-backup-${new Date().toISOString().slice(0, 10)}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                      setFeedback({
                        type: 'success',
                        text: 'Downloaded full user & deployment backup snapshot (.json).',
                      });
                    } catch (err) {
                      setFeedback({
                        type: 'error',
                        text: err instanceof Error ? err.message : 'Backup download failed.',
                      });
                    } finally {
                      setBackupBusy(false);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/45 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-60"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download User Data Backup
                </button>

                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-red-500/45 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-red-500/20">
                  <Upload className="h-3.5 w-3.5" />
                  Restore Backup (.json)
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    disabled={backupBusy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      setBackupBusy(true);
                      setFeedback(null);
                      try {
                        const raw = await file.text();
                        const parsed = JSON.parse(raw);
                        const resp = await fetch('/api/admin/restore', {
                          method: 'POST',
                          headers,
                          body: JSON.stringify(parsed),
                        });
                        const data = (await resp.json()) as {
                          ok?: boolean;
                          usersRestored?: number;
                          deploymentsRestored?: number;
                          ticketsRestored?: number;
                          error?: string;
                        };
                        if (!resp.ok || !data.ok) {
                          throw new Error(data.error || 'Failed to restore backup.');
                        }
                        await loadAllAdmin();
                        setFeedback({
                          type: 'success',
                          text: `Restored ${data.usersRestored ?? 0} users, ${data.deploymentsRestored ?? 0} deployments, and ${data.ticketsRestored ?? 0} tickets.`,
                        });
                      } catch (err) {
                        setFeedback({
                          type: 'error',
                          text: err instanceof Error ? err.message : 'Restore backup failed.',
                        });
                      } finally {
                        setBackupBusy(false);
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* TAB 2: USERS & DEPLOYMENT LIMITS */}
      {tab === 'users' && (
        <section className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4">
          <div className="flex flex-col gap-3 border-b border-red-950/70 pb-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-red-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">
                Users &amp; Deployment Limits
              </h2>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Search user email..."
                className="w-full rounded-md border border-red-950/90 bg-[#080305] py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-red-400 focus:outline-none"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-red-950/70 text-[11px] font-medium text-slate-400">
                  <th className="py-2 pr-3">Operator Email</th>
                  <th className="px-3 py-2 text-right">Coins</th>
                  <th className="px-3 py-2 text-right">Bots</th>
                  <th className="px-3 py-2 text-right">Streak / Refs</th>
                  <th className="px-3 py-2">Max Deployments</th>
                  <th className="px-3 py-2">Grant Coins (+/-)</th>
                  <th className="py-2 pl-3 text-right">Apply</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-red-950/50">
                {filteredUsers.map((u) => (
                  <tr key={u.id} className="hover:bg-red-500/[0.04]">
                    <td className="py-2.5 pr-3">
                      <div className="font-mono text-slate-100">{u.email}</div>
                      <div className="text-[10px] text-slate-500">
                        {u.isAdmin ? 'Admin' : 'Operator'} · Code {u.referralCode}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-rose-300 tabular-nums">
                      {u.unlimitedCoins ? 'Unlimited' : `${u.coinBalance}`}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {u.deploymentCount}/{u.isAdmin ? '∞' : u.maxDeployments}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[11px] text-slate-400 tabular-nums">
                      D{u.streakCount} · {u.referralCount} refs
                    </td>
                    <td className="px-3 py-2.5">
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        disabled={u.isAdmin}
                        value={limitEdits[u.id] ?? String(u.maxDeployments)}
                        onChange={(e) =>
                          setLimitEdits((prev) => ({ ...prev, [u.id]: e.target.value }))
                        }
                        className="w-20 rounded border border-red-950/90 bg-[#080305] px-2 py-1 font-mono text-xs text-slate-100 tabular-nums disabled:opacity-50"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <input
                        type="number"
                        disabled={u.isAdmin}
                        placeholder="+/- coins"
                        value={coinGrants[u.id] ?? ''}
                        onChange={(e) =>
                          setCoinGrants((prev) => ({ ...prev, [u.id]: e.target.value }))
                        }
                        className="w-24 rounded border border-red-950/90 bg-[#080305] px-2 py-1 font-mono text-xs text-slate-100 tabular-nums placeholder:text-slate-600 disabled:opacity-50"
                      />
                    </td>
                    <td className="py-2.5 pl-3 text-right">
                      <button
                        type="button"
                        disabled={u.isAdmin}
                        onClick={() => void handleUpdateUser(u.id)}
                        className="rounded border border-red-500/40 bg-red-600/20 px-2.5 py-1 text-[11px] font-semibold text-red-200 hover:bg-red-600/35 disabled:opacity-40"
                      >
                        Save
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 3: COUPONS */}
      {tab === 'coupons' && (
        <section className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4 lg:col-span-5">
            <div className="flex items-center gap-2 border-b border-red-950/70 pb-3">
              <Ticket className="h-4 w-4 text-red-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">Create Coupon</h2>
            </div>

            <form onSubmit={handleCreateCoupon} className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Coupon Code (leave blank to auto-generate)
                </label>
                <input
                  type="text"
                  value={couponCode}
                  onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                  placeholder="LYRI-PROMO50"
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs uppercase text-slate-100 placeholder:text-slate-600"
                />
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">Coins</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={couponCoins}
                    onChange={(e) => setCouponCoins(e.target.value)}
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 font-mono text-xs text-slate-100 tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">Max Uses</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={couponMaxUses}
                    onChange={(e) => setCouponMaxUses(e.target.value)}
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 font-mono text-xs text-slate-100 tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">Days Valid</label>
                  <input
                    type="number"
                    min={0}
                    value={couponExpiryDays}
                    onChange={(e) => setCouponExpiryDays(e.target.value)}
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 font-mono text-xs text-slate-100 tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Assign to Specific User Email (optional)
                </label>
                <input
                  type="email"
                  value={couponTargetEmail}
                  onChange={(e) => setCouponTargetEmail(e.target.value)}
                  placeholder="Any verified user if left empty"
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600"
                />
              </div>

              {couponTargetEmail.trim() && (
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={couponSendEmail}
                    onChange={(e) => setCouponSendEmail(e.target.checked)}
                    className="h-4 w-4 accent-red-600"
                  />
                  Email this coupon directly to {couponTargetEmail.trim()}
                </label>
              )}

              <button
                type="submit"
                disabled={creatingCoupon}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-4 py-2 text-xs font-semibold text-white hover:from-red-500 hover:to-red-600 disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5" />
                {creatingCoupon ? 'Creating Coupon...' : 'Create & Issue Coupon'}
              </button>
            </form>
          </div>

          <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-3 lg:col-span-7">
            <h2 className="font-display text-xl font-semibold text-slate-50 border-b border-red-950/70 pb-3">
              Issued Coupons
            </h2>
            {coupons.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">No coupons issued yet.</div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {coupons.map((c) => (
                  <div
                    key={c.code}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-950/80 bg-[#080305] px-3.5 py-2.5 text-xs"
                  >
                    <div>
                      <div className="font-mono font-semibold text-rose-300">
                        {c.code}{' '}
                        <span className="text-emerald-400">· +{c.coins} Coins</span>
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Uses: {c.usesCount}/{c.maxUses} ·{' '}
                        {c.targetEmail ? `Assigned: ${c.targetEmail}` : 'Open to any user'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleToggleCoupon(c.code, !c.isActive)}
                        className={`rounded border px-2 py-1 text-[10px] font-medium ${
                          c.isActive
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                            : 'border-slate-700 bg-slate-800/40 text-slate-400'
                        }`}
                      >
                        {c.isActive ? 'Active' : 'Disabled'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteCoupon(c.code)}
                        aria-label={`Delete coupon ${c.code}`}
                        className="rounded border border-red-500/35 bg-red-500/10 p-1 text-red-300 hover:bg-red-500/20"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* TAB 4: PROMOTIONAL & UPDATE EMAILS */}
      {tab === 'emails' && (
        <section className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4 lg:col-span-7">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-950/70 pb-3">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-red-400" />
                <h2 className="font-display text-xl font-semibold text-slate-50">
                  Send Promotional / Update Email
                </h2>
              </div>
              <span
                className={`font-mono text-[10px] ${
                  emailStatus?.activeProvider === 'resend-sandbox' ||
                  emailStatus?.activeProvider === 'brevo-disabled' ||
                  emailStatus?.activeProvider === 'none'
                    ? 'text-amber-300'
                    : 'text-emerald-400'
                }`}
              >
                {emailStatus ? `Transport: ${emailStatus.activeProvider}` : 'Checking Mail Transport...'}
              </span>
            </div>

            {emailStatus && (
              <div
                className={`rounded-md border p-3 text-xs space-y-2 ${
                  emailStatus.activeProvider === 'resend-sandbox' ||
                  emailStatus.activeProvider === 'brevo-disabled' ||
                  emailStatus.activeProvider === 'none'
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                    : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
                }`}
              >
                <div className="leading-relaxed">{emailStatus.guidance}</div>
                {emailStatus.resendFromIgnoredWarning && (
                  <div className="font-mono text-[11px] text-amber-300">
                    {emailStatus.resendFromIgnoredWarning}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <input
                    type="email"
                    value={testRecipientEmail}
                    onChange={(e) => setTestRecipientEmail(e.target.value)}
                    placeholder="Test recipient (e.g. ssmu1720@gmail.com)"
                    className="min-w-[210px] flex-1 rounded border border-red-950/90 bg-[#080305] px-2.5 py-1.5 font-mono text-[11px] text-slate-100 placeholder:text-slate-500"
                  />
                  <button
                    type="button"
                    disabled={testingEmail}
                    onClick={async () => {
                      setTestingEmail(true);
                      setFeedback(null);
                      try {
                        const resp = await fetch('/api/admin/email-test', {
                          method: 'POST',
                          headers,
                          body: JSON.stringify({ toEmail: testRecipientEmail.trim() || undefined }),
                        });
                        const data = (await resp.json()) as {
                          ok?: boolean;
                          toEmail?: string;
                          error?: string;
                          status?: NonNullable<typeof emailStatus>;
                        };
                        if (data.status) setEmailStatus(data.status);
                        if (!resp.ok || !data.ok) {
                          throw new Error(data.error || 'Email delivery test failed.');
                        }
                        setFeedback({
                          type: 'success',
                          text: `Test email delivered to ${data.toEmail} via ${data.status?.activeProvider || 'active transport'}.`,
                        });
                      } catch (err) {
                        setFeedback({
                          type: 'error',
                          text: err instanceof Error ? err.message : 'Test email failed.',
                        });
                      } finally {
                        setTestingEmail(false);
                      }
                    }}
                    className="rounded border border-red-500/40 bg-red-600/20 px-3 py-1.5 text-[11px] font-semibold text-rose-200 hover:bg-red-600/35 disabled:opacity-60 whitespace-nowrap"
                  >
                    {testingEmail ? 'Testing...' : 'Send Test Email'}
                  </button>
                </div>
              </div>
            )}

            <form onSubmit={handleSendCampaign} className="space-y-3.5">
              <div>
                <label className="block text-[11px] font-medium text-slate-300">Audience</label>
                <select
                  value={emailScope}
                  onChange={(e) =>
                    setEmailScope(e.target.value as 'all' | 'promo_opted_in' | 'custom')
                  }
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100"
                >
                  <option value="promo_opted_in">Users Opted Into Promotional Emails</option>
                  <option value="all">All Verified Users</option>
                  <option value="custom">Specific Email Address(es)</option>
                </select>
              </div>

              {emailScope === 'custom' && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    Target Email Addresses (comma or newline separated)
                  </label>
                  <input
                    type="text"
                    required
                    value={customEmails}
                    onChange={(e) => setCustomEmails(e.target.value)}
                    placeholder="user1@domain.com, user2@domain.com"
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100"
                  />
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    Email Subject
                  </label>
                  <input
                    type="text"
                    required
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                    placeholder="Lyrihost Promo: Bonus Coins & High-RAM Bots"
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    Banner Heading (optional)
                  </label>
                  <input
                    type="text"
                    value={emailHeading}
                    onChange={(e) => setEmailHeading(e.target.value)}
                    placeholder="New Unlimited RAM Tier Live"
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Message Content
                </label>
                <textarea
                  rows={5}
                  required
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  placeholder="Write your promotional announcement, coupon code, or platform update..."
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100"
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={sendingEmail}
                  className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-4 py-2 text-xs font-semibold text-white hover:from-red-500 hover:to-red-600 disabled:opacity-60"
                >
                  <Send className="h-3.5 w-3.5" />
                  {sendingEmail ? 'Dispatching Emails...' : 'Send Email Broadcast'}
                </button>
              </div>
            </form>
          </div>

          <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-3 lg:col-span-5">
            <h2 className="font-display text-xl font-semibold text-slate-50 border-b border-red-950/70 pb-3">
              Campaign History
            </h2>
            {campaigns.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                No promotional or update emails sent yet.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-96 overflow-y-auto">
                {campaigns.map((c) => (
                  <div
                    key={c.id}
                    className="rounded border border-red-950/80 bg-[#080305] p-3 text-xs space-y-1"
                  >
                    <div className="font-medium text-slate-100">{c.subject}</div>
                    <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                      <span>{c.recipientScope}</span>
                      <span className="text-emerald-400">
                        {c.sentCount}/{c.recipientCount} delivered
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {new Date(c.createdAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* TAB 5: COMPLAINTS & SUPPORT INBOX */}
      {tab === 'complaints' && (
        <section className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-red-950/70 pb-3">
            <MessageSquare className="h-4 w-4 text-red-400" />
            <h2 className="font-display text-xl font-semibold text-slate-50">
              User Complaints &amp; Feedback Inbox
            </h2>
          </div>

          {tickets.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              No complaints or support tickets submitted yet.
            </div>
          ) : (
            <div className="space-y-4">
              {tickets.map((t) => (
                <article
                  key={t.id}
                  className="rounded-md border border-red-950/80 bg-[#080305] p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-100">{t.subject}</div>
                      <div className="text-[11px] text-slate-400">
                        From <span className="font-mono text-rose-300">{t.userEmail}</span> ·{' '}
                        {t.category} · {t.priority} · {new Date(t.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <span className="font-mono text-[11px] uppercase text-amber-300">
                      {t.status.replace('_', ' ')}
                    </span>
                  </div>

                  <p className="text-xs text-slate-300 whitespace-pre-wrap">{t.message}</p>

                  {t.adminReply && (
                    <div className="border-t border-red-950/70 pt-2 text-xs text-emerald-300">
                      Previous Reply: {t.adminReply}
                    </div>
                  )}

                  <div className="border-t border-red-950/70 pt-3 space-y-2.5">
                    <textarea
                      rows={2}
                      value={replyDrafts[t.id] ?? ''}
                      onChange={(e) =>
                        setReplyDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))
                      }
                      placeholder="Write admin response to user..."
                      className="w-full rounded border border-red-950/90 bg-[#0d0508] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <select
                          value={replyStatuses[t.id] ?? t.status}
                          onChange={(e) =>
                            setReplyStatuses((prev) => ({
                              ...prev,
                              [t.id]: e.target.value as SupportTicketStatus,
                            }))
                          }
                          className="rounded border border-red-950/90 bg-[#0d0508] px-2.5 py-1 text-xs text-slate-200"
                        >
                          <option value="open">Open</option>
                          <option value="in_review">In Review</option>
                          <option value="resolved">Resolved</option>
                        </select>
                        <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(notifyTicketEmail[t.id])}
                            onChange={(e) =>
                              setNotifyTicketEmail((prev) => ({
                                ...prev,
                                [t.id]: e.target.checked,
                              }))
                            }
                            className="h-3.5 w-3.5 accent-red-600"
                          />
                          Also send reply via email
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleReplyTicket(t.id)}
                        className="inline-flex items-center gap-1.5 rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500"
                      >
                        <Coins className="hidden h-3 w-3" />
                        Save Response
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {/* TAB 6: ALL USER DEPLOYMENTS */}
      {tab === 'bots' && (
        <section className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-3">
          <div className="flex items-center gap-2 border-b border-red-950/70 pb-3">
            <Bot className="h-4 w-4 text-red-400" />
            <h2 className="font-display text-xl font-semibold text-slate-50">
              All Deployed Bots Across Users
            </h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-red-950/70 text-[11px] font-medium text-slate-400">
                  <th className="py-2 pr-3">Bot</th>
                  <th className="px-3 py-2">Owner</th>
                  <th className="px-3 py-2">Plan / RAM</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="py-2 pl-3 text-right">Controls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-red-950/50">
                {deployments.map((d) => (
                  <tr key={d.id} className="hover:bg-red-500/[0.04]">
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        onClick={() => onSelectBot(d.id)}
                        className="font-medium text-slate-100 hover:text-red-300"
                      >
                        {d.name}
                      </button>
                      <div className="font-mono text-[10px] text-slate-500">{d.repoFullName}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-rose-300">
                      {d.ownerEmail || 'Legacy'}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-300 tabular-nums">
                      {d.planId || 'plan_15d'} · {d.memoryLimitMb} MB
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] uppercase text-slate-300">
                      {d.status}
                    </td>
                    <td className="py-2 pl-3 text-right space-x-1.5">
                      {d.status === 'online' ? (
                        <button
                          type="button"
                          onClick={() => void onBotAction(d.id, 'stop')}
                          className="rounded border border-red-500/40 bg-red-500/15 px-2 py-1 text-[10px] text-red-200"
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void onBotAction(d.id, 'start')}
                          className="rounded border border-emerald-500/35 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300"
                        >
                          Start
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectBot(d.id)}
                        className="rounded border border-red-950 bg-[#080305] px-2 py-1 text-[10px] text-slate-300 hover:border-red-500/40"
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 7: CUSTOM BOT TEMPLATES */}
      {tab === 'templates' && (
        <section className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4 lg:col-span-6">
            <div className="flex items-center gap-2 border-b border-red-950/70 pb-3">
              <Plus className="h-4 w-4 text-red-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">
                Add New Bot Template
              </h2>
            </div>

            <form onSubmit={handleCreateTemplate} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    Template Name
                  </label>
                  <input
                    type="text"
                    required
                    value={tplName}
                    onChange={(e) => setTplName(e.target.value)}
                    placeholder="e.g. Lyri-MD V3"
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    GitHub Repo (owner/repo or URL)
                  </label>
                  <input
                    type="text"
                    required
                    value={tplRepoInput}
                    onChange={(e) => setTplRepoInput(e.target.value)}
                    placeholder="owner/repo-name"
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">Platform</label>
                  <select
                    value={tplPlatform}
                    onChange={(e) => setTplPlatform(e.target.value as BotPlatform)}
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 text-xs text-slate-100"
                  >
                    <option value="whatsapp">WhatsApp</option>
                    <option value="discord">Discord</option>
                    <option value="telegram">Telegram</option>
                    <option value="slack">Slack</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">Runtime</label>
                  <select
                    value={tplRuntime}
                    onChange={(e) => setTplRuntime(e.target.value as RuntimeEnvironment)}
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 font-mono text-xs text-slate-100"
                  >
                    <option value="node-20">Node 20</option>
                    <option value="node-22">Node 22</option>
                    <option value="python-3.12">Python 3.12</option>
                    <option value="bun-1">Bun 1</option>
                    <option value="docker">Docker</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">Branch</label>
                  <input
                    type="text"
                    value={tplBranch}
                    onChange={(e) => setTplBranch(e.target.value)}
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 font-mono text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">Framework</label>
                  <input
                    type="text"
                    value={tplFramework}
                    onChange={(e) => setTplFramework(e.target.value)}
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 text-xs text-slate-100"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    Install Command
                  </label>
                  <input
                    type="text"
                    value={tplInstallCmd}
                    onChange={(e) => setTplInstallCmd(e.target.value)}
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 font-mono text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    Build Cmd (opt.)
                  </label>
                  <input
                    type="text"
                    value={tplBuildCmd}
                    onChange={(e) => setTplBuildCmd(e.target.value)}
                    placeholder="npm run build"
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    Start Command
                  </label>
                  <input
                    type="text"
                    value={tplStartCmd}
                    onChange={(e) => setTplStartCmd(e.target.value)}
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-2 font-mono text-xs text-slate-100"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    Session Pair URL (optional)
                  </label>
                  <input
                    type="url"
                    value={tplPairUrl}
                    onChange={(e) => setTplPairUrl(e.target.value)}
                    placeholder="https://pair.example.com"
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-300">
                    Banner Image URL (optional)
                  </label>
                  <input
                    type="url"
                    value={tplImageUrl}
                    onChange={(e) => setTplImageUrl(e.target.value)}
                    placeholder="https://..."
                    className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Default Environment Keys (comma-separated)
                </label>
                <input
                  type="text"
                  value={tplEnvKeys}
                  onChange={(e) => setTplEnvKeys(e.target.value)}
                  placeholder="SESSION_ID, PREFIX, OWNER_NUMBER"
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Description
                </label>
                <textarea
                  rows={2}
                  required
                  value={tplDescription}
                  onChange={(e) => setTplDescription(e.target.value)}
                  placeholder="Describe this bot template's features, plugins, and compatibility..."
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600"
                />
              </div>

              <button
                type="submit"
                disabled={creatingTemplate}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-4 py-2 text-xs font-semibold text-white hover:from-red-500 hover:to-red-600 disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5" />
                {creatingTemplate ? 'Publishing Template...' : 'Publish Bot Template'}
              </button>
            </form>
          </div>

          <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-3 lg:col-span-6">
            <h2 className="font-display text-xl font-semibold text-slate-50 border-b border-red-950/70 pb-3">
              Admin-Added Bot Templates ({customTemplates.length})
            </h2>
            {customTemplates.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-500">
                No custom templates published yet. Add one on the left and it immediately appears in the user Bot Templates catalog.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[32rem] overflow-y-auto">
                {customTemplates.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="flex items-start justify-between gap-3 rounded border border-red-950/80 bg-[#080305] p-3.5 text-xs"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="font-medium text-slate-100">
                        {tpl.name}{' '}
                        <span className="font-mono text-[10px] text-rose-300">
                          · {tpl.repoFullName}
                        </span>
                      </div>
                      <div className="font-mono text-[10px] text-slate-400">
                        {tpl.platform} · {tpl.framework} · {tpl.runtime} · branch {tpl.defaultBranch}
                      </div>
                      <p className="text-[11px] text-slate-400">{tpl.description}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteTemplate(tpl.id)}
                      aria-label={`Delete template ${tpl.name}`}
                      className="rounded border border-red-500/35 bg-red-500/10 p-1.5 text-red-300 hover:bg-red-500/20 shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
