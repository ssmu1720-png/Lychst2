import crypto from 'node:crypto';
import { Router, type IRouter, type NextFunction, type Request, type Response } from 'express';
import {
  buildAuthUser,
  claimDailyStreak,
  createSessionRecord,
  deletePendingLogin,
  deletePendingSignup,
  deleteSession,
  finalizeVerifiedSignup,
  getPendingLogin,
  getPendingSignup,
  getUserByEmail,
  getUserById,
  getUserByReferralCode,
  getValidSession,
  isAdminEmail,
  nowIso,
  savePendingLogin,
  savePendingSignup,
  updatePendingLogin,
  updatePendingSignup,
  type DbUserRow,
} from './db.ts';
import { sendLoginOtpEmail, sendOtpEmail } from './emailService.ts';
import { ADMIN_EMAIL } from '../src/types/lyrihost.ts';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthenticatedRequest extends Request {
  authUser?: DbUserRow;
  authToken?: string;
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

function hashOtp(email: string, otp: string): string {
  return crypto.createHash('sha256').update(`${email}:${otp}`).digest('hex');
}

function constantTimeMatchHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i);
    if (match) return match[1];
  }
  const queryToken = req.query?.token;
  if (typeof queryToken === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(queryToken)) {
    return queryToken;
  }
  return null;
}

export function resolveAuthenticatedUser(req: Request): DbUserRow | null {
  const token = extractBearerToken(req);
  if (!token) return null;
  const session = getValidSession(token);
  if (!session) return null;
  const user = getUserById(session.user_id);
  if (!user || user.verified !== 1) return null;
  return user;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please log in.' });
    return;
  }
  const session = getValidSession(token);
  if (!session) {
    res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    return;
  }
  const user = getUserById(session.user_id);
  if (!user || user.verified !== 1) {
    res.status(401).json({ error: 'Account not found or not verified.' });
    return;
  }
  req.authUser = user;
  req.authToken = token;
  next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const user = req.authUser;
  if (!user || !isAdminEmail(user.email)) {
    res.status(403).json({
      error: `Forbidden: Administrator access is restricted strictly to ${ADMIN_EMAIL}.`,
    });
    return;
  }
  next();
}

export function createAuthRouter(): IRouter {
  const router: IRouter = Router();

  router.get('/me', (req, res) => {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Not authenticated.' });
      return;
    }
    const session = getValidSession(token);
    if (!session) {
      res.status(401).json({ error: 'Session expired or invalid.' });
      return;
    }
    const existing = getUserById(session.user_id);
    if (!existing || existing.verified !== 1) {
      res.status(401).json({ error: 'Account not found or not verified.' });
      return;
    }

    // Automatically award daily streak +1 coin on first active session check of each UTC day
    let streakReward = null;
    let activeUser = existing;
    try {
      const claimRes = claimDailyStreak(existing.id);
      activeUser = claimRes.user;
      if (claimRes.reward.claimedNow) {
        streakReward = claimRes.reward;
      }
    } catch {
      // keep existing user if streak check fails
    }

    res.json({
      user: buildAuthUser(activeUser),
      streakReward,
    });
  });

  router.post('/signup', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        email?: string;
        password?: string;
        referralCode?: string;
        acceptedTerms?: boolean;
      };
      const email = normalizeEmail(body.email || '');
      const password = typeof body.password === 'string' ? body.password : '';
      const rawReferral = typeof body.referralCode === 'string' ? body.referralCode.trim().toUpperCase() : '';

      if (!isValidEmail(email)) {
        res.status(400).json({ error: 'Please enter a valid email address.' });
        return;
      }
      if (password.length < 6) {
        res.status(400).json({ error: 'Password must be at least 6 characters.' });
        return;
      }
      if (body.acceptedTerms !== true) {
        res.status(400).json({
          error:
            'You must agree to the Lyrihost Acceptable Use Consent (no bug bots, WhatsApp crashers, malware, or abusive scripts allowed).',
        });
        return;
      }

      const existingUser = getUserByEmail(email);
      if (existingUser && existingUser.verified === 1) {
        res.status(409).json({
          error: 'An account with this email already exists. Please log in instead.',
        });
        return;
      }

      let validReferralCode: string | null = null;
      if (rawReferral) {
        const referrer = getUserByReferralCode(rawReferral);
        if (!referrer) {
          res.status(400).json({
            error: `Referral code "${rawReferral}" was not found. Clear it or enter a valid code.`,
          });
          return;
        }
        if (referrer.email === email) {
          res.status(400).json({ error: 'You cannot refer your own email address.' });
          return;
        }
        validReferralCode = referrer.referral_code;
      }

      const otpCode = String(crypto.randomInt(100000, 1000000));
      const nowMs = Date.now();

      await sendOtpEmail(email, otpCode);

      savePendingSignup({
        email,
        passwordHash: hashPassword(password),
        otpHash: hashOtp(email, otpCode),
        referralCode: validReferralCode,
        acceptedTerms: true,
        consentAcceptedAt: nowIso(),
        expiresAt: nowMs + OTP_TTL_MS,
        attempts: 0,
        lastSentAt: nowMs,
      });

      res.json({
        ok: true,
        email,
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        message: `Verification OTP sent to ${email}.`,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to send OTP verification email.',
      });
    }
  });

  router.post('/resend-otp', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { email?: string };
      const email = normalizeEmail(body.email || '');
      if (!isValidEmail(email)) {
        res.status(400).json({ error: 'Valid email address is required.' });
        return;
      }

      const pending = getPendingSignup(email);
      if (!pending) {
        res
          .status(404)
          .json({ error: 'No pending signup found for this email. Please sign up again.' });
        return;
      }

      const nowMs = Date.now();
      const elapsed = nowMs - pending.last_sent_at;
      if (elapsed < OTP_RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
        res.status(429).json({ error: `Please wait ${waitSec}s before requesting another code.` });
        return;
      }

      const otpCode = String(crypto.randomInt(100000, 1000000));
      await sendOtpEmail(email, otpCode);

      pending.otp_hash = hashOtp(email, otpCode);
      pending.expires_at = nowMs + OTP_TTL_MS;
      pending.attempts = 0;
      pending.last_sent_at = nowMs;
      updatePendingSignup(pending);

      res.json({
        ok: true,
        email,
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        message: `A fresh OTP code was sent to ${email}.`,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to resend OTP email.',
      });
    }
  });

  router.post('/verify-otp', (req, res) => {
    const body = (req.body ?? {}) as { email?: string; otp?: string };
    const email = normalizeEmail(body.email || '');
    const otp = (body.otp || '').replace(/\s+/g, '');

    if (!isValidEmail(email) || !/^\d{6}$/.test(otp)) {
      res.status(400).json({ error: 'Please enter the 6-digit verification code sent to your email.' });
      return;
    }

    const pending = getPendingSignup(email);
    if (!pending) {
      res.status(404).json({ error: 'Verification request not found. Please sign up again.' });
      return;
    }

    if (pending.expires_at <= Date.now()) {
      deletePendingSignup(email);
      res.status(410).json({ error: 'Verification code expired. Please sign up again.' });
      return;
    }

    if (pending.attempts >= 5) {
      deletePendingSignup(email);
      res
        .status(429)
        .json({ error: 'Too many incorrect attempts. Please request a new verification code.' });
      return;
    }

    const candidateHash = hashOtp(email, otp);
    if (!constantTimeMatchHex(candidateHash, pending.otp_hash)) {
      pending.attempts += 1;
      updatePendingSignup(pending);
      const remaining = Math.max(0, 5 - pending.attempts);
      res.status(401).json({
        error: `Invalid verification code (${remaining} attempt${remaining === 1 ? '' : 's'} remaining).`,
      });
      return;
    }

    const { user, streakReward } = finalizeVerifiedSignup({
      email,
      passwordHash: pending.password_hash,
      referralCodeInput: pending.referral_code,
      acceptedTerms: pending.accepted_terms !== 0,
      consentAcceptedAt: pending.consent_accepted_at || nowIso(),
    });

    const session = createSessionRecord(user, SESSION_TTL_MS);

    res.status(201).json({
      token: session.token,
      user: buildAuthUser(user),
      streakReward,
    });
  });

  router.post('/login', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { email?: string; password?: string };
      const email = normalizeEmail(body.email || '');
      const password = typeof body.password === 'string' ? body.password : '';

      if (!isValidEmail(email) || !password) {
        res.status(400).json({ error: 'Please enter both your email and password.' });
        return;
      }

      const existingUser = getUserByEmail(email);
      if (!existingUser || existingUser.verified !== 1) {
        const pending = getPendingSignup(email);
        if (pending && pending.expires_at > Date.now()) {
          res.status(403).json({
            error:
              'Account pending email verification. Please enter the OTP code sent to your email.',
            needsVerification: true,
            email,
          });
          return;
        }
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }

      if (!verifyPassword(password, existingUser.password_hash)) {
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }

      const otpCode = String(crypto.randomInt(100000, 1000000));
      const nowMs = Date.now();
      await sendLoginOtpEmail(email, otpCode);

      savePendingLogin({
        email,
        otpHash: hashOtp(email, otpCode),
        expiresAt: nowMs + OTP_TTL_MS,
        attempts: 0,
        lastSentAt: nowMs,
      });

      res.json({
        ok: true,
        requiresOtp: true,
        email,
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        message: `Login security OTP sent to ${email}. Enter the 6-digit code to finish signing in.`,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to send login security OTP.',
      });
    }
  });

  router.post('/resend-login-otp', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { email?: string };
      const email = normalizeEmail(body.email || '');
      if (!isValidEmail(email)) {
        res.status(400).json({ error: 'Valid email address is required.' });
        return;
      }

      const pending = getPendingLogin(email);
      if (!pending) {
        res.status(404).json({ error: 'No pending login OTP session found. Please log in again.' });
        return;
      }

      const nowMs = Date.now();
      const elapsed = nowMs - pending.last_sent_at;
      if (elapsed < OTP_RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
        res.status(429).json({ error: `Please wait ${waitSec}s before requesting another login code.` });
        return;
      }

      const otpCode = String(crypto.randomInt(100000, 1000000));
      await sendLoginOtpEmail(email, otpCode);

      pending.otp_hash = hashOtp(email, otpCode);
      pending.expires_at = nowMs + OTP_TTL_MS;
      pending.attempts = 0;
      pending.last_sent_at = nowMs;
      updatePendingLogin(pending);

      res.json({
        ok: true,
        email,
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        message: `A fresh login security OTP was sent to ${email}.`,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to resend login security OTP.',
      });
    }
  });

  router.post('/verify-login-otp', (req, res) => {
    const body = (req.body ?? {}) as { email?: string; otp?: string };
    const email = normalizeEmail(body.email || '');
    const otp = (body.otp || '').replace(/\s+/g, '');

    if (!isValidEmail(email) || !/^\d{6}$/.test(otp)) {
      res.status(400).json({ error: 'Please enter the 6-digit login security code sent to your email.' });
      return;
    }

    const pending = getPendingLogin(email);
    if (!pending) {
      res.status(404).json({ error: 'Login verification session not found. Please log in again.' });
      return;
    }

    if (pending.expires_at <= Date.now()) {
      deletePendingLogin(email);
      res.status(410).json({ error: 'Login OTP expired. Please enter your password again.' });
      return;
    }

    if (pending.attempts >= 5) {
      deletePendingLogin(email);
      res.status(429).json({ error: 'Too many incorrect attempts. Please log in again.' });
      return;
    }

    const candidateHash = hashOtp(email, otp);
    if (!constantTimeMatchHex(candidateHash, pending.otp_hash)) {
      pending.attempts += 1;
      updatePendingLogin(pending);
      const remaining = Math.max(0, 5 - pending.attempts);
      res.status(401).json({
        error: `Invalid login security code (${remaining} attempt${remaining === 1 ? '' : 's'} remaining).`,
      });
      return;
    }

    const existingUser = getUserByEmail(email);
    if (!existingUser || existingUser.verified !== 1) {
      deletePendingLogin(email);
      res.status(401).json({ error: 'Account not found or not verified.' });
      return;
    }

    deletePendingLogin(email);

    // Grant daily +1 coin login streak when logging in on a new day
    const { user: updatedUser, reward: streakReward } = claimDailyStreak(existingUser.id);
    const session = createSessionRecord(updatedUser, SESSION_TTL_MS);

    res.json({
      token: session.token,
      user: buildAuthUser(updatedUser),
      streakReward: streakReward.claimedNow ? streakReward : null,
    });
  });

  router.post('/logout', (req, res) => {
    const token = extractBearerToken(req);
    if (token) {
      deleteSession(token);
    }
    res.json({ ok: true });
  });

  return router;
}
