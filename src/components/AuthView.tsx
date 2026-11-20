import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Gift,
  KeyRound,
  Lock,
  Mail,
  RotateCw,
  ShieldCheck,
} from 'lucide-react';
import { LyrihostLogo } from './LyrihostLogo';
import { MatrixRainCanvas } from './MatrixRainCanvas';
import type { AuthUser, DailyStreakReward } from '../types/lyrihost';

interface AuthViewProps {
  onAuthenticated: (token: string, user: AuthUser, streakReward?: DailyStreakReward | null) => void;
}

type AuthTab = 'login' | 'signup';
type AuthStep = 'credentials' | 'verify-otp';
type OtpMode = 'signup' | 'login';

export function AuthView({ onAuthenticated }: AuthViewProps) {
  const [tab, setTab] = useState<AuthTab>(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get('ref');
      return ref ? 'signup' : 'login';
    } catch {
      return 'login';
    }
  });
  const [step, setStep] = useState<AuthStep>('credentials');
  const [otpMode, setOtpMode] = useState<OtpMode>('signup');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [referralCode, setReferralCode] = useState(() => {
    try {
      return (new URLSearchParams(window.location.search).get('ref') || '').trim().toUpperCase();
    } catch {
      return '';
    }
  });
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [otp, setOtp] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  const switchTab = (next: AuthTab) => {
    setTab(next);
    setStep('credentials');
    setOtpMode(next === 'signup' ? 'signup' : 'login');
    setError(null);
    setNotice(null);
    setOtp('');
  };

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
      setError('Please enter a valid email address.');
      return;
    }

    if (tab === 'signup') {
      if (password.length < 6) {
        setError('Password must be at least 6 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      if (!acceptedTerms) {
        setError(
          'You must agree to the Lyrihost Acceptable Use Consent prohibiting bug bots, WhatsApp crashers, malware, and abusive scripts.'
        );
        return;
      }

      setSubmitting(true);
      try {
        const resp = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: cleanEmail,
            password,
            referralCode: referralCode.trim().toUpperCase() || undefined,
            acceptedTerms: true,
          }),
        });
        const data = (await resp.json()) as {
          ok?: boolean;
          email?: string;
          message?: string;
          error?: string;
        };
        if (!resp.ok) {
          throw new Error(data.error || 'Could not initiate signup verification.');
        }
        setEmail(data.email || cleanEmail);
        setOtp('');
        setOtpMode('signup');
        setResendCooldown(30);
        setNotice(data.message || `Verification code sent to ${cleanEmail}.`);
        setStep('verify-otp');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Signup failed.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Login flow (sends 6-digit login security OTP)
    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setSubmitting(true);
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, password }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        requiresOtp?: boolean;
        token?: string;
        user?: AuthUser;
        streakReward?: DailyStreakReward | null;
        needsVerification?: boolean;
        email?: string;
        message?: string;
        error?: string;
      };
      if (resp.status === 403 && data.needsVerification) {
        setEmail(data.email || cleanEmail);
        setTab('signup');
        setOtpMode('signup');
        setStep('verify-otp');
        setNotice('Complete your email OTP verification to activate your account.');
        return;
      }
      if (!resp.ok) {
        throw new Error(data.error || 'Invalid email or password.');
      }
      if (data.requiresOtp) {
        setEmail(data.email || cleanEmail);
        setOtp('');
        setOtpMode('login');
        setResendCooldown(30);
        setNotice(data.message || `Login security OTP sent to ${cleanEmail}.`);
        setStep('verify-otp');
        return;
      }
      if (data.token && data.user) {
        onAuthenticated(data.token, data.user, data.streakReward ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const cleanOtp = otp.replace(/\D/g, '');
    if (cleanOtp.length !== 6) {
      setError('Please enter the 6-digit verification code from your email.');
      return;
    }

    setSubmitting(true);
    try {
      const endpoint =
        otpMode === 'login' ? '/api/auth/verify-login-otp' : '/api/auth/verify-otp';
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), otp: cleanOtp }),
      });
      const data = (await resp.json()) as {
        token?: string;
        user?: AuthUser;
        streakReward?: DailyStreakReward | null;
        error?: string;
      };
      if (!resp.ok || !data.token || !data.user) {
        throw new Error(data.error || 'OTP verification failed.');
      }
      onAuthenticated(data.token, data.user, data.streakReward ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OTP verification failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResendOtp = async () => {
    if (resendCooldown > 0 || resending) return;
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      const endpoint =
        otpMode === 'login' ? '/api/auth/resend-login-otp' : '/api/auth/resend-otp';
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = (await resp.json()) as { ok?: boolean; message?: string; error?: string };
      if (!resp.ok) {
        throw new Error(data.error || 'Unable to resend verification code.');
      }
      setResendCooldown(30);
      setNotice(data.message || `A fresh verification code was sent to ${email.trim().toLowerCase()}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resend OTP.');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col justify-center bg-[#080305] px-4 py-10 text-slate-200">
      <MatrixRainCanvas intensity="subtle" hasAlert={false} />

      <div className="relative z-10 mx-auto w-full max-w-md space-y-6">
        <div className="flex flex-col items-center text-center">
          <LyrihostLogo />
          <p className="mt-2.5 text-xs text-slate-400">
            Bot Hosting Console · Encrypted Session Access
          </p>
        </div>

        <section className="atelier-panel relative rounded-lg border border-red-500/30 p-6 sm:p-7">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-red-400/70"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-red-400/70"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-0 h-2.5 w-2.5 border-b border-l border-red-400/70"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 right-0 h-2.5 w-2.5 border-b border-r border-red-400/70"
          />

          {step === 'credentials' ? (
            <>
              {/* Tab Switcher */}
              <div className="grid grid-cols-2 gap-1 rounded-md border border-red-950/90 bg-[#080305] p-1">
                <button
                  type="button"
                  onClick={() => switchTab('login')}
                  className={`rounded py-2 text-xs font-semibold transition-colors ${
                    tab === 'login'
                      ? 'border border-red-500/40 bg-red-600/20 text-red-200'
                      : 'border border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Log In
                </button>
                <button
                  type="button"
                  onClick={() => switchTab('signup')}
                  className={`rounded py-2 text-xs font-semibold transition-colors ${
                    tab === 'signup'
                      ? 'border border-red-500/40 bg-red-600/20 text-red-200'
                      : 'border border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Create Account
                </button>
              </div>

              <div className="mt-5">
                <h1 className="font-display text-2xl font-semibold text-slate-50">
                  {tab === 'login' ? 'Operator Sign In' : 'Create Operator Account'}
                </h1>
                <p className="mt-1 text-xs text-slate-400">
                  {tab === 'login'
                    ? 'Enter your email and password. A 6-digit security OTP will be sent to your inbox to finish signing in.'
                    : 'Enter your email and password. We will send a 6-digit OTP to verify your inbox.'}
                </p>
              </div>

              <form onSubmit={handleCredentialsSubmit} className="mt-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300">Email Address</label>
                  <div className="relative mt-1.5">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-red-400" />
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="operator@domain.com"
                      className="w-full rounded-md border border-red-950/90 bg-[#080305] py-2 pl-9 pr-3 text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300">Password</label>
                  <div className="relative mt-1.5">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-red-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={tab === 'signup' ? 'At least 6 characters' : 'Enter password'}
                      className="w-full rounded-md border border-red-950/90 bg-[#080305] py-2 pl-9 pr-9 text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    >
                      {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>

                {tab === 'signup' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-300">Confirm Password</label>
                      <div className="relative mt-1.5">
                        <Lock className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-rose-400" />
                        <input
                          type={showPassword ? 'text' : 'password'}
                          required
                          autoComplete="new-password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Repeat password"
                          className="w-full rounded-md border border-red-950/90 bg-[#080305] py-2 pl-9 pr-3 text-xs text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="flex items-center justify-between text-xs font-medium text-slate-300">
                        <span>Referral Code (optional)</span>
                        <span className="font-mono text-[10px] text-emerald-400">+2 Coins to referrer</span>
                      </label>
                      <div className="relative mt-1.5">
                        <Gift className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-rose-400" />
                        <input
                          type="text"
                          value={referralCode}
                          onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                          placeholder="e.g. LYR-XXXXXX"
                          className="w-full rounded-md border border-red-950/90 bg-[#080305] py-2 pl-9 pr-3 font-mono text-xs uppercase text-slate-100 placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="rounded-md border border-red-500/30 bg-[#0d0508] p-3">
                      <label className="flex items-start gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={acceptedTerms}
                          onChange={(e) => setAcceptedTerms(e.target.checked)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
                        />
                        <span className="text-[11px] leading-relaxed text-slate-300">
                          <span className="font-semibold text-rose-200">
                            Acceptable Use &amp; Anti-Bug-Bot Consent (Required):
                          </span>{' '}
                          I agree that I will <strong className="text-red-300">NOT</strong> deploy bug bots, WhatsApp crashers, DDoS/spam flooders, crypto miners, malware, or weird/harmful scripts on Lyrihost. Violations result in immediate bot termination and account suspension.
                        </span>
                      </label>
                    </div>
                  </>
                )}

                {error && (
                  <div className="flex items-start gap-2 rounded-md border border-red-500/50 bg-red-500/15 p-3 text-xs text-red-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                    <span>{error}</span>
                  </div>
                )}

                {notice && (
                  <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    <span>{notice}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-4 py-2.5 text-xs font-semibold text-white shadow-[0_1px_12px_rgba(220,38,38,0.28)] transition-all hover:from-red-500 hover:to-red-600 disabled:opacity-60"
                >
                  {submitting && <RotateCw className="h-3.5 w-3.5 animate-spin" />}
                  {tab === 'login'
                    ? submitting
                      ? 'Sending Security OTP...'
                      : 'Continue with Login OTP'
                    : submitting
                      ? 'Sending Email OTP...'
                      : 'Send Verification OTP'}
                </button>
              </form>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setStep('credentials');
                  setError(null);
                  setNotice(null);
                }}
                className="inline-flex items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {otpMode === 'login' ? 'Back to log in' : 'Back to sign up'}
              </button>

              <div className="mt-4">
                <h1 className="font-display text-2xl font-semibold text-slate-50">
                  {otpMode === 'login' ? (
                    <>
                      Login Security <span className="italic font-medium text-red-400">OTP</span>
                    </>
                  ) : (
                    <>
                      Verify Your <span className="italic font-medium text-red-400">Email OTP</span>
                    </>
                  )}
                </h1>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  {otpMode === 'login'
                    ? 'Enter the 6-digit security code sent to '
                    : 'Enter the 6-digit verification code sent to '}
                  <span className="font-mono text-rose-300">{email}</span>.
                </p>
              </div>

              <form onSubmit={handleVerifyOtp} className="mt-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300">
                    {otpMode === 'login'
                      ? '6-Digit Login Security Code'
                      : '6-Digit Email Verification Code'}
                  </label>
                  <div className="relative mt-1.5">
                    <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-red-400" />
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      autoFocus
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      className="w-full rounded-md border border-red-900/90 bg-[#080305] py-2.5 pl-10 pr-4 font-mono text-lg font-semibold tracking-[0.35em] text-slate-100 tabular-nums placeholder:tracking-[0.25em] placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
                    />
                  </div>
                </div>

                {error && (
                  <div className="flex items-start gap-2 rounded-md border border-red-500/50 bg-red-500/15 p-3 text-xs text-red-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                    <span>{error}</span>
                  </div>
                )}

                {notice && (
                  <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    <span>{notice}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-4 py-2.5 text-xs font-semibold text-white shadow-[0_1px_12px_rgba(220,38,38,0.28)] transition-all hover:from-red-500 hover:to-red-600 disabled:opacity-60"
                >
                  {submitting ? (
                    <RotateCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  {submitting
                    ? 'Verifying OTP...'
                    : otpMode === 'login'
                      ? 'Verify Security OTP & Sign In'
                      : 'Verify OTP & Create Account'}
                </button>

                <div className="flex items-center justify-between border-t border-red-950/70 pt-3 text-xs">
                  <span className="text-slate-500">Did not receive the email?</span>
                  <button
                    type="button"
                    disabled={resendCooldown > 0 || resending}
                    onClick={handleResendOtp}
                    className="font-medium text-red-300 transition-colors hover:text-red-200 disabled:cursor-not-allowed disabled:text-slate-500 tabular-nums"
                  >
                    {resending
                      ? 'Sending...'
                      : resendCooldown > 0
                        ? `Resend in ${resendCooldown}s`
                        : 'Resend OTP'}
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
