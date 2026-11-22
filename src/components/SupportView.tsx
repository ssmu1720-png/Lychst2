import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Mail,
  MessageSquare,
  Phone,
  Send,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { firebaseAuth } from '../lib/firebase';
import { syncTicketToFirestore } from '../lib/firestoreStore';
import {
  ADMIN_EMAIL,
  DEPLOY_REGIONS,
  SUPPORT_PHONE,
  type AuthUser,
  type DeployRegion,
  type PlatformPreferences,
  type RestartPolicy,
  type SupportTicket,
  type SupportTicketCategory,
  type SupportTicketPriority,
} from '../types/lyrihost';

interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  escalateRecommended?: boolean;
}

const QUICK_ISSUE_PROMPTS = [
  'My bot is online but not replying to messages',
  'WhatsApp session rejected / 401 or QR error',
  'Bot has high latency or keeps disconnecting',
  'M-Pesa / Coins balance or deployment error',
] as const;

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

  // AI Support Assistant state
  const [aiMessages, setAiMessages] = useState<AiChatMessage[]>([]);
  const [aiInput, setAiInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const ticketFormRef = useRef<HTMLElement | null>(null);

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

  const sendAiSupportQuery = async (overrideText?: string) => {
    const promptText = (overrideText ?? aiInput).trim();
    if (promptText.length < 2 || aiLoading) return;

    setAiError(null);
    const userMsg: AiChatMessage = {
      id: `usr_${Date.now()}`,
      role: 'user',
      text: promptText,
    };
    const nextHistory = [...aiMessages, userMsg];
    setAiMessages(nextHistory);
    if (!overrideText) setAiInput('');
    setAiLoading(true);

    try {
      const resp = await fetch('/api/support/ai-assist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          message: promptText,
          history: aiMessages.map((m) => ({ role: m.role, text: m.text })),
        }),
      });
      const data = (await resp.json()) as {
        reply?: string;
        escalateRecommended?: boolean;
        error?: string;
      };
      if (!resp.ok || !data.reply) {
        throw new Error(data.error || 'Unable to get a response from AI Support.');
      }

      setAiMessages((prev) => [
        ...prev,
        {
          id: `ast_${Date.now()}`,
          role: 'assistant',
          text: data.reply!,
          escalateRecommended: Boolean(data.escalateRecommended),
        },
      ]);
    } catch (err) {
      setAiError(
        err instanceof Error
          ? err.message
          : `AI Support failed. For urgent help reach WhatsApp ${SUPPORT_PHONE} or ${ADMIN_EMAIL}.`
      );
    } finally {
      setAiLoading(false);
    }
  };

  const handleEscalateConversationToTicket = () => {
    const lastUser = [...aiMessages].reverse().find((m) => m.role === 'user');
    const summaryLines = aiMessages
      .slice(-4)
      .map((m) => `${m.role === 'user' ? 'Operator' : 'AI Support'}: ${m.text}`)
      .join('\n\n');

    setCategory('bug');
    setPriority('high');
    setSubject(
      lastUser
        ? `Escalated Issue: ${lastUser.text.slice(0, 70)}`
        : 'Escalated Bot / Platform Support Request'
    );
    setMessage(summaryLines || 'Need manual support assistance.');
    ticketFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="space-y-6">
      {/* Header + Direct Human Support Channels */}
      <section className="atelier-panel relative rounded-lg border border-red-500/25 p-5 sm:p-6">
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
            <h1 className="font-display text-3xl font-semibold text-slate-50">
              AI Support &amp; <span className="italic font-medium text-red-400">Escalation</span>
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">
              Describe any bot or hosting problem to our AI assistant for instant troubleshooting. If an issue is hard or needs manual checks, reach human support directly below.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <a
              href={`https://wa.me/${SUPPORT_PHONE}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-emerald-500/45 bg-emerald-500/10 px-3.5 py-2 font-mono text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20"
            >
              <Phone className="h-3.5 w-3.5 text-emerald-400" />
              WhatsApp / Call: {SUPPORT_PHONE}
            </a>
            <a
              href={`mailto:${ADMIN_EMAIL}`}
              className="inline-flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3.5 py-2 font-mono text-xs font-medium text-rose-200 transition-colors hover:bg-red-500/20"
            >
              <Mail className="h-3.5 w-3.5 text-red-400" />
              {ADMIN_EMAIL}
            </a>
          </div>
        </div>
      </section>

      {/* AI Troubleshooting Assistant */}
      <section className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-950/70 pb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-red-400" />
            <h2 className="font-display text-xl font-semibold text-slate-50">
              Lyrihost AI Support Assistant
            </h2>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-400">
            <span className="font-mono">24/7 Automated Diagnostics</span>
            {aiMessages.length > 0 && (
              <button
                type="button"
                onClick={handleEscalateConversationToTicket}
                className="rounded border border-amber-500/45 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20"
              >
                Hard Issue? Send to Admin Ticket
              </button>
            )}
          </div>
        </div>

        {/* Quick-issue preset prompts */}
        <div className="flex flex-wrap gap-2">
          {QUICK_ISSUE_PROMPTS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={aiLoading}
              onClick={() => void sendAiSupportQuery(preset)}
              className="rounded-md border border-red-950/90 bg-[#080305] px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-red-500/50 hover:text-slate-100 disabled:opacity-50"
            >
              {preset}
            </button>
          ))}
        </div>

        {/* Conversation Thread */}
        <div className="max-h-96 space-y-3 overflow-y-auto rounded-md border border-red-950/80 bg-[#080305] p-3.5">
          {aiMessages.length === 0 ? (
            <div className="flex items-start gap-3 text-xs text-slate-400">
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <div className="space-y-1.5">
                <p className="text-slate-200 font-medium">
                  Describe what happened with your bot or account.
                </p>
                <p className="leading-relaxed">
                  Include error logs, bot name, or symptoms (e.g., not responding, pairing error, coins/M-Pesa delay). I will inspect your bot status and walk you through the fix — and if it needs manual help, I will connect you directly to human support (<span className="font-mono text-emerald-300">{SUPPORT_PHONE}</span> · <span className="font-mono text-rose-300">{ADMIN_EMAIL}</span>).
                </p>
              </div>
            </div>
          ) : (
            aiMessages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-md border p-3 text-xs ${
                  msg.role === 'user'
                    ? 'ml-auto max-w-2xl border-red-500/35 bg-red-950/25 text-slate-100'
                    : 'mr-auto max-w-3xl border-red-950/90 bg-[#0f0609] text-slate-200'
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-2 font-mono text-[10px] uppercase text-slate-400">
                  <span>{msg.role === 'user' ? currentUser.email : 'Lyrihost AI Assistant'}</span>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>

                {msg.role === 'assistant' && msg.escalateRecommended && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-red-950/70 pt-2.5 text-[11px]">
                    <span className="text-amber-300 font-medium">Need human help?</span>
                    <a
                      href={`https://wa.me/${SUPPORT_PHONE}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono text-emerald-200 hover:bg-emerald-500/20"
                    >
                      WhatsApp {SUPPORT_PHONE}
                    </a>
                    <a
                      href={`mailto:${ADMIN_EMAIL}`}
                      className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 font-mono text-rose-200 hover:bg-red-500/20"
                    >
                      {ADMIN_EMAIL}
                    </a>
                    <button
                      type="button"
                      onClick={handleEscalateConversationToTicket}
                      className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-medium text-amber-200 hover:bg-amber-500/20"
                    >
                      Open Admin Ticket
                    </button>
                  </div>
                )}
              </div>
            ))
          )}

          {aiLoading && (
            <div className="rounded-md border border-red-950/80 bg-[#0f0609] p-3 text-xs text-slate-400">
              Analyzing your issue and checking bot diagnostics...
            </div>
          )}
        </div>

        {aiError && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-500/45 bg-red-500/15 p-3 text-xs text-red-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
              <span>{aiError}</span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <a
                href={`https://wa.me/${SUPPORT_PHONE}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-emerald-300"
              >
                WhatsApp {SUPPORT_PHONE}
              </a>
              <span aria-hidden="true">·</span>
              <a href={`mailto:${ADMIN_EMAIL}`} className="underline text-rose-300">
                {ADMIN_EMAIL}
              </a>
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendAiSupportQuery();
          }}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <input
            type="text"
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            placeholder="Describe your issue (e.g. bot slow, offline, session rejected, coins)..."
            className="flex-1 rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={aiLoading || aiInput.trim().length < 2}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-4 py-2 text-xs font-semibold text-white hover:from-red-500 hover:to-red-600 disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            <Send className="h-3.5 w-3.5" />
            {aiLoading ? 'Checking...' : 'Ask AI Support'}
          </button>
        </form>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Complaint / Direct Response Composer (7 cols) */}
        <section
          ref={ticketFormRef}
          className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4 lg:col-span-7"
        >
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
