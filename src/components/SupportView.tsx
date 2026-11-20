import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Mail,
  MessageSquare,
  Send,
  Sliders,
} from 'lucide-react';
import { firebaseAuth } from '../lib/firebase';
import { syncTicketToFirestore } from '../lib/firestoreStore';
import {
  ADMIN_EMAIL,
  DEPLOY_REGIONS,
  type AuthUser,
  type DeployRegion,
  type PlatformPreferences,
  type RestartPolicy,
  type SupportTicket,
  type SupportTicketCategory,
  type SupportTicketPriority,
} from '../types/lyrihost';

interface SupportViewProps {
  authToken: string;
  currentUser: AuthUser;
  preferences: PlatformPreferences;
  onPreferencesUpdated: (next: PlatformPreferences) => void;
  onUserRefresh: () => Promise<void>;
}

export function SupportView({
  authToken,
  currentUser,
  preferences,
  onPreferencesUpdated,
  onUserRefresh,
}: SupportViewProps) {
  // Support / Complaints state
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [category, setCategory] = useState<SupportTicketCategory>('complaint');
  const [priority, setPriority] = useState<SupportTicketPriority>('normal');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submittingTicket, setSubmittingTicket] = useState(false);
  const [ticketFeedback, setTicketFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // User Preferences state
  const [promoOptIn, setPromoOptIn] = useState<boolean>(currentUser.promoEmailsOptIn);
  const [lowCoinThreshold, setLowCoinThreshold] = useState<number>(
    preferences.lowCoinAlertThreshold ?? 10
  );
  const [defaultRegion, setDefaultRegion] = useState<DeployRegion>(preferences.defaultRegion);
  const [defaultRestartPolicy, setDefaultRestartPolicy] = useState<RestartPolicy>(
    preferences.defaultRestartPolicy
  );
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsFeedback, setPrefsFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const loadTickets = useCallback(async () => {
    try {
      const resp = await fetch('/api/support/tickets', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as { tickets?: SupportTicket[] };
      if (Array.isArray(data.tickets)) setTickets(data.tickets);
    } finally {
      setLoadingTickets(false);
    }
  }, [authToken]);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    setPromoOptIn(currentUser.promoEmailsOptIn);
  }, [currentUser.promoEmailsOptIn]);

  const handleSubmitTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    setTicketFeedback(null);
    if (subject.trim().length < 3) {
      setTicketFeedback({ type: 'error', text: 'Enter a subject (at least 3 characters).' });
      return;
    }
    if (message.trim().length < 8) {
      setTicketFeedback({
        type: 'error',
        text: 'Describe your complaint or request (at least 8 characters).',
      });
      return;
    }

    setSubmittingTicket(true);
    try {
      const resp = await fetch('/api/support/tickets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          category,
          priority,
          subject: subject.trim(),
          message: message.trim(),
        }),
      });
      const data = (await resp.json()) as { ticket?: SupportTicket; error?: string };
      if (!resp.ok || !data.ticket) {
        throw new Error(data.error || 'Could not submit your message.');
      }
      setTickets((prev) => [data.ticket!, ...prev]);
      if (firebaseAuth.currentUser?.emailVerified) {
        void syncTicketToFirestore(firebaseAuth.currentUser, data.ticket!).catch(() => {});
      }
      setSubject('');
      setMessage('');
      setTicketFeedback({
        type: 'success',
        text: `Complaint sent directly to Admin (${ADMIN_EMAIL}). Replies will appear below.`,
      });
    } catch (err) {
      setTicketFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to send support message.',
      });
    } finally {
      setSubmittingTicket(false);
    }
  };

  const handleSavePrefs = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPrefs(true);
    setPrefsFeedback(null);
    try {
      const resp = await fetch('/api/support/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          promoEmailsOptIn: promoOptIn,
          lowCoinAlertThreshold: lowCoinThreshold,
          defaultRegion,
          defaultRestartPolicy,
        }),
      });
      const data = (await resp.json()) as PlatformPreferences & { error?: string };
      if (!resp.ok) throw new Error(data.error || 'Failed to save preferences.');
      onPreferencesUpdated(data);
      await onUserRefresh();
      setPrefsFeedback({
        type: 'success',
        text: 'Account preferences saved permanently to database.',
      });
    } catch (err) {
      setPrefsFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save preferences.',
      });
    } finally {
      setSavingPrefs(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="atelier-panel relative rounded-lg border border-red-500/25 p-5 sm:p-6">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70"
        />
        <h1 className="font-display text-3xl font-semibold text-slate-50">
          Direct Support &amp; <span className="italic font-medium text-red-400">Preferences</span>
        </h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">
          Send complaints, billing issues, or feedback directly to platform admin{' '}
          <span className="font-mono text-rose-300">{ADMIN_EMAIL}</span>, view live admin responses, and persist your notification preferences.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Complaint / Direct Response Composer (7 cols) */}
        <section className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4 lg:col-span-7">
          <div className="flex items-center justify-between border-b border-red-950/70 pb-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-red-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">
                Write to Admin
              </h2>
            </div>
            <span className="font-mono text-[11px] text-slate-400">Direct Inbox</span>
          </div>

          <form onSubmit={handleSubmitTicket} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-300">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as SupportTicketCategory)}
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 focus:border-red-400 focus:outline-none"
                >
                  <option value="complaint">Complaint</option>
                  <option value="billing">Coins / Billing Issue</option>
                  <option value="bug">Bot Deployment Bug</option>
                  <option value="feature">Feature Request</option>
                  <option value="other">Other Inquiry</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as SupportTicketPriority)}
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 focus:border-red-400 focus:outline-none"
                >
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-300">Subject</label>
              <input
                type="text"
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Briefly summarize your issue or request"
                className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-300">
                Message / Complaint Details
              </label>
              <textarea
                rows={4}
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Explain the issue, bot ID, transaction ref, or feedback..."
                className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
              />
            </div>

            {ticketFeedback && (
              <div
                className={`flex items-start gap-2 rounded-md border p-3 text-xs ${
                  ticketFeedback.type === 'error'
                    ? 'border-red-500/50 bg-red-500/15 text-red-200'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                }`}
              >
                {ticketFeedback.type === 'error' ? (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                )}
                <span>{ticketFeedback.text}</span>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={submittingTicket}
                className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-4 py-2 text-xs font-semibold text-white hover:from-red-500 hover:to-red-600 disabled:opacity-60"
              >
                <Send className="h-3.5 w-3.5" />
                {submittingTicket ? 'Sending...' : 'Send Complaint to Admin'}
              </button>
            </div>
          </form>
        </section>

        {/* Operator Preferences (5 cols) */}
        <section className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4 lg:col-span-5">
          <div className="flex items-center justify-between border-b border-red-950/70 pb-3">
            <div className="flex items-center gap-2">
              <Sliders className="h-4 w-4 text-red-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">
                Operator Preferences
              </h2>
            </div>
            <span className="font-mono text-[10px] text-emerald-400">SQLite Saved</span>
          </div>

          <form onSubmit={handleSavePrefs} className="space-y-4">
            <label className="flex items-start gap-3 rounded-md border border-red-950/80 bg-[#080305] p-3 cursor-pointer">
              <input
                type="checkbox"
                checked={promoOptIn}
                onChange={(e) => setPromoOptIn(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-red-600"
              />
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-100">
                  <Mail className="h-3.5 w-3.5 text-rose-400" />
                  Receive Promotional &amp; Update Emails
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  Allow Lyrihost to send coin promos, coupon drops, and platform updates to{' '}
                  <span className="font-mono text-slate-300">{currentUser.email}</span>.
                </p>
              </div>
            </label>

            <div>
              <label className="block text-[11px] font-medium text-slate-300">
                Low Coin Balance Alert Threshold
              </label>
              <input
                type="number"
                min={0}
                max={1000}
                value={lowCoinThreshold}
                onChange={(e) => setLowCoinThreshold(Number(e.target.value) || 0)}
                className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 tabular-nums focus:border-red-400 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Default Deploy Region
                </label>
                <select
                  value={defaultRegion}
                  onChange={(e) => setDefaultRegion(e.target.value as DeployRegion)}
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 focus:border-red-400 focus:outline-none"
                >
                  {DEPLOY_REGIONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Restart Policy
                </label>
                <select
                  value={defaultRestartPolicy}
                  onChange={(e) => setDefaultRestartPolicy(e.target.value as RestartPolicy)}
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 focus:border-red-400 focus:outline-none"
                >
                  <option value="always">Always restart</option>
                  <option value="on-failure">On failure</option>
                  <option value="never">Never</option>
                </select>
              </div>
            </div>

            {prefsFeedback && (
              <div
                className={`flex items-center gap-2 rounded-md border p-2.5 text-xs ${
                  prefsFeedback.type === 'error'
                    ? 'border-red-500/45 bg-red-500/15 text-red-200'
                    : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
                }`}
              >
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span>{prefsFeedback.text}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={savingPrefs}
              className="inline-flex w-full items-center justify-center rounded-md border border-red-500/45 bg-red-600/20 px-4 py-2 text-xs font-semibold text-red-100 transition-colors hover:bg-red-600/35 disabled:opacity-60"
            >
              {savingPrefs ? 'Saving Preferences...' : 'Save My Preferences'}
            </button>
          </form>
        </section>
      </div>

      {/* User's Ticket & Admin Response History */}
      <section className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-red-950/70 pb-3">
          <h2 className="font-display text-xl font-semibold text-slate-50">
            My Complaints &amp; Admin Responses
          </h2>
          <span className="font-mono text-xs text-slate-400 tabular-nums">
            {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
          </span>
        </div>

        {loadingTickets ? (
          <div className="py-6 text-center text-xs text-slate-500">Loading your tickets...</div>
        ) : tickets.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-500">
            You have not sent any complaints or support messages yet.
          </div>
        ) : (
          <div className="space-y-3">
            {tickets.map((t) => (
              <article
                key={t.id}
                className="rounded-md border border-red-950/80 bg-[#080305] p-4 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-medium text-slate-100">{t.subject}</h3>
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      <span className="capitalize">{t.category}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{t.priority} priority</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">
                        {new Date(t.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <span
                    className={`font-mono text-[11px] uppercase ${
                      t.status === 'resolved'
                        ? 'text-emerald-400'
                        : t.status === 'in_review'
                          ? 'text-amber-300'
                          : 'text-red-300'
                    }`}
                  >
                    {t.status.replace('_', ' ')}
                  </span>
                </div>

                <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
                  {t.message}
                </p>

                {t.adminReply ? (
                  <div className="border-t border-red-950/70 pt-2.5 text-xs">
                    <div className="font-mono text-[10px] uppercase text-emerald-400">
                      Admin Response ({ADMIN_EMAIL})
                    </div>
                    <p className="mt-1 text-slate-200 whitespace-pre-wrap">{t.adminReply}</p>
                  </div>
                ) : (
                  <div className="border-t border-red-950/60 pt-2 text-[11px] text-slate-500">
                    Awaiting response from administrator.
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
