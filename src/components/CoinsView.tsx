import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Clock,
  Coins,
  Copy,
  Cpu,
  Flame,
  Gift,
  PlusCircle,
  RefreshCw,
  Rocket,
  RotateCw,
  Send,
  ShieldCheck,
  Smartphone,
  Ticket,
  Users,
  XCircle,
} from 'lucide-react';
import {
  DEPLOYMENT_PLANS,
  type AuthUser,
  type CoinPurchase,
  type CoinTransaction,
  type DailyStreakReward,
  type DeploymentPlanId,
  type MpesaStkRequest,
  type ReferralEntry,
} from '../types/lyrihost';

interface CoinsViewProps {
  authToken: string;
  currentUser: AuthUser;
  onUserUpdated: (user: AuthUser) => void;
  onDeployWithPlan: (planId: DeploymentPlanId) => void;
}

const PRESET_PACKS = [
  { coins: 10, label: '15d Bot Pack' },
  { coins: 25, label: '30d Pro Pack' },
  { coins: 50, label: 'Unlimited RAM Pack' },
  { coins: 100, label: 'Fleet Builder' },
  { coins: 250, label: 'Agency Bundle' },
];

export function CoinsView({
  authToken,
  currentUser,
  onUserUpdated,
  onDeployWithPlan,
}: CoinsViewProps) {
  const [transactions, setTransactions] = useState<CoinTransaction[]>([]);
  const [purchases, setPurchases] = useState<CoinPurchase[]>([]);
  const [mpesaRequests, setMpesaRequests] = useState<MpesaStkRequest[]>([]);
  const [mpesaGateway, setMpesaGateway] = useState<{
    credentialsSaved: boolean;
    gatewayConfigured: boolean;
    gatewayUrlHint: string;
    keyPrefix: string;
  } | null>(null);
  const [referrals, setReferrals] = useState<ReferralEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // M-Pesa STK Push state (1 Coin = 1 KSH — 0 coins until confirmed)
  const [purchaseAmount, setPurchaseAmount] = useState('50');
  const [mpesaPhone, setMpesaPhone] = useState('');
  const [sendingStk, setSendingStk] = useState(false);
  const [checkingStkId, setCheckingStkId] = useState<string | null>(null);

  // Transfer state
  const [recipientEmail, setRecipientEmail] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferring, setTransferring] = useState(false);

  // Coupon state
  const [couponCode, setCouponCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);

  // Streak state
  const [claimingStreak, setClaimingStreak] = useState(false);

  // Copy feedback
  const [copiedKey, setCopiedKey] = useState<'code' | 'link' | null>(null);

  // Unified feedback banner
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const loadWallet = useCallback(async () => {
    try {
      const resp = await fetch('/api/wallet/summary', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        user?: AuthUser;
        transactions?: CoinTransaction[];
        purchases?: CoinPurchase[];
        mpesaRequests?: MpesaStkRequest[];
        mpesaGateway?: {
          credentialsSaved: boolean;
          gatewayConfigured: boolean;
          gatewayUrlHint: string;
          keyPrefix: string;
        };
        referrals?: ReferralEntry[];
      };
      if (data.user) onUserUpdated(data.user);
      if (Array.isArray(data.transactions)) setTransactions(data.transactions);
      if (Array.isArray(data.purchases)) setPurchases(data.purchases);
      if (Array.isArray(data.mpesaRequests)) setMpesaRequests(data.mpesaRequests);
      if (data.mpesaGateway) setMpesaGateway(data.mpesaGateway);
      if (Array.isArray(data.referrals)) setReferrals(data.referrals);
    } finally {
      setLoading(false);
    }
  }, [authToken, onUserUpdated]);

  useEffect(() => {
    void loadWallet();
  }, [loadWallet]);

  useEffect(() => {
    const hasPendingStk = mpesaRequests.some(
      (r) => r.status === 'pending' && r.gatewayDispatched
    );
    if (!hasPendingStk) return;
    const timer = window.setInterval(() => {
      void loadWallet();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [mpesaRequests, loadWallet]);

  const handleClaimStreak = async () => {
    setClaimingStreak(true);
    setFeedback(null);
    try {
      const resp = await fetch('/api/wallet/streak/claim', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = (await resp.json()) as {
        user?: AuthUser;
        reward?: DailyStreakReward;
        error?: string;
      };
      if (!resp.ok) throw new Error(data.error || 'Could not claim daily streak.');
      if (data.user) onUserUpdated(data.user);
      if (data.reward) {
        setFeedback({
          type: data.reward.claimedNow ? 'success' : 'error',
          text: data.reward.message,
        });
      }
      await loadWallet();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to claim daily login streak.',
      });
    } finally {
      setClaimingStreak(false);
    }
  };

  const handleSendMpesaStkPush = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Math.floor(Number(purchaseAmount));
    if (!Number.isInteger(qty) || qty < 1) {
      setFeedback({ type: 'error', text: 'Enter a valid coin amount (minimum 1 Coin / 1 KSH).' });
      return;
    }
    if (!mpesaPhone.trim()) {
      setFeedback({
        type: 'error',
        text: 'Enter your Safaricom M-Pesa phone number (e.g. 0712345678 or 254712345678).',
      });
      return;
    }

    setSendingStk(true);
    setFeedback(null);
    try {
      const resp = await fetch('/api/wallet/mpesa/stk-push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          phoneNumber: mpesaPhone.trim(),
          coins: qty,
        }),
      });
      const data = (await resp.json()) as {
        user?: AuthUser;
        request?: MpesaStkRequest;
        dispatch?: {
          dispatched: boolean;
          gatewayConfigured: boolean;
          customerMessage: string;
        };
        error?: string;
      };
      if (!resp.ok) throw new Error(data.error || 'Could not initiate M-Pesa STK prompt.');
      if (data.user) onUserUpdated(data.user);
      setFeedback({
        type: data.dispatch?.dispatched ? 'success' : 'error',
        text:
          data.dispatch?.customerMessage ||
          'STK request recorded as Pending. Coins will only be credited once M-Pesa confirms payment.',
      });
      await loadWallet();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'M-Pesa STK Push initiation failed.',
      });
    } finally {
      setSendingStk(false);
    }
  };

  const handleCheckMpesaStatus = async (requestId: string) => {
    setCheckingStkId(requestId);
    setFeedback(null);
    try {
      const resp = await fetch(`/api/wallet/mpesa/status/${encodeURIComponent(requestId)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = (await resp.json()) as {
        request?: MpesaStkRequest;
        user?: AuthUser;
        error?: string;
      };
      if (!resp.ok || !data.request) {
        throw new Error(data.error || 'Could not check payment status.');
      }
      if (data.user) onUserUpdated(data.user);
      if (data.request.status === 'completed') {
        setFeedback({
          type: 'success',
          text: `Payment confirmed (${data.request.mpesaReceipt || 'M-Pesa'})! +${data.request.coins} Coins credited.`,
        });
      } else if (data.request.status === 'failed') {
        setFeedback({
          type: 'error',
          text: `Payment not completed: ${data.request.gatewayMessage || 'Cancelled or failed.'} (0 Coins credited)`,
        });
      } else {
        setFeedback({
          type: 'error',
          text: 'Still waiting for M-Pesa confirmation on phone. 0 Coins credited until payment succeeds.',
        });
      }
      await loadWallet();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Status check failed.',
      });
    } finally {
      setCheckingStkId(null);
    }
  };

  const handleTransferCoins = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Math.floor(Number(transferAmount));
    if (!recipientEmail.trim()) {
      setFeedback({ type: 'error', text: 'Enter the recipient user email address.' });
      return;
    }
    if (!Number.isInteger(qty) || qty < 1) {
      setFeedback({ type: 'error', text: 'Enter at least 1 Coin to transfer.' });
      return;
    }

    setTransferring(true);
    setFeedback(null);
    try {
      const resp = await fetch('/api/wallet/transfer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          recipientEmail: recipientEmail.trim(),
          amount: qty,
          note: transferNote.trim() || undefined,
        }),
      });
      const data = (await resp.json()) as {
        user?: AuthUser;
        message?: string;
        error?: string;
      };
      if (!resp.ok) throw new Error(data.error || 'Transfer failed.');
      if (data.user) onUserUpdated(data.user);
      setRecipientEmail('');
      setTransferAmount('');
      setTransferNote('');
      setFeedback({
        type: 'success',
        text: data.message || `Sent ${qty} Coins successfully.`,
      });
      await loadWallet();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Transfer failed.',
      });
    } finally {
      setTransferring(false);
    }
  };

  const handleRedeemCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!couponCode.trim()) {
      setFeedback({ type: 'error', text: 'Enter a coupon code to redeem.' });
      return;
    }
    setRedeeming(true);
    setFeedback(null);
    try {
      const resp = await fetch('/api/wallet/coupons/redeem', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ code: couponCode.trim() }),
      });
      const data = (await resp.json()) as {
        user?: AuthUser;
        message?: string;
        error?: string;
      };
      if (!resp.ok) throw new Error(data.error || 'Invalid or expired coupon.');
      if (data.user) onUserUpdated(data.user);
      setCouponCode('');
      setFeedback({
        type: 'success',
        text: data.message || 'Coupon redeemed.',
      });
      await loadWallet();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to redeem coupon.',
      });
    } finally {
      setRedeeming(false);
    }
  };

  const referralUrl = `${window.location.origin}/?ref=${encodeURIComponent(currentUser.referralCode)}`;

  const copyText = (text: string, which: 'code' | 'link') => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(which);
    window.setTimeout(() => setCopiedKey(null), 2000);
  };

  const numericPurchaseAmount = Math.max(0, Math.floor(Number(purchaseAmount) || 0));

  return (
    <div className="space-y-6">
      {/* Header Wallet & Streak Summary */}
      <section className="atelier-panel relative rounded-lg border border-red-500/30 p-5 sm:p-6">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70"
        />

        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>Lyrihost Economy</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-rose-300">1 Coin = 1 KSH</span>
              <span aria-hidden="true">·</span>
              <span>1 Referral = 2 Coins</span>
            </div>
            <h1 className="mt-1 font-display text-3xl font-semibold text-slate-50">
              Coins, Plans &amp; <span className="italic font-medium text-red-400">Referrals</span>
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">
              Top up your wallet in KSH, earn daily login streak coins, invite friends for 2 Coins per signup, transfer coins to other operators, or redeem admin coupons.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:shrink-0">
            <div className="rounded-md border border-red-950/90 bg-[#080305] px-4 py-3">
              <div className="text-[10px] text-slate-400">Wallet Balance</div>
              <div className="mt-1 font-mono text-xl font-semibold text-red-300 tabular-nums">
                {currentUser.unlimitedCoins ? 'Unlimited' : `${currentUser.coinBalance} Coins`}
              </div>
              <div className="font-mono text-[10px] text-slate-500 tabular-nums">
                {currentUser.unlimitedCoins ? 'Admin Unlimited' : `${currentUser.coinBalance} KSH value`}
              </div>
            </div>

            <div className="rounded-md border border-red-950/90 bg-[#080305] px-4 py-3">
              <div className="text-[10px] text-slate-400">Daily Streak</div>
              <div className="mt-1 flex items-center gap-1.5 font-mono text-xl font-semibold text-amber-300 tabular-nums">
                <Flame className="h-4 w-4 text-amber-400" />
                Day {currentUser.streakCount}
              </div>
              <div className="text-[10px] text-slate-500">
                {currentUser.canClaimDailyStreak ? 'Today +1 Coin ready' : 'Today +1 Coin claimed'}
              </div>
            </div>

            <div className="col-span-2 rounded-md border border-red-950/90 bg-[#080305] px-4 py-3 sm:col-span-1">
              <div className="text-[10px] text-slate-400">Bot Quota &amp; Referrals</div>
              <div className="mt-1 font-mono text-xl font-semibold text-slate-100 tabular-nums">
                {currentUser.activeDeploymentsCount}
                <span className="text-xs font-normal text-slate-500">
                  /{currentUser.unlimitedCoins ? '∞' : currentUser.maxDeployments} bots
                </span>
              </div>
              <div className="font-mono text-[10px] text-emerald-400 tabular-nums">
                {currentUser.referralCount} referrals ({currentUser.referralCount * 2} Coins)
              </div>
            </div>
          </div>
        </div>

        {/* Daily Login Streak Bar */}
        <div className="mt-5 flex flex-col gap-3 border-t border-red-950/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-amber-300">
              <Flame className="h-4 w-4 text-amber-400" />
              Daily Login Streak (+1 Coin / day)
            </span>
            <div className="flex items-center gap-1 font-mono text-[11px] tabular-nums">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                const cycleDay =
                  currentUser.streakCount > 0 ? ((currentUser.streakCount - 1) % 7) + 1 : 0;
                const done = day <= cycleDay;
                return (
                  <span
                    key={day}
                    className={`flex h-6 w-7 items-center justify-center rounded border text-[10px] ${
                      done
                        ? 'border-amber-500/50 bg-amber-500/20 text-amber-200'
                        : 'border-red-950/80 bg-[#0a0406] text-slate-500'
                    }`}
                  >
                    D{day}
                  </span>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            disabled={claimingStreak || !currentUser.canClaimDailyStreak}
            onClick={() => void handleClaimStreak()}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-500/45 bg-amber-500/15 px-3.5 py-1.5 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            {claimingStreak ? (
              <RotateCw className="h-3.5 w-3.5 animate-spin" />
            ) : currentUser.canClaimDailyStreak ? (
              <PlusCircle className="h-3.5 w-3.5" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            )}
            {currentUser.canClaimDailyStreak
              ? 'Claim Today +1 Coin'
              : 'Today +1 Coin Claimed'}
          </button>
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

      {/* Deployment Plans & RAM Allocation Tiers */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-50">
              Deployment Plans &amp; RAM Allocation
            </h2>
            <p className="text-xs text-slate-400">
              Unlimited plan bots receive higher priority cluster RAM (2048 MB) and never expire.
            </p>
          </div>
          <span className="font-mono text-xs text-rose-300">Rate: 1 Coin = 1 KSH</span>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {DEPLOYMENT_PLANS.map((plan) => {
            const isUnlimited = plan.id === 'plan_unlimited';
            const canAfford =
              currentUser.unlimitedCoins || currentUser.coinBalance >= plan.coinCost;
            return (
              <article
                key={plan.id}
                className={`atelier-panel flex flex-col justify-between rounded-lg border p-5 transition-colors ${
                  isUnlimited ? 'border-red-500/55' : 'border-red-950/90'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                    <span>{plan.durationLabel}</span>
                    <span className="font-mono text-rose-300 tabular-nums">
                      {plan.memoryLimitMb} MB RAM
                    </span>
                  </div>
                  <h3 className="mt-1.5 font-display text-2xl font-semibold text-slate-50">
                    {plan.name}
                  </h3>
                  <div className="mt-3 flex items-baseline gap-2">
                    <span className="font-mono text-3xl font-semibold text-red-300 tabular-nums">
                      {plan.coinCost} Coins
                    </span>
                    <span className="font-mono text-xs text-slate-400 tabular-nums">
                      ({plan.kshCost} KSH)
                    </span>
                  </div>
                  <p className="mt-2.5 text-xs leading-relaxed text-slate-300">{plan.summary}</p>

                  <dl className="mt-4 space-y-1.5 border-t border-red-950/70 pt-3 font-mono text-[11px] tabular-nums">
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Runtime Duration</dt>
                      <dd className="text-slate-200">{plan.durationLabel}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Dedicated Memory</dt>
                      <dd className={isUnlimited ? 'text-emerald-300 font-semibold' : 'text-slate-200'}>
                        {plan.memoryLimitMb} MB {isUnlimited ? '(High RAM)' : ''}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Container Tier</dt>
                      <dd className="uppercase text-rose-300">{plan.computeTier}</dd>
                    </div>
                  </dl>
                </div>

                <button
                  type="button"
                  onClick={() => onDeployWithPlan(plan.id)}
                  className={`mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-4 py-2 text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
                    isUnlimited
                      ? 'bg-gradient-to-b from-red-600 to-red-700 text-white shadow-[0_1px_12px_rgba(220,38,38,0.28)] hover:from-red-500 hover:to-red-600'
                      : 'border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20'
                  }`}
                >
                  <Rocket className="h-3.5 w-3.5" />
                  {canAfford ? `Deploy with ${plan.coinCost} Coins` : `Select (${plan.coinCost} Coins)`}
                </button>
              </article>
            );
          })}
        </div>
      </section>

      {/* Main Action Grid: M-Pesa STK Push Purchase + Transfer Coins */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Buy Coins via M-Pesa STK Prompt (1 Coin = 1 KSH) */}
        <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-red-950/70 pb-3">
            <div className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-emerald-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">
                Buy Coins via M-Pesa STK
              </h2>
            </div>
            <span className="font-mono text-xs text-emerald-400">1 Coin = 1 KSH</span>
          </div>

          <div className="rounded-md border border-red-950/80 bg-[#080305] p-3 text-xs space-y-1.5">
            <div className="font-medium text-slate-200">How to Buy Coins with M-Pesa</div>
            <ol className="list-decimal pl-4 space-y-1 text-[11px] text-slate-400">
              <li>Pick a coin pack or enter an amount in KSH (1 Coin = 1 KSH).</li>
              <li>Enter your Safaricom number (<span className="font-mono text-slate-200">07...</span> or <span className="font-mono text-slate-200">2547...</span>) and click <span className="text-slate-200">Send M-Pesa STK Prompt</span>.</li>
              <li>Enter your M-Pesa PIN on the phone popup. <span className="text-amber-300 font-medium">Zero coins are credited until M-Pesa confirms payment.</span></li>
            </ol>
          </div>

          {mpesaGateway && (
            <div className="flex items-center justify-between rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
              <span>
                Gateway: <span className="font-mono">{mpesaGateway.gatewayUrlHint}</span>
              </span>
              <span className="font-mono text-[10px] text-emerald-300">
                {mpesaGateway.gatewayConfigured ? 'STK /v2 Ready' : 'Not Configured'}
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PRESET_PACKS.map((pack) => {
              const selected = Number(purchaseAmount) === pack.coins;
              return (
                <button
                  key={pack.coins}
                  type="button"
                  onClick={() => setPurchaseAmount(String(pack.coins))}
                  className={`rounded-md border px-3 py-2 text-left transition-colors ${
                    selected
                      ? 'border-red-500/60 bg-red-600/20 text-slate-50'
                      : 'border-red-950/90 bg-[#080305] text-slate-300 hover:border-red-500/35'
                  }`}
                >
                  <div className="font-mono text-sm font-semibold text-red-300 tabular-nums">
                    {pack.coins} Coins
                  </div>
                  <div className="text-[10px] text-slate-400 tabular-nums">
                    {pack.coins} KSH · {pack.label}
                  </div>
                </button>
              );
            })}
          </div>

          <form onSubmit={handleSendMpesaStkPush} className="space-y-3.5 pt-1">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Safaricom Phone Number
                </label>
                <input
                  type="tel"
                  required
                  value={mpesaPhone}
                  onChange={(e) => setMpesaPhone(e.target.value)}
                  placeholder="0712345678 or 254712345678"
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Coins / Amount (KSH)
                </label>
                <input
                  type="number"
                  min={1}
                  max={500000}
                  value={purchaseAmount}
                  onChange={(e) => setPurchaseAmount(e.target.value)}
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 tabular-nums focus:border-red-400 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-red-950/70 pt-3">
              <div className="font-mono text-xs text-slate-300 tabular-nums">
                STK Charge:{' '}
                <span className="font-semibold text-emerald-300">
                  {numericPurchaseAmount} KSH
                </span>
              </div>
              <button
                type="submit"
                disabled={sendingStk || numericPurchaseAmount < 1}
                className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-emerald-600 to-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:from-emerald-500 hover:to-emerald-600 disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                <Smartphone className="h-3.5 w-3.5" />
                {sendingStk
                  ? 'Sending STK Push...'
                  : `Send M-Pesa STK (${numericPurchaseAmount} KSH)`}
              </button>
            </div>
          </form>

          {/* Pending / Confirmed STK Push Tracker */}
          {mpesaRequests.length > 0 && (
            <div className="border-t border-red-950/70 pt-3 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-medium text-slate-300">
                <span>M-Pesa STK Prompt Tracker</span>
                <span className="font-mono text-[10px] text-slate-500">
                  Verified Callback Only
                </span>
              </div>
              <div className="space-y-1.5 max-h-44 overflow-y-auto">
                {mpesaRequests.slice(0, 6).map((req) => (
                  <div
                    key={req.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-950/80 bg-[#080305] px-3 py-2 text-[11px]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-mono text-slate-200 tabular-nums">
                        {req.status === 'completed' ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        ) : req.status === 'failed' ? (
                          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                        ) : (
                          <Clock className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                        )}
                        <span>{req.phoneNumber}</span>
                        <span className="text-slate-500">·</span>
                        <span className="text-rose-300">{req.coins} Coins</span>
                      </div>
                      <div className="truncate text-[10px] text-slate-500">
                        {req.status === 'completed'
                          ? `Confirmed · Receipt ${req.mpesaReceipt || 'VERIFIED'}`
                          : req.status === 'failed'
                            ? `Failed (0 Coins) · ${req.gatewayMessage || 'Unconfirmed'}`
                            : `Pending Confirmation (0 Coins credited)`}
                      </div>
                    </div>

                    {req.status === 'pending' ? (
                      <button
                        type="button"
                        disabled={checkingStkId === req.id}
                        onClick={() => void handleCheckMpesaStatus(req.id)}
                        className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        <RefreshCw
                          className={`h-3 w-3 ${checkingStkId === req.id ? 'animate-spin' : ''}`}
                        />
                        Check Status
                      </button>
                    ) : (
                      <span
                        className={`font-mono text-[10px] uppercase ${
                          req.status === 'completed' ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {req.status}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Transfer Coins to Another User */}
        <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-red-950/70 pb-3">
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-red-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">
                Transfer Coins to User
              </h2>
            </div>
            <span className="text-[11px] text-slate-400">Zero fee · Instant</span>
          </div>

          <p className="text-xs text-slate-400">
            Send coins directly to another verified Lyrihost operator account using their registered email address.
          </p>

          <form onSubmit={handleTransferCoins} className="space-y-3.5">
            <div>
              <label className="block text-[11px] font-medium text-slate-300">
                Recipient Email Address
              </label>
              <input
                type="email"
                required
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                placeholder="friend@domain.com"
                className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Amount (Coins)
                </label>
                <input
                  type="number"
                  required
                  min={1}
                  value={transferAmount}
                  onChange={(e) => setTransferAmount(e.target.value)}
                  placeholder="10"
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-xs text-slate-100 tabular-nums focus:border-red-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300">
                  Note (optional)
                </label>
                <input
                  type="text"
                  value={transferNote}
                  onChange={(e) => setTransferNote(e.target.value)}
                  placeholder="Bot hosting split"
                  className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-red-950/70 pt-3">
              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                Available:{' '}
                {currentUser.unlimitedCoins ? 'Unlimited' : `${currentUser.coinBalance} Coins`}
              </span>
              <button
                type="submit"
                disabled={transferring}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-500/45 bg-red-600/20 px-4 py-2 text-xs font-semibold text-red-100 transition-colors hover:bg-red-600/35 disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                <Send className="h-3.5 w-3.5 text-red-400" />
                {transferring ? 'Sending...' : 'Send Coins'}
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* Referral Program + Coupon Redemption */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Referral Program (7 cols) */}
        <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4 lg:col-span-7">
          <div className="flex items-center justify-between border-b border-red-950/70 pb-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-red-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">
                Referral Program (+2 Coins / Signup)
              </h2>
            </div>
            <span className="font-mono text-xs text-emerald-400 tabular-nums">
              {referrals.length} Joined · {referrals.length * 2} Coins Earned
            </span>
          </div>

          <p className="text-xs text-slate-400">
            Share your referral code or signup link. Whenever a new operator creates and OTP-verifies an account with your code, you receive <span className="font-mono text-emerald-300">+2 Coins</span> automatically.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="text-[10px] text-slate-400 mb-1">Your Referral Code</div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={currentUser.referralCode}
                  className="flex-1 rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 font-mono text-xs font-semibold text-rose-300"
                />
                <button
                  type="button"
                  onClick={() => copyText(currentUser.referralCode, 'code')}
                  className="inline-flex items-center gap-1 rounded-md border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium text-red-200 hover:bg-red-500/20 whitespace-nowrap shrink-0"
                >
                  {copiedKey === 'code' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  {copiedKey === 'code' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div>
              <div className="text-[10px] text-slate-400 mb-1">Shareable Invite Link</div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={referralUrl}
                  className="flex-1 truncate rounded-md border border-red-950/90 bg-[#080305] px-3 py-1.5 font-mono text-[11px] text-slate-300"
                />
                <button
                  type="button"
                  onClick={() => copyText(referralUrl, 'link')}
                  className="inline-flex items-center gap-1 rounded-md border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium text-red-200 hover:bg-red-500/20 whitespace-nowrap shrink-0"
                >
                  {copiedKey === 'link' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  {copiedKey === 'link' ? 'Copied' : 'Link'}
                </button>
              </div>
            </div>
          </div>

          {referrals.length > 0 ? (
            <div className="border-t border-red-950/70 pt-3">
              <div className="text-[11px] font-medium text-slate-300 mb-2">Recent Referrals</div>
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {referrals.map((ref) => (
                  <div
                    key={ref.id}
                    className="flex items-center justify-between rounded border border-red-950/70 bg-[#080305] px-3 py-1.5 text-xs"
                  >
                    <span className="font-mono text-slate-200">{ref.email}</span>
                    <span className="font-mono text-emerald-400 tabular-nums">
                      +{ref.coinsEarned} Coins
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded border border-red-950/70 bg-[#080305] px-3 py-2.5 text-xs text-slate-500">
              No verified referrals yet. Share your link above to start earning 2 Coins per friend.
            </div>
          )}
        </div>

        {/* Redeem Coupon (5 cols) */}
        <div className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-4 lg:col-span-5">
          <div className="flex items-center justify-between border-b border-red-950/70 pb-3">
            <div className="flex items-center gap-2">
              <Ticket className="h-4 w-4 text-red-400" />
              <h2 className="font-display text-xl font-semibold text-slate-50">Redeem Coupon</h2>
            </div>
            <Gift className="h-4 w-4 text-rose-400" />
          </div>

          <p className="text-xs text-slate-400">
            Have a coupon code issued by the Lyrihost admin? Enter it below to credit coins straight to your wallet.
          </p>

          <form onSubmit={handleRedeemCoupon} className="space-y-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-300">Coupon Code</label>
              <input
                type="text"
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                placeholder="LYRI-XXXXXX"
                className="mt-1 w-full rounded-md border border-red-950/90 bg-[#080305] px-3 py-2 font-mono text-sm uppercase tracking-wider text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={redeeming}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-4 py-2 text-xs font-semibold text-white hover:from-red-500 hover:to-red-600 disabled:opacity-60"
            >
              <Ticket className="h-3.5 w-3.5" />
              {redeeming ? 'Redeeming...' : 'Redeem Coupon Code'}
            </button>
          </form>

          {purchases.length > 0 && (
            <div className="border-t border-red-950/70 pt-3">
              <div className="text-[11px] font-medium text-slate-300 mb-2">Recent Purchases</div>
              <div className="space-y-1.5 max-h-28 overflow-y-auto">
                {purchases.slice(0, 4).map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between text-[11px] font-mono tabular-nums"
                  >
                    <span className="truncate text-slate-400">
                      {p.paymentMethod.toUpperCase()} · {p.paymentReference}
                    </span>
                    <span className="text-emerald-400">+{p.coins} Coins</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Ledger History Table */}
      <section className="atelier-panel rounded-lg border border-red-950/90 p-5 space-y-3">
        <div className="flex items-center justify-between border-b border-red-950/70 pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-red-400" />
            <h2 className="font-display text-xl font-semibold text-slate-50">
              Coins &amp; KSH Ledger
            </h2>
          </div>
          <span className="font-mono text-[11px] text-slate-400 tabular-nums">
            {transactions.length} entries
          </span>
        </div>

        {loading ? (
          <div className="py-8 text-center text-xs text-slate-500">Loading transaction ledger...</div>
        ) : transactions.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500">
            No coin activity recorded yet. Claim your daily login streak or purchase coins above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-red-950/70 text-[11px] font-medium text-slate-400">
                  <th className="py-2 pr-3">Date</th>
                  <th className="px-3 py-2">Activity</th>
                  <th className="px-3 py-2">Details</th>
                  <th className="px-3 py-2 text-right">Coins</th>
                  <th className="py-2 pl-3 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-red-950/50">
                {transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-red-500/[0.04]">
                    <td className="py-2 pr-3 font-mono text-[11px] text-slate-400 whitespace-nowrap tabular-nums">
                      {new Date(tx.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] uppercase text-rose-300 whitespace-nowrap">
                      {tx.type.replace('_', ' ')}
                    </td>
                    <td className="px-3 py-2 text-slate-200">{tx.description}</td>
                    <td
                      className={`px-3 py-2 text-right font-mono font-semibold whitespace-nowrap tabular-nums ${
                        tx.amount > 0
                          ? 'text-emerald-400'
                          : tx.amount < 0
                            ? 'text-red-400'
                            : 'text-slate-400'
                      }`}
                    >
                      {tx.amount > 0 ? `+${tx.amount}` : tx.amount}
                    </td>
                    <td className="py-2 pl-3 text-right font-mono text-slate-300 whitespace-nowrap tabular-nums">
                      {currentUser.unlimitedCoins ? 'Unlimited' : tx.balanceAfter}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Bottom reassurance line */}
      <div className="flex items-center justify-between rounded-md border border-red-950/70 bg-[#0a0406] px-4 py-2.5 text-[11px] text-slate-400">
        <span className="flex items-center gap-2">
          <Cpu className="h-3.5 w-3.5 text-red-400" />
          All wallet balances, bot plans, streaks, and referral records persist in SQLite storage.
        </span>
        <span className="font-mono text-rose-300">1 Coin = 1 KSH</span>
      </div>
    </div>
  );
}
