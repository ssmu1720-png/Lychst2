import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ADMIN_EMAIL,
  DEPLOYMENT_PLANS,
  type AdminAppDetails,
  type AdminUserSummary,
  type AuthUser,
  type BotDeployment,
  type BotPlatform,
  type CoinPurchase,
  type CoinTransaction,
  type CoinTransactionType,
  type CouponRecord,
  type DailyStreakReward,
  type DeploymentPlanId,
  type DeploymentPlanSpec,
  type EmailCampaign,
  type MpesaStkRequest,
  type PlatformPreferences,
  type ReferralEntry,
  type RuntimeEnvironment,
  type SupportTicket,
  type SupportTicketCategory,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from '../src/types/lyrihost.ts';
import type { TemplateBotSpec, TemplateEnvField } from '../src/catalog/templateBots.ts';

const DEFAULT_LOCAL_DATA_DIR = path.resolve(process.cwd(), 'data');
export const DATA_DIR = process.env.LYRIHOST_DATA_DIR
  ? path.resolve(process.env.LYRIHOST_DATA_DIR)
  : process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH), 'data')
    : DEFAULT_LOCAL_DATA_DIR;
export const DB_FILE = path.join(DATA_DIR, 'lyrihost.db');
export const LEGACY_STATE_FILE = path.join(DATA_DIR, 'lyrihost-state.json');

export const REFERRAL_REWARD_COINS = 2;
export const DAILY_STREAK_COINS = 1;
export const DEFAULT_MAX_DEPLOYMENTS = 5;

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function utcDateStr(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

export function isAdminEmail(email: string): boolean {
  return email.trim().toLowerCase() === ADMIN_EMAIL;
}

export function getDeploymentPlan(planId?: string | null): DeploymentPlanSpec {
  const found = DEPLOYMENT_PLANS.find((p) => p.id === planId);
  return found ?? DEPLOYMENT_PLANS[0];
}

export interface DbUserRow {
  id: string;
  email: string;
  password_hash: string;
  verified: number;
  role: string;
  coin_balance: number;
  max_deployments: number;
  referral_code: string;
  referred_by_user_id: string | null;
  referral_rewarded: number;
  streak_count: number;
  last_streak_date: string | null;
  last_streak_claimed_at: string | null;
  promo_emails_opt_in: number;
  accepted_terms?: number;
  consent_accepted_at?: string | null;
  preferences_json: string | null;
  created_at: string;
}

export interface DbPendingSignupRow {
  email: string;
  password_hash: string;
  otp_hash: string;
  referral_code: string | null;
  accepted_terms?: number;
  consent_accepted_at?: string | null;
  expires_at: number;
  attempts: number;
  last_sent_at: number;
}

export interface DbPendingLoginRow {
  email: string;
  otp_hash: string;
  expires_at: number;
  attempts: number;
  last_sent_at: number;
}

export interface DbSessionRow {
  token: string;
  user_id: string;
  email: string;
  created_at: string;
  expires_at: number;
}

let dbInstance: DatabaseSync | null = null;
let lastBackupDate = '';

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureColumnExists(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function ensureDailyDbBackup(db: DatabaseSync): void {
  const today = utcDateStr(0);
  if (lastBackupDate === today) return;
  lastBackupDate = today;
  try {
    const backupDir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupPath = path.join(backupDir, `lyrihost-${today}.db`);
    if (!fs.existsSync(backupPath)) {
      const escaped = backupPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escaped}'`);
    }
    // Prune only backups older than 14 days so recent snapshots stay clean
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => /^lyrihost-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    while (files.length > 14) {
      const oldest = files.shift();
      if (oldest) {
        fs.rmSync(path.join(backupDir, oldest), { force: true });
      }
    }
  } catch {
    // Non-fatal if filesystem blocks VACUUM INTO
  }
}

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  ensureDataDir();
  // Auto-migrate local ./data/lyrihost.db into newly mounted persistent volume if destination is empty
  if (DATA_DIR !== DEFAULT_LOCAL_DATA_DIR && !fs.existsSync(DB_FILE)) {
    const localDbFile = path.join(DEFAULT_LOCAL_DATA_DIR, 'lyrihost.db');
    if (fs.existsSync(localDbFile)) {
      try {
        fs.copyFileSync(localDbFile, DB_FILE);
        for (const ext of ['-wal', '-shm']) {
          if (fs.existsSync(`${localDbFile}${ext}`)) {
            fs.copyFileSync(`${localDbFile}${ext}`, `${DB_FILE}${ext}`);
          }
        }
        console.log(`[db] Migrated existing database into persistent volume: ${DB_FILE}`);
      } catch (err) {
        console.warn('[db] Volume migration copy warning:', err);
      }
    }
  }
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'user',
      coin_balance INTEGER NOT NULL DEFAULT 0,
      max_deployments INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_DEPLOYMENTS},
      referral_code TEXT NOT NULL UNIQUE,
      referred_by_user_id TEXT NULL,
      referral_rewarded INTEGER NOT NULL DEFAULT 0,
      streak_count INTEGER NOT NULL DEFAULT 0,
      last_streak_date TEXT NULL,
      last_streak_claimed_at TEXT NULL,
      promo_emails_opt_in INTEGER NOT NULL DEFAULT 1,
      preferences_json TEXT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_signups (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      referral_code TEXT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      numeric_id INTEGER NOT NULL,
      owner_user_id TEXT NULL,
      owner_email TEXT NULL,
      plan_id TEXT NULL,
      expires_at TEXT NULL,
      memory_limit_mb INTEGER NOT NULL DEFAULT 512,
      status TEXT NOT NULL DEFAULT 'stopped',
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coin_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      counterparty_email TEXT NULL,
      description TEXT NOT NULL,
      reference_id TEXT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_coin_tx_user_date
      ON coin_transactions (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS coin_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      coins INTEGER NOT NULL,
      amount_ksh INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      payment_reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      coins INTEGER NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses_count INTEGER NOT NULL DEFAULT 0,
      target_email TEXT NULL,
      expires_at TEXT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id TEXT PRIMARY KEY,
      coupon_code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      coins INTEGER NOT NULL,
      redeemed_at TEXT NOT NULL,
      UNIQUE(coupon_code, user_id)
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'complaint',
      priority TEXT NOT NULL DEFAULT 'normal',
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      admin_reply TEXT NULL,
      replied_at TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_campaigns (
      id TEXT PRIMARY KEY,
      sender_email TEXT NOT NULL,
      recipient_scope TEXT NOT NULL,
      recipient_count INTEGER NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_logins (
      email TEXT PRIMARY KEY,
      otp_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mpesa_stk_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      coins INTEGER NOT NULL,
      amount_ksh INTEGER NOT NULL,
      checkout_request_id TEXT NULL,
      merchant_request_id TEXT NULL,
      mpesa_receipt TEXT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      gateway_message TEXT NULL,
      gateway_dispatched INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mpesa_user_date
      ON mpesa_stk_requests (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bot_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      session_pair_url TEXT NOT NULL,
      session_pair_host TEXT NOT NULL,
      description TEXT NOT NULL,
      image_url TEXT NOT NULL,
      image_alt TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'whatsapp',
      framework TEXT NOT NULL DEFAULT 'Baileys MD',
      runtime TEXT NOT NULL DEFAULT 'node-20',
      default_branch TEXT NOT NULL DEFAULT 'main',
      install_command TEXT NOT NULL DEFAULT 'npm install --legacy-peer-deps --ignore-engines',
      build_command TEXT NOT NULL DEFAULT '',
      start_command TEXT NOT NULL DEFAULT 'npm start',
      default_env_vars_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  ensureColumnExists(db, 'users', 'accepted_terms', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnExists(db, 'users', 'consent_accepted_at', 'TEXT NULL');
  ensureColumnExists(db, 'pending_signups', 'accepted_terms', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnExists(db, 'pending_signups', 'consent_accepted_at', 'TEXT NULL');

  dbInstance = db;
  migrateLegacyJsonIfNeeded(db);
  ensureDailyDbBackup(db);
  return db;
}

function generateReferralCode(db: DatabaseSync): string {
  for (let i = 0; i < 12; i++) {
    const code = `LYR-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const existing = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code);
    if (!existing) return code;
  }
  return `LYR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export function getDefaultPreferences(): PlatformPreferences {
  return {
    defaultRegion: 'us-east',
    defaultRestartPolicy: 'always',
    defaultRuntime: 'node-20',
    telemetryCadenceSec: 2,
    compactFleetCards: false,
    deployAlertEmails: true,
    autoClearStoppedLogs: false,
    matrixIntensity: 'full',
    githubTokenConfigured: Boolean(process.env.GITHUB_TOKEN),
    webhookSecret: `lh_wh_${crypto.randomBytes(12).toString('hex')}`,
    promoEmailsOptIn: true,
    lowCoinAlertThreshold: 10,
  };
}

function migrateLegacyJsonIfNeeded(db: DatabaseSync): void {
  const migratedFlag = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('legacy_json_migrated') as
    | { value: string }
    | undefined;
  if (migratedFlag) return;

  try {
    if (fs.existsSync(LEGACY_STATE_FILE)) {
      const raw = fs.readFileSync(LEGACY_STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as {
        nextNumericId?: number;
        preferences?: PlatformPreferences;
        githubToken?: string;
        deployments?: BotDeployment[];
        users?: Array<{
          id: string;
          email: string;
          passwordHash: string;
          verified: boolean;
          createdAt: string;
        }>;
        sessions?: Array<{
          token: string;
          userId: string;
          email: string;
          createdAt: string;
          expiresAt: number;
        }>;
      };

      if (typeof parsed.nextNumericId === 'number') {
        db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
          'next_numeric_id',
          String(parsed.nextNumericId)
        );
      }
      if (parsed.preferences) {
        db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
          'platform_preferences',
          JSON.stringify(parsed.preferences)
        );
      }
      if (parsed.githubToken) {
        db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
          'github_token',
          parsed.githubToken
        );
      }
      for (const u of parsed.users ?? []) {
        const email = u.email.trim().toLowerCase();
        const admin = isAdminEmail(email);
        const refCode = generateReferralCode(db);
        db.prepare(
          `INSERT OR IGNORE INTO users
          (id, email, password_hash, verified, role, coin_balance, max_deployments, referral_code, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          u.id,
          email,
          u.passwordHash,
          u.verified ? 1 : 0,
          admin ? 'admin' : 'user',
          0,
          admin ? 999 : DEFAULT_MAX_DEPLOYMENTS,
          refCode,
          u.createdAt || nowIso()
        );
      }
      for (const s of parsed.sessions ?? []) {
        if (s.expiresAt > Date.now()) {
          db.prepare(
            'INSERT OR IGNORE INTO sessions (token, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
          ).run(s.token, s.userId, s.email, s.createdAt, s.expiresAt);
        }
      }
      for (const dep of parsed.deployments ?? []) {
        db.prepare(
          `INSERT OR IGNORE INTO deployments
          (id, numeric_id, owner_user_id, owner_email, plan_id, expires_at, memory_limit_mb, status, data_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          dep.id,
          dep.numericId ?? 1,
          dep.ownerUserId ?? null,
          dep.ownerEmail ?? null,
          dep.planId ?? 'plan_15d',
          dep.expiresAt ?? null,
          dep.memoryLimitMb ?? 512,
          dep.status ?? 'stopped',
          JSON.stringify(dep),
          dep.createdAt || nowIso(),
          dep.updatedAt || nowIso()
        );
      }
    }
  } catch (err) {
    console.error('Legacy state migration warning:', err);
  } finally {
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
      'legacy_json_migrated',
      nowIso()
    );
  }
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setMeta(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(key, value);
}

export function deleteMeta(key: string): void {
  getDb().prepare('DELETE FROM app_meta WHERE key = ?').run(key);
}

export function getUserByEmail(email: string): DbUserRow | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as DbUserRow | undefined;
  return row ?? null;
}

export function getUserById(id: string): DbUserRow | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUserRow | undefined;
  return row ?? null;
}

export function getUserByReferralCode(code: string): DbUserRow | null {
  const clean = code.trim().toUpperCase();
  if (!clean) return null;
  const row = getDb()
    .prepare('SELECT * FROM users WHERE referral_code = ? AND verified = 1')
    .get(clean) as DbUserRow | undefined;
  return row ?? null;
}

export function getUserDeploymentCount(userId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM deployments WHERE owner_user_id = ?')
    .get(userId) as { cnt: number };
  return row?.cnt ?? 0;
}

export function getUserReferralCount(userId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM users WHERE referred_by_user_id = ? AND verified = 1')
    .get(userId) as { cnt: number };
  return row?.cnt ?? 0;
}

export function buildAuthUser(row: DbUserRow): AuthUser {
  const admin = isAdminEmail(row.email);
  const today = utcDateStr(0);
  const activeDeploymentsCount = getUserDeploymentCount(row.id);
  const referralCount = getUserReferralCount(row.id);
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    isAdmin: admin,
    coinBalance: admin ? 999999 : row.coin_balance,
    unlimitedCoins: admin,
    maxDeployments: admin ? 999 : row.max_deployments,
    activeDeploymentsCount,
    referralCode: row.referral_code,
    referralCount,
    streakCount: row.streak_count,
    lastStreakDate: row.last_streak_date,
    canClaimDailyStreak: row.last_streak_date !== today,
    promoEmailsOptIn: row.promo_emails_opt_in === 1,
  };
}

export function getUserPreferences(userId: string): PlatformPreferences {
  const globalRaw = getMeta('platform_preferences');
  const globalPrefs: PlatformPreferences = globalRaw
    ? (JSON.parse(globalRaw) as PlatformPreferences)
    : getDefaultPreferences();

  const user = getUserById(userId);
  if (!user) return globalPrefs;

  let userParsed: Partial<PlatformPreferences> = {};
  if (user.preferences_json) {
    try {
      userParsed = JSON.parse(user.preferences_json) as Partial<PlatformPreferences>;
    } catch {
      userParsed = {};
    }
  }

  return {
    ...globalPrefs,
    ...userParsed,
    promoEmailsOptIn: user.promo_emails_opt_in === 1,
    githubTokenConfigured: Boolean(getMeta('github_token') || process.env.GITHUB_TOKEN),
  };
}

export function saveUserPreferences(
  userId: string,
  patch: Partial<PlatformPreferences>
): PlatformPreferences {
  const current = getUserPreferences(userId);
  const next: PlatformPreferences = {
    ...current,
    ...patch,
    defaultRuntime: patch.defaultRuntime ?? current.defaultRuntime ?? 'node-20',
    telemetryCadenceSec:
      patch.telemetryCadenceSec === 2 ||
      patch.telemetryCadenceSec === 5 ||
      patch.telemetryCadenceSec === 10
        ? patch.telemetryCadenceSec
        : current.telemetryCadenceSec ?? 2,
    compactFleetCards:
      typeof patch.compactFleetCards === 'boolean'
        ? patch.compactFleetCards
        : current.compactFleetCards ?? false,
    deployAlertEmails:
      typeof patch.deployAlertEmails === 'boolean'
        ? patch.deployAlertEmails
        : current.deployAlertEmails ?? true,
    autoClearStoppedLogs:
      typeof patch.autoClearStoppedLogs === 'boolean'
        ? patch.autoClearStoppedLogs
        : current.autoClearStoppedLogs ?? false,
    promoEmailsOptIn:
      typeof patch.promoEmailsOptIn === 'boolean'
        ? patch.promoEmailsOptIn
        : current.promoEmailsOptIn ?? true,
    lowCoinAlertThreshold:
      typeof patch.lowCoinAlertThreshold === 'number'
        ? Math.max(0, Math.round(patch.lowCoinAlertThreshold))
        : current.lowCoinAlertThreshold ?? 10,
  };

  getDb()
    .prepare('UPDATE users SET preferences_json = ?, promo_emails_opt_in = ? WHERE id = ?')
    .run(JSON.stringify(next), next.promoEmailsOptIn ? 1 : 0, userId);

  return next;
}

export function savePendingSignup(record: {
  email: string;
  passwordHash: string;
  otpHash: string;
  referralCode: string | null;
  acceptedTerms: boolean;
  consentAcceptedAt: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}): void {
  const db = getDb();
  db.prepare('DELETE FROM pending_signups WHERE expires_at <= ?').run(Date.now());
  db.prepare(
    `INSERT OR REPLACE INTO pending_signups
     (email, password_hash, otp_hash, referral_code, accepted_terms, consent_accepted_at, expires_at, attempts, last_sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.email,
    record.passwordHash,
    record.otpHash,
    record.referralCode,
    record.acceptedTerms ? 1 : 0,
    record.consentAcceptedAt,
    record.expiresAt,
    record.attempts,
    record.lastSentAt
  );
}

export function getPendingSignup(email: string): DbPendingSignupRow | null {
  const row = getDb()
    .prepare('SELECT * FROM pending_signups WHERE email = ?')
    .get(email.trim().toLowerCase()) as DbPendingSignupRow | undefined;
  return row ?? null;
}

export function updatePendingSignup(record: DbPendingSignupRow): void {
  getDb()
    .prepare(
      `UPDATE pending_signups
       SET otp_hash = ?, expires_at = ?, attempts = ?, last_sent_at = ?
       WHERE email = ?`
    )
    .run(record.otp_hash, record.expires_at, record.attempts, record.last_sent_at, record.email);
}

export function deletePendingSignup(email: string): void {
  getDb().prepare('DELETE FROM pending_signups WHERE email = ?').run(email.trim().toLowerCase());
}

export function savePendingLogin(record: {
  email: string;
  otpHash: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}): void {
  const db = getDb();
  db.prepare('DELETE FROM pending_logins WHERE expires_at <= ?').run(Date.now());
  db.prepare(
    `INSERT OR REPLACE INTO pending_logins
     (email, otp_hash, expires_at, attempts, last_sent_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(record.email, record.otpHash, record.expiresAt, record.attempts, record.lastSentAt);
}

export function getPendingLogin(email: string): DbPendingLoginRow | null {
  const row = getDb()
    .prepare('SELECT * FROM pending_logins WHERE email = ?')
    .get(email.trim().toLowerCase()) as DbPendingLoginRow | undefined;
  return row ?? null;
}

export function updatePendingLogin(record: DbPendingLoginRow): void {
  getDb()
    .prepare(
      `UPDATE pending_logins
       SET otp_hash = ?, expires_at = ?, attempts = ?, last_sent_at = ?
       WHERE email = ?`
    )
    .run(record.otp_hash, record.expires_at, record.attempts, record.last_sent_at, record.email);
}

export function deletePendingLogin(email: string): void {
  getDb().prepare('DELETE FROM pending_logins WHERE email = ?').run(email.trim().toLowerCase());
}

function insertTransaction(
  db: DatabaseSync,
  params: {
    userId: string;
    type: CoinTransactionType;
    amount: number;
    balanceAfter: number;
    counterpartyEmail?: string | null;
    description: string;
    referenceId?: string | null;
  }
): CoinTransaction {
  const tx: CoinTransaction = {
    id: makeId('tx'),
    userId: params.userId,
    type: params.type,
    amount: params.amount,
    balanceAfter: params.balanceAfter,
    counterpartyEmail: params.counterpartyEmail ?? null,
    description: params.description,
    referenceId: params.referenceId ?? null,
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO coin_transactions
     (id, user_id, type, amount, balance_after, counterparty_email, description, reference_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tx.id,
    tx.userId,
    tx.type,
    tx.amount,
    tx.balanceAfter,
    tx.counterpartyEmail,
    tx.description,
    tx.referenceId,
    tx.createdAt
  );
  return tx;
}

export function finalizeVerifiedSignup(params: {
  email: string;
  passwordHash: string;
  referralCodeInput?: string | null;
  acceptedTerms?: boolean;
  consentAcceptedAt?: string | null;
}): { user: DbUserRow; streakReward: DailyStreakReward } {
  const db = getDb();
  const cleanEmail = params.email.trim().toLowerCase();
  const admin = isAdminEmail(cleanEmail);
  const today = utcDateStr(0);
  const now = nowIso();

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db
      .prepare('SELECT id, verified FROM users WHERE email = ?')
      .get(cleanEmail) as { id: string; verified: number } | undefined;
    if (existing && existing.verified === 1) {
      throw new Error('An account with this email already exists. Please log in instead.');
    }
    if (existing) {
      db.prepare('DELETE FROM users WHERE id = ? AND verified = 0').run(existing.id);
    }

    let referrer: DbUserRow | null = null;
    const cleanRef = params.referralCodeInput?.trim().toUpperCase();
    if (cleanRef) {
      const refRow = db
        .prepare('SELECT * FROM users WHERE referral_code = ? AND verified = 1')
        .get(cleanRef) as DbUserRow | undefined;
      if (refRow && refRow.email !== cleanEmail) {
        referrer = refRow;
      }
    }

    const userId = makeId('usr');
    const ownRefCode = generateReferralCode(db);
    // Grant Day-1 login streak coin immediately when account is created & verified
    const initialCoins = admin ? 999999 : DAILY_STREAK_COINS;

    db.prepare(
      `INSERT INTO users
       (id, email, password_hash, verified, role, coin_balance, max_deployments, referral_code,
        referred_by_user_id, referral_rewarded, streak_count, last_streak_date, last_streak_claimed_at,
        promo_emails_opt_in, accepted_terms, consent_accepted_at, preferences_json, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?)`
    ).run(
      userId,
      cleanEmail,
      params.passwordHash,
      admin ? 'admin' : 'user',
      initialCoins,
      admin ? 999 : DEFAULT_MAX_DEPLOYMENTS,
      ownRefCode,
      referrer ? referrer.id : null,
      referrer ? 1 : 0,
      today,
      now,
      params.acceptedTerms === false ? 0 : 1,
      params.consentAcceptedAt || now,
      JSON.stringify(getDefaultPreferences()),
      now
    );

    insertTransaction(db, {
      userId,
      type: 'daily_streak',
      amount: DAILY_STREAK_COINS,
      balanceAfter: initialCoins,
      description: 'Day 1 welcome login streak bonus (+1 Coin)',
      referenceId: `streak_${today}`,
    });

    if (referrer) {
      const refAdmin = isAdminEmail(referrer.email);
      const nextRefBal = refAdmin
        ? referrer.coin_balance
        : referrer.coin_balance + REFERRAL_REWARD_COINS;
      db.prepare('UPDATE users SET coin_balance = ? WHERE id = ?').run(nextRefBal, referrer.id);
      insertTransaction(db, {
        userId: referrer.id,
        type: 'referral_bonus',
        amount: REFERRAL_REWARD_COINS,
        balanceAfter: nextRefBal,
        counterpartyEmail: cleanEmail,
        description: `Referral bonus for inviting ${cleanEmail} (+${REFERRAL_REWARD_COINS} Coins)`,
        referenceId: userId,
      });
    }

    db.prepare('DELETE FROM pending_signups WHERE email = ?').run(cleanEmail);
    db.exec('COMMIT');

    const createdUser = getUserById(userId)!;
    return {
      user: createdUser,
      streakReward: {
        claimedNow: true,
        coinsAwarded: DAILY_STREAK_COINS,
        streakCount: 1,
        message: 'Welcome to Lyrihost! Day 1 login streak awarded +1 Coin.',
      },
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function createSessionRecord(user: DbUserRow, ttlMs: number): DbSessionRow {
  const db = getDb();
  const nowMs = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs);
  const session: DbSessionRow = {
    token: crypto.randomBytes(32).toString('hex'),
    user_id: user.id,
    email: user.email,
    created_at: nowIso(),
    expires_at: nowMs + ttlMs,
  };
  db.prepare(
    'INSERT INTO sessions (token, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(session.token, session.user_id, session.email, session.created_at, session.expires_at);
  return session;
}

export function getValidSession(token: string): DbSessionRow | null {
  const row = getDb()
    .prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
    .get(token, Date.now()) as DbSessionRow | undefined;
  return row ?? null;
}

export function deleteSession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function claimDailyStreak(userId: string): {
  user: DbUserRow;
  reward: DailyStreakReward;
} {
  const db = getDb();
  const today = utcDateStr(0);
  const yesterday = utcDateStr(-1);
  const now = nowIso();

  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | DbUserRow
      | undefined;
    if (!user) {
      throw new Error('User not found.');
    }

    if (user.last_streak_date === today) {
      db.exec('COMMIT');
      return {
        user,
        reward: {
          claimedNow: false,
          coinsAwarded: 0,
          streakCount: user.streak_count,
          message: `Daily streak already claimed today (Day ${user.streak_count} streak). Come back tomorrow for +1 Coin.`,
        },
      };
    }

    const nextStreak = user.last_streak_date === yesterday ? user.streak_count + 1 : 1;
    const admin = isAdminEmail(user.email);
    const nextBalance = admin ? user.coin_balance : user.coin_balance + DAILY_STREAK_COINS;

    db.prepare(
      `UPDATE users
       SET coin_balance = ?, streak_count = ?, last_streak_date = ?, last_streak_claimed_at = ?
       WHERE id = ?`
    ).run(nextBalance, nextStreak, today, now, user.id);

    insertTransaction(db, {
      userId: user.id,
      type: 'daily_streak',
      amount: DAILY_STREAK_COINS,
      balanceAfter: admin ? 999999 : nextBalance,
      description: `Daily login streak reward — Day ${nextStreak} (+${DAILY_STREAK_COINS} Coin)`,
      referenceId: `streak_${today}`,
    });

    db.exec('COMMIT');
    const updatedUser = getUserById(user.id)!;
    return {
      user: updatedUser,
      reward: {
        claimedNow: true,
        coinsAwarded: DAILY_STREAK_COINS,
        streakCount: nextStreak,
        message: `Day ${nextStreak} login streak! +1 Coin credited to your wallet.`,
      },
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function spendCoinsForDeployment(params: {
  userId: string;
  planId: DeploymentPlanId;
  botId: string;
  botName: string;
}): {
  plan: DeploymentPlanSpec;
  expiresAt: string | null;
  newBalance: number;
} {
  const db = getDb();
  const plan = getDeploymentPlan(params.planId);

  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.userId) as
      | DbUserRow
      | undefined;
    if (!user) {
      throw new Error('Operator account not found.');
    }

    const admin = isAdminEmail(user.email);
    const botCountRow = db
      .prepare('SELECT COUNT(*) AS cnt FROM deployments WHERE owner_user_id = ?')
      .get(user.id) as { cnt: number };
    const currentBots = botCountRow?.cnt ?? 0;

    if (!admin && currentBots >= user.max_deployments) {
      throw new Error(
        `Deployment limit reached (${currentBots}/${user.max_deployments} bots). Contact ${ADMIN_EMAIL} or remove an unused bot.`
      );
    }

    if (!admin && user.coin_balance < plan.coinCost) {
      throw new Error(
        `Insufficient coins: ${plan.name} costs ${plan.coinCost} Coins (${plan.kshCost} KSH), and your balance is ${user.coin_balance} Coins.`
      );
    }

    const nextBalance = admin ? 999999 : user.coin_balance - plan.coinCost;
    if (!admin) {
      db.prepare('UPDATE users SET coin_balance = ? WHERE id = ?').run(nextBalance, user.id);
    }

    insertTransaction(db, {
      userId: user.id,
      type: 'deploy_spend',
      amount: admin ? 0 : -plan.coinCost,
      balanceAfter: nextBalance,
      description: admin
        ? `Deployed "${params.botName}" on ${plan.name} (${plan.memoryLimitMb} MB RAM · Admin Unlimited)`
        : `Deployed "${params.botName}" on ${plan.name} (${plan.durationLabel}, ${plan.memoryLimitMb} MB RAM)`,
      referenceId: params.botId,
    });

    db.exec('COMMIT');

    const expiresAt =
      plan.durationDays !== null
        ? new Date(Date.now() + plan.durationDays * 86400 * 1000).toISOString()
        : null;

    return { plan, expiresAt, newBalance: nextBalance };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function renewDeploymentPlan(params: {
  userId: string;
  botId: string;
  planId: DeploymentPlanId;
  currentExpiresAt?: string | null;
  botName: string;
}): {
  plan: DeploymentPlanSpec;
  expiresAt: string | null;
  newBalance: number;
} {
  const db = getDb();
  const plan = getDeploymentPlan(params.planId);

  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.userId) as
      | DbUserRow
      | undefined;
    if (!user) throw new Error('Operator account not found.');

    const admin = isAdminEmail(user.email);
    if (!admin && user.coin_balance < plan.coinCost) {
      throw new Error(
        `Insufficient coins: ${plan.name} costs ${plan.coinCost} Coins (${plan.kshCost} KSH), and your balance is ${user.coin_balance} Coins.`
      );
    }

    const nextBalance = admin ? 999999 : user.coin_balance - plan.coinCost;
    if (!admin) {
      db.prepare('UPDATE users SET coin_balance = ? WHERE id = ?').run(nextBalance, user.id);
    }

    let expiresAt: string | null = null;
    if (plan.durationDays !== null) {
      const baseMs =
        params.currentExpiresAt && Date.parse(params.currentExpiresAt) > Date.now()
          ? Date.parse(params.currentExpiresAt)
          : Date.now();
      expiresAt = new Date(baseMs + plan.durationDays * 86400 * 1000).toISOString();
    }

    insertTransaction(db, {
      userId: user.id,
      type: 'deploy_spend',
      amount: admin ? 0 : -plan.coinCost,
      balanceAfter: nextBalance,
      description: `Upgraded/Renewed "${params.botName}" to ${plan.name} (${plan.memoryLimitMb} MB RAM)`,
      referenceId: params.botId,
    });

    db.exec('COMMIT');
    return { plan, expiresAt, newBalance: nextBalance };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function transferCoins(params: {
  fromUserId: string;
  toEmail: string;
  amount: number;
  note?: string;
}): { senderBalance: number; recipientEmail: string; amount: number } {
  const db = getDb();
  const cleanRecipientEmail = params.toEmail.trim().toLowerCase();
  const amount = Math.floor(params.amount);

  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error('Transfer amount must be at least 1 Coin.');
  }
  if (amount > 1_000_000) {
    throw new Error('Transfer amount exceeds single-transfer cap.');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(params.fromUserId) as
      | DbUserRow
      | undefined;
    if (!sender) throw new Error('Sender account not found.');

    const recipient = db
      .prepare('SELECT * FROM users WHERE email = ? AND verified = 1')
      .get(cleanRecipientEmail) as DbUserRow | undefined;
    if (!recipient) {
      throw new Error(`No verified Lyrihost user found with email "${cleanRecipientEmail}".`);
    }
    if (recipient.id === sender.id) {
      throw new Error('You cannot transfer coins to your own account.');
    }

    const senderAdmin = isAdminEmail(sender.email);
    const recipientAdmin = isAdminEmail(recipient.email);

    if (!senderAdmin && sender.coin_balance < amount) {
      throw new Error(
        `Insufficient coins to transfer ${amount} Coins. Available balance: ${sender.coin_balance} Coins.`
      );
    }

    const nextSenderBal = senderAdmin ? 999999 : sender.coin_balance - amount;
    if (!senderAdmin) {
      db.prepare('UPDATE users SET coin_balance = ? WHERE id = ?').run(nextSenderBal, sender.id);
    }

    const nextRecipientBal = recipientAdmin ? 999999 : recipient.coin_balance + amount;
    if (!recipientAdmin) {
      db.prepare('UPDATE users SET coin_balance = ? WHERE id = ?').run(
        nextRecipientBal,
        recipient.id
      );
    }

    const noteSuffix = params.note?.trim() ? ` — "${params.note.trim().slice(0, 80)}"` : '';
    const refId = makeId('xfer');

    insertTransaction(db, {
      userId: sender.id,
      type: 'transfer_out',
      amount: -amount,
      balanceAfter: nextSenderBal,
      counterpartyEmail: recipient.email,
      description: `Sent ${amount} Coin${amount === 1 ? '' : 's'} to ${recipient.email}${noteSuffix}`,
      referenceId: refId,
    });

    insertTransaction(db, {
      userId: recipient.id,
      type: 'transfer_in',
      amount,
      balanceAfter: nextRecipientBal,
      counterpartyEmail: sender.email,
      description: `Received ${amount} Coin${amount === 1 ? '' : 's'} from ${sender.email}${noteSuffix}`,
      referenceId: refId,
    });

    db.exec('COMMIT');
    return {
      senderBalance: nextSenderBal,
      recipientEmail: recipient.email,
      amount,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function purchaseCoins(params: {
  userId: string;
  coins: number;
  paymentMethod: 'mpesa' | 'card' | 'instant';
  paymentReference?: string;
}): { purchase: CoinPurchase; newBalance: number } {
  const db = getDb();
  const coins = Math.floor(params.coins);
  if (!Number.isInteger(coins) || coins < 1 || coins > 500000) {
    throw new Error('Coin purchase amount must be between 1 and 500,000 Coins.');
  }

  const amountKsh = coins; // 1 Coin = 1 KSH
  const ref =
    params.paymentReference?.trim() ||
    `LHPAY-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.userId) as
      | DbUserRow
      | undefined;
    if (!user) throw new Error('Account not found.');

    const admin = isAdminEmail(user.email);
    const nextBalance = admin ? 999999 : user.coin_balance + coins;
    if (!admin) {
      db.prepare('UPDATE users SET coin_balance = ? WHERE id = ?').run(nextBalance, user.id);
    }

    const purchase: CoinPurchase = {
      id: makeId('pur'),
      userId: user.id,
      email: user.email,
      coins,
      amountKsh,
      paymentMethod: params.paymentMethod,
      paymentReference: ref,
      status: 'completed',
      createdAt: nowIso(),
    };

    db.prepare(
      `INSERT INTO coin_purchases
       (id, user_id, email, coins, amount_ksh, payment_method, payment_reference, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      purchase.id,
      purchase.userId,
      purchase.email,
      purchase.coins,
      purchase.amountKsh,
      purchase.paymentMethod,
      purchase.paymentReference,
      purchase.status,
      purchase.createdAt
    );

    insertTransaction(db, {
      userId: user.id,
      type: 'purchase',
      amount: coins,
      balanceAfter: nextBalance,
      description: `Purchased ${coins} Coins (${amountKsh} KSH) via ${params.paymentMethod.toUpperCase()}`,
      referenceId: purchase.paymentReference,
    });

    db.exec('COMMIT');
    return { purchase, newBalance: nextBalance };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function createCoupon(params: {
  code?: string;
  coins: number;
  maxUses: number;
  targetEmail?: string | null;
  expiresInDays?: number | null;
  createdBy: string;
}): CouponRecord {
  const db = getDb();
  const coins = Math.floor(params.coins);
  const maxUses = Math.floor(params.maxUses);
  if (!Number.isInteger(coins) || coins < 1 || coins > 100000) {
    throw new Error('Coupon value must be between 1 and 100,000 Coins.');
  }
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000) {
    throw new Error('Max uses must be between 1 and 10,000.');
  }

  const code = (
    params.code?.trim() || `LYRI-${crypto.randomBytes(3).toString('hex')}`
  )
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  if (code.length < 3) {
    throw new Error('Coupon code must be at least 3 alphanumeric characters.');
  }

  const existing = db.prepare('SELECT code FROM coupons WHERE code = ?').get(code);
  if (existing) {
    throw new Error(`Coupon code "${code}" already exists.`);
  }

  const targetEmail = params.targetEmail?.trim().toLowerCase() || null;
  const expiresAt =
    typeof params.expiresInDays === 'number' && params.expiresInDays > 0
      ? new Date(Date.now() + params.expiresInDays * 86400 * 1000).toISOString()
      : null;

  const coupon: CouponRecord = {
    code,
    coins,
    maxUses,
    usesCount: 0,
    targetEmail,
    expiresAt,
    createdBy: params.createdBy,
    createdAt: nowIso(),
    isActive: true,
  };

  db.prepare(
    `INSERT INTO coupons
     (code, coins, max_uses, uses_count, target_email, expires_at, created_by, created_at, is_active)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1)`
  ).run(
    coupon.code,
    coupon.coins,
    coupon.maxUses,
    coupon.targetEmail,
    coupon.expiresAt,
    coupon.createdBy,
    coupon.createdAt
  );

  return coupon;
}

export function listCoupons(): CouponRecord[] {
  const rows = getDb().prepare('SELECT * FROM coupons ORDER BY created_at DESC').all() as Array<{
    code: string;
    coins: number;
    max_uses: number;
    uses_count: number;
    target_email: string | null;
    expires_at: string | null;
    created_by: string;
    created_at: string;
    is_active: number;
  }>;

  return rows.map((r) => ({
    code: r.code,
    coins: r.coins,
    maxUses: r.max_uses,
    usesCount: r.uses_count,
    targetEmail: r.target_email,
    expiresAt: r.expires_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    isActive: r.is_active === 1,
  }));
}

export function toggleCouponActive(code: string, isActive: boolean): CouponRecord {
  const db = getDb();
  const clean = code.trim().toUpperCase();
  const res = db
    .prepare('UPDATE coupons SET is_active = ? WHERE code = ?')
    .run(isActive ? 1 : 0, clean);
  if (res.changes === 0) {
    throw new Error('Coupon not found.');
  }
  const found = listCoupons().find((c) => c.code === clean);
  if (!found) throw new Error('Coupon not found.');
  return found;
}

export function deleteCoupon(code: string): void {
  const db = getDb();
  const clean = code.trim().toUpperCase();
  db.prepare('DELETE FROM coupon_redemptions WHERE coupon_code = ?').run(clean);
  db.prepare('DELETE FROM coupons WHERE code = ?').run(clean);
}

export function redeemCoupon(userId: string, rawCode: string): {
  code: string;
  coinsAwarded: number;
  newBalance: number;
} {
  const db = getDb();
  const code = rawCode.trim().toUpperCase();
  if (!code) throw new Error('Please enter a coupon code.');

  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | DbUserRow
      | undefined;
    if (!user) throw new Error('User not found.');

    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code) as
      | {
          code: string;
          coins: number;
          max_uses: number;
          uses_count: number;
          target_email: string | null;
          expires_at: string | null;
          is_active: number;
        }
      | undefined;

    if (!coupon) throw new Error(`Coupon "${code}" does not exist.`);
    if (coupon.is_active !== 1) throw new Error(`Coupon "${code}" has been deactivated.`);
    if (coupon.expires_at && Date.parse(coupon.expires_at) <= Date.now()) {
      throw new Error(`Coupon "${code}" has expired.`);
    }
    if (coupon.uses_count >= coupon.max_uses) {
      throw new Error(`Coupon "${code}" has reached its maximum redemptions.`);
    }
    if (coupon.target_email && coupon.target_email !== user.email) {
      throw new Error(`Coupon "${code}" is assigned to a different operator email.`);
    }

    const alreadyRedeemed = db
      .prepare('SELECT id FROM coupon_redemptions WHERE coupon_code = ? AND user_id = ?')
      .get(code, user.id);
    if (alreadyRedeemed) {
      throw new Error(`You have already redeemed coupon "${code}".`);
    }

    const admin = isAdminEmail(user.email);
    const nextBalance = admin ? 999999 : user.coin_balance + coupon.coins;
    if (!admin) {
      db.prepare('UPDATE users SET coin_balance = ? WHERE id = ?').run(nextBalance, user.id);
    }

    db.prepare('UPDATE coupons SET uses_count = uses_count + 1 WHERE code = ?').run(code);
    db.prepare(
      'INSERT INTO coupon_redemptions (id, coupon_code, user_id, coins, redeemed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(makeId('cred'), code, user.id, coupon.coins, nowIso());

    insertTransaction(db, {
      userId: user.id,
      type: 'coupon_redeem',
      amount: coupon.coins,
      balanceAfter: nextBalance,
      description: `Redeemed coupon "${code}" (+${coupon.coins} Coins)`,
      referenceId: code,
    });

    db.exec('COMMIT');
    return {
      code,
      coinsAwarded: coupon.coins,
      newBalance: nextBalance,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listUserTransactions(userId: string, limit = 50): CoinTransaction[] {
  const rows = getDb()
    .prepare('SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as Array<{
    id: string;
    user_id: string;
    type: CoinTransactionType;
    amount: number;
    balance_after: number;
    counterparty_email: string | null;
    description: string;
    reference_id: string | null;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    type: r.type,
    amount: r.amount,
    balanceAfter: r.balance_after,
    counterpartyEmail: r.counterparty_email,
    description: r.description,
    referenceId: r.reference_id,
    createdAt: r.created_at,
  }));
}

export function listUserPurchases(userId: string, limit = 25): CoinPurchase[] {
  const rows = getDb()
    .prepare('SELECT * FROM coin_purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as Array<{
    id: string;
    user_id: string;
    email: string;
    coins: number;
    amount_ksh: number;
    payment_method: 'mpesa' | 'card' | 'instant';
    payment_reference: string;
    status: 'completed' | 'pending' | 'rejected';
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    email: r.email,
    coins: r.coins,
    amountKsh: r.amount_ksh,
    paymentMethod: r.payment_method,
    paymentReference: r.payment_reference,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export function listUserReferrals(userId: string): ReferralEntry[] {
  const rows = getDb()
    .prepare(
      'SELECT id, email, referral_rewarded, created_at FROM users WHERE referred_by_user_id = ? AND verified = 1 ORDER BY created_at DESC'
    )
    .all(userId) as Array<{
    id: string;
    email: string;
    referral_rewarded: number;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    rewarded: r.referral_rewarded === 1,
    coinsEarned: r.referral_rewarded === 1 ? REFERRAL_REWARD_COINS : 0,
    createdAt: r.created_at,
  }));
}

export function createSupportTicket(params: {
  userId: string;
  userEmail: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  subject: string;
  message: string;
}): SupportTicket {
  const now = nowIso();
  const ticket: SupportTicket = {
    id: makeId('tkt'),
    userId: params.userId,
    userEmail: params.userEmail,
    category: params.category,
    priority: params.priority,
    subject: params.subject.trim(),
    message: params.message.trim(),
    status: 'open',
    adminReply: null,
    repliedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  getDb()
    .prepare(
      `INSERT INTO support_tickets
       (id, user_id, user_email, category, priority, subject, message, status, admin_reply, replied_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?)`
    )
    .run(
      ticket.id,
      ticket.userId,
      ticket.userEmail,
      ticket.category,
      ticket.priority,
      ticket.subject,
      ticket.message,
      ticket.createdAt,
      ticket.updatedAt
    );

  return ticket;
}

function mapTicketRow(r: {
  id: string;
  user_id: string;
  user_email: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  subject: string;
  message: string;
  status: SupportTicketStatus;
  admin_reply: string | null;
  replied_at: string | null;
  created_at: string;
  updated_at: string;
}): SupportTicket {
  return {
    id: r.id,
    userId: r.user_id,
    userEmail: r.user_email,
    category: r.category,
    priority: r.priority,
    subject: r.subject,
    message: r.message,
    status: r.status,
    adminReply: r.admin_reply,
    repliedAt: r.replied_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listUserTickets(userId: string): SupportTicket[] {
  const rows = getDb()
    .prepare('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Parameters<typeof mapTicketRow>[0][];
  return rows.map(mapTicketRow);
}

export function listAllTickets(): SupportTicket[] {
  const rows = getDb()
    .prepare('SELECT * FROM support_tickets ORDER BY created_at DESC')
    .all() as Parameters<typeof mapTicketRow>[0][];
  return rows.map(mapTicketRow);
}

export function updateTicketReply(params: {
  ticketId: string;
  status?: SupportTicketStatus;
  adminReply?: string;
}): SupportTicket {
  const db = getDb();
  const row = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(params.ticketId) as
    | Parameters<typeof mapTicketRow>[0]
    | undefined;
  if (!row) throw new Error('Ticket not found.');

  const now = nowIso();
  const nextStatus = params.status ?? (params.adminReply?.trim() ? 'resolved' : row.status);
  const nextReply =
    typeof params.adminReply === 'string' && params.adminReply.trim().length > 0
      ? params.adminReply.trim()
      : row.admin_reply;
  const nextRepliedAt = nextReply && nextReply !== row.admin_reply ? now : row.replied_at;

  db.prepare(
    'UPDATE support_tickets SET status = ?, admin_reply = ?, replied_at = ?, updated_at = ? WHERE id = ?'
  ).run(nextStatus, nextReply, nextRepliedAt, now, params.ticketId);

  const updated = db
    .prepare('SELECT * FROM support_tickets WHERE id = ?')
    .get(params.ticketId) as Parameters<typeof mapTicketRow>[0];
  return mapTicketRow(updated);
}

export function adminUpdateUser(params: {
  targetUserId: string;
  maxDeployments?: number;
  grantCoinsDelta?: number;
  grantReason?: string;
}): AdminUserSummary {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.targetUserId) as
      | DbUserRow
      | undefined;
    if (!user) throw new Error('User not found.');

    const admin = isAdminEmail(user.email);
    let nextMax = user.max_deployments;
    if (typeof params.maxDeployments === 'number' && Number.isFinite(params.maxDeployments)) {
      nextMax = Math.max(0, Math.min(1000, Math.floor(params.maxDeployments)));
    }

    let nextBalance = user.coin_balance;
    const delta =
      typeof params.grantCoinsDelta === 'number' && Number.isFinite(params.grantCoinsDelta)
        ? Math.trunc(params.grantCoinsDelta)
        : 0;

    if (!admin && delta !== 0) {
      nextBalance = Math.max(0, user.coin_balance + delta);
      insertTransaction(db, {
        userId: user.id,
        type: 'admin_grant',
        amount: delta,
        balanceAfter: nextBalance,
        counterpartyEmail: ADMIN_EMAIL,
        description:
          params.grantReason?.trim() ||
          `Admin balance adjustment (${delta >= 0 ? `+${delta}` : delta} Coins)`,
        referenceId: makeId('adm'),
      });
    }

    db.prepare('UPDATE users SET max_deployments = ?, coin_balance = ? WHERE id = ?').run(
      nextMax,
      nextBalance,
      user.id
    );
    db.exec('COMMIT');

    const summary = listAllAdminUsers().find((u) => u.id === user.id);
    if (!summary) throw new Error('User not found after update.');
    return summary;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listAllAdminUsers(): AdminUserSummary[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as unknown as DbUserRow[];
  return rows.map((u) => {
    const admin = isAdminEmail(u.email);
    return {
      id: u.id,
      email: u.email,
      isAdmin: admin,
      verified: u.verified === 1,
      coinBalance: admin ? 999999 : u.coin_balance,
      unlimitedCoins: admin,
      maxDeployments: admin ? 999 : u.max_deployments,
      deploymentCount: getUserDeploymentCount(u.id),
      referralCode: u.referral_code,
      referralCount: getUserReferralCount(u.id),
      streakCount: u.streak_count,
      promoEmailsOptIn: u.promo_emails_opt_in === 1,
      createdAt: u.created_at,
    };
  });
}

export function listVerifiedRecipientEmails(scope: 'all' | 'promo_opted_in'): string[] {
  const sql =
    scope === 'promo_opted_in'
      ? 'SELECT email FROM users WHERE verified = 1 AND promo_emails_opt_in = 1'
      : 'SELECT email FROM users WHERE verified = 1';
  const rows = getDb().prepare(sql).all() as Array<{ email: string }>;
  return rows.map((r) => r.email);
}

export function recordEmailCampaign(campaign: EmailCampaign): void {
  getDb()
    .prepare(
      `INSERT INTO email_campaigns
       (id, sender_email, recipient_scope, recipient_count, subject, body_text, sent_count, failed_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      campaign.id,
      campaign.senderEmail,
      campaign.recipientScope,
      campaign.recipientCount,
      campaign.subject,
      campaign.bodyText,
      campaign.sentCount,
      campaign.failedCount,
      campaign.createdAt
    );
}

export function listEmailCampaigns(): EmailCampaign[] {
  const rows = getDb()
    .prepare('SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 30')
    .all() as Array<{
    id: string;
    sender_email: string;
    recipient_scope: string;
    recipient_count: number;
    subject: string;
    body_text: string;
    sent_count: number;
    failed_count: number;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    senderEmail: r.sender_email,
    recipientScope: r.recipient_scope,
    recipientCount: r.recipient_count,
    subject: r.subject,
    bodyText: r.body_text,
    sentCount: r.sent_count,
    failedCount: r.failed_count,
    createdAt: r.created_at,
  }));
}

export function getAdminAppDetails(): AdminAppDetails {
  const db = getDb();
  const userStats = db
    .prepare(
      `SELECT
         COUNT(*) AS totalUsers,
         SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verifiedUsers,
         SUM(CASE WHEN LOWER(email) != ? THEN coin_balance ELSE 0 END) AS totalCoins,
         SUM(CASE WHEN referral_rewarded = 1 THEN 1 ELSE 0 END) AS totalReferrals
       FROM users`
    )
    .get(ADMIN_EMAIL) as {
    totalUsers: number;
    verifiedUsers: number;
    totalCoins: number | null;
    totalReferrals: number | null;
  };

  const depStats = db
    .prepare(
      `SELECT
         COUNT(*) AS totalDeployments,
         SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS onlineDeployments
       FROM deployments`
    )
    .get() as { totalDeployments: number; onlineDeployments: number | null };

  const purStats = db
    .prepare(
      `SELECT
         COUNT(*) AS totalPurchasesCount,
         SUM(amount_ksh) AS totalKsh
       FROM coin_purchases
       WHERE status = 'completed'`
    )
    .get() as { totalPurchasesCount: number; totalKsh: number | null };

  const couponStats = db
    .prepare('SELECT COUNT(*) AS cnt FROM coupons WHERE is_active = 1')
    .get() as { cnt: number };

  const ticketStats = db
    .prepare("SELECT COUNT(*) AS cnt FROM support_tickets WHERE status != 'resolved'")
    .get() as { cnt: number };

  const emailStats = db
    .prepare('SELECT SUM(sent_count) AS sentTotal FROM email_campaigns')
    .get() as { sentTotal: number | null };

  let dbSizeKb = 0;
  try {
    const stat = fs.statSync(DB_FILE);
    dbSizeKb = Math.round(stat.size / 1024);
  } catch {
    dbSizeKb = 0;
  }

  return {
    totalUsers: userStats.totalUsers ?? 0,
    verifiedUsers: userStats.verifiedUsers ?? 0,
    totalDeployments: depStats.totalDeployments ?? 0,
    onlineDeployments: depStats.onlineDeployments ?? 0,
    totalCoinsInCirculation: userStats.totalCoins ?? 0,
    totalKshPurchased: purStats.totalKsh ?? 0,
    totalPurchasesCount: purStats.totalPurchasesCount ?? 0,
    totalReferrals: userStats.totalReferrals ?? 0,
    activeCouponsCount: couponStats.cnt ?? 0,
    openTicketsCount: ticketStats.cnt ?? 0,
    emailsSentTotal: emailStats.sentTotal ?? 0,
    nodeVersion: process.version,
    platform: process.platform,
    uptimeSeconds: Math.round(process.uptime()),
    dbSizeKb,
    adminEmail: ADMIN_EMAIL,
  };
}

export function loadDeploymentsFromDb(): BotDeployment[] {
  const rows = getDb()
    .prepare('SELECT data_json FROM deployments ORDER BY created_at DESC')
    .all() as Array<{ data_json: string }>;
  const list: BotDeployment[] = [];
  for (const r of rows) {
    try {
      list.push(JSON.parse(r.data_json) as BotDeployment);
    } catch {
      // skip corrupt row
    }
  }
  return list;
}

export function syncDeploymentsToDb(deployments: BotDeployment[]): void {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Non-destructive upsert only — never purge existing deployments during updates or syncs
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO deployments
       (id, numeric_id, owner_user_id, owner_email, plan_id, expires_at, memory_limit_mb, status, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const dep of deployments) {
      upsert.run(
        dep.id,
        dep.numericId ?? 1,
        dep.ownerUserId ?? null,
        dep.ownerEmail ?? null,
        dep.planId ?? dep.settings.planId ?? 'plan_15d',
        dep.expiresAt ?? null,
        dep.memoryLimitMb ?? 512,
        dep.status,
        JSON.stringify(dep),
        dep.createdAt,
        dep.updatedAt
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Failed to sync deployments to SQLite:', err);
  }
}

export function deleteDeploymentFromDb(id: string): void {
  getDb().prepare('DELETE FROM deployments WHERE id = ?').run(id);
}

interface DbMpesaRow {
  id: string;
  user_id: string;
  email: string;
  phone_number: string;
  coins: number;
  amount_ksh: number;
  checkout_request_id: string | null;
  merchant_request_id: string | null;
  mpesa_receipt: string | null;
  status: 'pending' | 'completed' | 'failed';
  gateway_message: string | null;
  gateway_dispatched: number;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
}

function mapMpesaRow(r: DbMpesaRow): MpesaStkRequest {
  return {
    id: r.id,
    userId: r.user_id,
    email: r.email,
    phoneNumber: r.phone_number,
    coins: r.coins,
    amountKsh: r.amount_ksh,
    checkoutRequestId: r.checkout_request_id,
    merchantRequestId: r.merchant_request_id,
    mpesaReceipt: r.mpesa_receipt,
    status: r.status,
    gatewayMessage: r.gateway_message,
    gatewayDispatched: r.gateway_dispatched === 1,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Records a PENDING M-Pesa STK push request and a PENDING purchase row.
 * NEVER allocates any coins until M-Pesa confirms payment!
 */
export function createMpesaStkRequest(params: {
  id: string;
  userId: string;
  email: string;
  phoneNumber: string;
  coins: number;
}): MpesaStkRequest {
  const db = getDb();
  const coins = Math.floor(params.coins);
  if (!Number.isInteger(coins) || coins < 1 || coins > 500000) {
    throw new Error('Purchase amount must be between 1 and 500,000 Coins (1 Coin = 1 KSH).');
  }
  const now = nowIso();
  const amountKsh = coins;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO mpesa_stk_requests
       (id, user_id, email, phone_number, coins, amount_ksh, status, gateway_dispatched, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
    ).run(params.id, params.userId, params.email, params.phoneNumber, coins, amountKsh, now, now);

    db.prepare(
      `INSERT INTO coin_purchases
       (id, user_id, email, coins, amount_ksh, payment_method, payment_reference, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'mpesa', ?, 'pending', ?)`
    ).run(params.id, params.userId, params.email, coins, amountKsh, params.id, now);

    db.exec('COMMIT');
    return getMpesaStkRequestById(params.id)!;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function updateMpesaStkDispatch(params: {
  id: string;
  checkoutRequestId: string | null;
  merchantRequestId: string | null;
  gatewayDispatched: boolean;
  gatewayMessage: string;
  markFailed?: boolean;
}): MpesaStkRequest {
  const db = getDb();
  const now = nowIso();
  const nextStatus = params.markFailed ? 'failed' : 'pending';
  db.prepare(
    `UPDATE mpesa_stk_requests
     SET checkout_request_id = ?, merchant_request_id = ?, gateway_dispatched = ?, gateway_message = ?, status = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    params.checkoutRequestId,
    params.merchantRequestId,
    params.gatewayDispatched ? 1 : 0,
    params.gatewayMessage,
    nextStatus,
    now,
    params.id
  );
  if (params.markFailed) {
    db.prepare("UPDATE coin_purchases SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(
      params.id
    );
  }
  return getMpesaStkRequestById(params.id)!;
}

export function getMpesaStkRequestById(id: string): MpesaStkRequest | null {
  const row = getDb()
    .prepare('SELECT * FROM mpesa_stk_requests WHERE id = ?')
    .get(id) as DbMpesaRow | undefined;
  return row ? mapMpesaRow(row) : null;
}

export function getMpesaStkRequestByCheckoutId(checkoutId: string): MpesaStkRequest | null {
  const row = getDb()
    .prepare('SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = ? OR id = ?')
    .get(checkoutId, checkoutId) as DbMpesaRow | undefined;
  return row ? mapMpesaRow(row) : null;
}

export function listUserMpesaRequests(userId: string, limit = 25): MpesaStkRequest[] {
  const rows = getDb()
    .prepare('SELECT * FROM mpesa_stk_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as unknown as DbMpesaRow[];
  return rows.map(mapMpesaRow);
}

/**
 * Atomically settles a confirmed M-Pesa payment and credits the user's coin balance.
 * Strictly rejects if already completed/failed (idempotent) or missing confirmed receipt.
 */
export function completeMpesaStkRequest(params: {
  idOrCheckoutId: string;
  mpesaReceipt: string;
  resultDesc?: string;
}): { request: MpesaStkRequest; newlyCredited: boolean } {
  const db = getDb();
  const receipt = params.mpesaReceipt.trim();
  if (!receipt) {
    throw new Error('Confirmed M-Pesa receipt number is required before crediting coins.');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare('SELECT * FROM mpesa_stk_requests WHERE id = ? OR checkout_request_id = ?')
      .get(params.idOrCheckoutId, params.idOrCheckoutId) as DbMpesaRow | undefined;
    if (!row) {
      throw new Error('M-Pesa STK request not found.');
    }

    if (row.status === 'completed') {
      db.exec('COMMIT');
      return { request: mapMpesaRow(row), newlyCredited: false };
    }
    if (row.status === 'failed') {
      throw new Error('Cannot complete an already failed M-Pesa transaction.');
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as
      | DbUserRow
      | undefined;
    if (!user) {
      throw new Error('User account for this M-Pesa payment was not found.');
    }

    const now = nowIso();
    const admin = isAdminEmail(user.email);
    const nextBalance = admin ? 999999 : user.coin_balance + row.coins;

    if (!admin) {
      db.prepare('UPDATE users SET coin_balance = ? WHERE id = ?').run(nextBalance, user.id);
    }

    db.prepare(
      `UPDATE mpesa_stk_requests
       SET status = 'completed', mpesa_receipt = ?, gateway_message = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      receipt,
      params.resultDesc?.trim() || `Confirmed M-Pesa payment (${receipt})`,
      now,
      now,
      row.id
    );

    db.prepare(
      `UPDATE coin_purchases
       SET status = 'completed', payment_reference = ?
       WHERE id = ?`
    ).run(receipt, row.id);

    insertTransaction(db, {
      userId: user.id,
      type: 'purchase',
      amount: row.coins,
      balanceAfter: nextBalance,
      description: `M-Pesa STK confirmed (+${row.coins} Coins · ${row.amount_ksh} KSH · Receipt ${receipt})`,
      referenceId: receipt,
    });

    db.exec('COMMIT');
    return { request: getMpesaStkRequestById(row.id)!, newlyCredited: true };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function failMpesaStkRequest(idOrCheckoutId: string, reason: string): MpesaStkRequest {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM mpesa_stk_requests WHERE id = ? OR checkout_request_id = ?')
    .get(idOrCheckoutId, idOrCheckoutId) as DbMpesaRow | undefined;
  if (!row) {
    throw new Error('M-Pesa STK request not found.');
  }
  if (row.status === 'completed') {
    return mapMpesaRow(row);
  }
  const now = nowIso();
  db.prepare(
    `UPDATE mpesa_stk_requests
     SET status = 'failed', gateway_message = ?, updated_at = ?
     WHERE id = ?`
  ).run(reason.trim() || 'M-Pesa payment cancelled or failed.', now, row.id);
  db.prepare("UPDATE coin_purchases SET status = 'rejected' WHERE id = ?").run(row.id);
  return getMpesaStkRequestById(row.id)!;
}

export function listCustomBotTemplates(): TemplateBotSpec[] {
  const rows = getDb()
    .prepare('SELECT * FROM bot_templates ORDER BY created_at DESC')
    .all() as Array<{
    id: string;
    name: string;
    repo_full_name: string;
    repo_url: string;
    session_pair_url: string;
    session_pair_host: string;
    description: string;
    image_url: string;
    image_alt: string;
    platform: BotPlatform;
    framework: string;
    runtime: RuntimeEnvironment;
    default_branch: string;
    install_command: string;
    build_command: string;
    start_command: string;
    default_env_vars_json: string;
  }>;

  return rows.map((r) => {
    let defaultEnvVars: TemplateEnvField[] = [];
    try {
      defaultEnvVars = JSON.parse(r.default_env_vars_json) as TemplateEnvField[];
    } catch {
      defaultEnvVars = [];
    }
    return {
      id: r.id,
      name: r.name,
      repoFullName: r.repo_full_name,
      repoUrl: r.repo_url,
      sessionPairUrl: r.session_pair_url,
      sessionPairHost: r.session_pair_host,
      description: r.description,
      imageUrl: r.image_url,
      imageAlt: r.image_alt,
      platform: r.platform,
      framework: r.framework,
      runtime: r.runtime,
      defaultBranch: r.default_branch,
      installCommand: r.install_command,
      buildCommand: r.build_command,
      startCommand: r.start_command,
      defaultEnvVars,
      isCustom: true,
    } as TemplateBotSpec & { isCustom: boolean };
  });
}

export function createCustomBotTemplate(
  input: {
    name: string;
    repoInput: string;
    sessionPairUrl?: string;
    description: string;
    platform?: BotPlatform;
    framework?: string;
    runtime?: RuntimeEnvironment;
    defaultBranch?: string;
    installCommand?: string;
    buildCommand?: string;
    startCommand?: string;
    imageUrl?: string;
    defaultEnvKeys?: string[];
  },
  createdBy: string
): TemplateBotSpec {
  const db = getDb();
  const name = input.name.trim();
  const rawRepo = input.repoInput.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!name || !rawRepo) {
    throw new Error('Template name and GitHub repository (owner/repo or URL) are required.');
  }

  let repoFullName = rawRepo;
  let repoUrl = rawRepo;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rawRepo)) {
    repoFullName = rawRepo;
    repoUrl = `https://github.com/${rawRepo}`;
  } else {
    try {
      const normalized = rawRepo.startsWith('http') ? rawRepo : `https://${rawRepo}`;
      const u = new URL(normalized);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 2) {
        throw new Error('Invalid GitHub repository URL.');
      }
      repoFullName = `${parts[0]}/${parts[1]}`;
      repoUrl = `https://github.com/${repoFullName}`;
    } catch {
      throw new Error('Enter a valid GitHub URL or owner/repo shorthand.');
    }
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const id = `${slug || 'bot'}-${crypto.randomBytes(2).toString('hex')}`;

  const pairUrl = (input.sessionPairUrl || '').trim();
  let pairHost = 'Manual / Env Vars';
  if (pairUrl) {
    try {
      pairHost = new URL(pairUrl.startsWith('http') ? pairUrl : `https://${pairUrl}`).host;
    } catch {
      pairHost = pairUrl;
    }
  }

  const keys = (input.defaultEnvKeys && input.defaultEnvKeys.length > 0
    ? input.defaultEnvKeys
    : ['SESSION_ID', 'PREFIX', 'OWNER_NUMBER']
  )
    .map((k) => k.trim().toUpperCase().replace(/[^A-Z0-9_]/g, ''))
    .filter(Boolean);

  const defaultEnvVars: TemplateEnvField[] = Array.from(new Set(keys)).map((key) => ({
    key,
    label: key.replace(/_/g, ' '),
    placeholder: key === 'PREFIX' ? '.' : `Enter ${key}`,
    isSecret: /(TOKEN|SECRET|KEY|SESSION|PASSWORD|PASS|AUTH)/i.test(key),
  }));

  const now = nowIso();
  const imageUrl = (input.imageUrl || '').trim() || '/src/assets/images/bot_keith_1795010401552.jpg';

  db.prepare(
    `INSERT INTO bot_templates
     (id, name, repo_full_name, repo_url, session_pair_url, session_pair_host, description,
      image_url, image_alt, platform, framework, runtime, default_branch,
      install_command, build_command, start_command, default_env_vars_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    repoFullName,
    repoUrl,
    pairUrl,
    pairHost,
    input.description.trim() || `${name} automated bot template hosted on Lyrihost.`,
    imageUrl,
    `${name} bot template banner`,
    input.platform || 'whatsapp',
    (input.framework || '').trim() || 'Baileys MD',
    input.runtime || 'node-20',
    (input.defaultBranch || '').trim() || 'main',
    (input.installCommand || '').trim() || 'npm install --legacy-peer-deps --ignore-engines',
    (input.buildCommand || '').trim(),
    (input.startCommand || '').trim() || 'npm start',
    JSON.stringify(defaultEnvVars),
    createdBy,
    now
  );

  return listCustomBotTemplates().find((t) => t.id === id)!;
}

export function deleteCustomBotTemplate(id: string): boolean {
  const res = getDb().prepare('DELETE FROM bot_templates WHERE id = ?').run(id);
  return res.changes > 0;
}

export function flushDbToDisk(): void {
  if (!dbInstance) return;
  try {
    dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // ignore checkpoint error on shutdown
  }
}

export interface FullDatabaseSnapshot {
  version: 1;
  exportedAt: string;
  dataDir: string;
  tables: {
    app_meta: Array<Record<string, unknown>>;
    users: Array<Record<string, unknown>>;
    deployments: Array<Record<string, unknown>>;
    coin_transactions: Array<Record<string, unknown>>;
    coin_purchases: Array<Record<string, unknown>>;
    coupons: Array<Record<string, unknown>>;
    coupon_redemptions: Array<Record<string, unknown>>;
    support_tickets: Array<Record<string, unknown>>;
    email_campaigns: Array<Record<string, unknown>>;
    mpesa_stk_requests: Array<Record<string, unknown>>;
    bot_templates: Array<Record<string, unknown>>;
  };
}

export function exportFullDatabaseSnapshot(): FullDatabaseSnapshot {
  const db = getDb();
  flushDbToDisk();
  return {
    version: 1,
    exportedAt: nowIso(),
    dataDir: DATA_DIR,
    tables: {
      app_meta: db.prepare('SELECT * FROM app_meta').all() as Array<Record<string, unknown>>,
      users: db.prepare('SELECT * FROM users').all() as Array<Record<string, unknown>>,
      deployments: db.prepare('SELECT * FROM deployments').all() as Array<Record<string, unknown>>,
      coin_transactions: db.prepare('SELECT * FROM coin_transactions').all() as Array<Record<string, unknown>>,
      coin_purchases: db.prepare('SELECT * FROM coin_purchases').all() as Array<Record<string, unknown>>,
      coupons: db.prepare('SELECT * FROM coupons').all() as Array<Record<string, unknown>>,
      coupon_redemptions: db.prepare('SELECT * FROM coupon_redemptions').all() as Array<Record<string, unknown>>,
      support_tickets: db.prepare('SELECT * FROM support_tickets').all() as Array<Record<string, unknown>>,
      email_campaigns: db.prepare('SELECT * FROM email_campaigns').all() as Array<Record<string, unknown>>,
      mpesa_stk_requests: db.prepare('SELECT * FROM mpesa_stk_requests').all() as Array<Record<string, unknown>>,
      bot_templates: db.prepare('SELECT * FROM bot_templates').all() as Array<Record<string, unknown>>,
    },
  };
}

export function restoreFullDatabaseSnapshot(snapshot: FullDatabaseSnapshot): {
  usersRestored: number;
  deploymentsRestored: number;
  ticketsRestored: number;
  couponsRestored: number;
} {
  if (!snapshot || snapshot.version !== 1 || !snapshot.tables || typeof snapshot.tables !== 'object') {
    throw new Error('Invalid Lyrihost backup snapshot format.');
  }

  const db = getDb();
  const t = snapshot.tables;
  let usersRestored = 0;
  let deploymentsRestored = 0;
  let ticketsRestored = 0;
  let couponsRestored = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const row of t.app_meta || []) {
      if (typeof row.key === 'string' && typeof row.value === 'string') {
        db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(row.key, row.value);
      }
    }

    for (const row of t.users || []) {
      db.prepare(
        `INSERT OR REPLACE INTO users
         (id, email, password_hash, verified, role, coin_balance, max_deployments, referral_code,
          referred_by_user_id, referral_rewarded, streak_count, last_streak_date, last_streak_claimed_at,
          promo_emails_opt_in, accepted_terms, consent_accepted_at, preferences_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(row.id),
        String(row.email),
        String(row.password_hash),
        Number(row.verified ?? 1),
        String(row.role ?? 'user'),
        Number(row.coin_balance ?? 0),
        Number(row.max_deployments ?? DEFAULT_MAX_DEPLOYMENTS),
        String(row.referral_code),
        row.referred_by_user_id != null ? String(row.referred_by_user_id) : null,
        Number(row.referral_rewarded ?? 0),
        Number(row.streak_count ?? 0),
        row.last_streak_date != null ? String(row.last_streak_date) : null,
        row.last_streak_claimed_at != null ? String(row.last_streak_claimed_at) : null,
        Number(row.promo_emails_opt_in ?? 1),
        Number(row.accepted_terms ?? 1),
        row.consent_accepted_at != null ? String(row.consent_accepted_at) : null,
        row.preferences_json != null ? String(row.preferences_json) : null,
        String(row.created_at ?? nowIso())
      );
      usersRestored += 1;
    }

    for (const row of t.deployments || []) {
      db.prepare(
        `INSERT OR REPLACE INTO deployments
         (id, numeric_id, owner_user_id, owner_email, plan_id, expires_at, memory_limit_mb, status, data_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(row.id),
        Number(row.numeric_id ?? 1),
        row.owner_user_id != null ? String(row.owner_user_id) : null,
        row.owner_email != null ? String(row.owner_email) : null,
        row.plan_id != null ? String(row.plan_id) : 'plan_15d',
        row.expires_at != null ? String(row.expires_at) : null,
        Number(row.memory_limit_mb ?? 512),
        String(row.status ?? 'stopped'),
        String(row.data_json ?? '{}'),
        String(row.created_at ?? nowIso()),
        String(row.updated_at ?? nowIso())
      );
      deploymentsRestored += 1;
    }

    for (const row of t.coin_transactions || []) {
      db.prepare(
        `INSERT OR REPLACE INTO coin_transactions
         (id, user_id, type, amount, balance_after, counterparty_email, description, reference_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(row.id),
        String(row.user_id),
        String(row.type),
        Number(row.amount ?? 0),
        Number(row.balance_after ?? 0),
        row.counterparty_email != null ? String(row.counterparty_email) : null,
        String(row.description ?? ''),
        row.reference_id != null ? String(row.reference_id) : null,
        String(row.created_at ?? nowIso())
      );
    }

    for (const row of t.coin_purchases || []) {
      db.prepare(
        `INSERT OR REPLACE INTO coin_purchases
         (id, user_id, email, coins, amount_ksh, payment_method, payment_reference, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(row.id),
        String(row.user_id),
        String(row.email),
        Number(row.coins ?? 0),
        Number(row.amount_ksh ?? 0),
        String(row.payment_method ?? 'mpesa'),
        String(row.payment_reference ?? ''),
        String(row.status ?? 'completed'),
        String(row.created_at ?? nowIso())
      );
    }

    for (const row of t.coupons || []) {
      db.prepare(
        `INSERT OR REPLACE INTO coupons
         (code, coins, max_uses, uses_count, target_email, expires_at, created_by, created_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(row.code),
        Number(row.coins ?? 0),
        Number(row.max_uses ?? 1),
        Number(row.uses_count ?? 0),
        row.target_email != null ? String(row.target_email) : null,
        row.expires_at != null ? String(row.expires_at) : null,
        String(row.created_by ?? ADMIN_EMAIL),
        String(row.created_at ?? nowIso()),
        Number(row.is_active ?? 1)
      );
      couponsRestored += 1;
    }

    for (const row of t.coupon_redemptions || []) {
      db.prepare(
        `INSERT OR REPLACE INTO coupon_redemptions
         (id, coupon_code, user_id, coins, redeemed_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        String(row.id),
        String(row.coupon_code),
        String(row.user_id),
        Number(row.coins ?? 0),
        String(row.redeemed_at ?? nowIso())
      );
    }

    for (const row of t.support_tickets || []) {
      db.prepare(
        `INSERT OR REPLACE INTO support_tickets
         (id, user_id, user_email, category, priority, subject, message, status, admin_reply, replied_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(row.id),
        String(row.user_id),
        String(row.user_email),
        String(row.category ?? 'complaint'),
        String(row.priority ?? 'normal'),
        String(row.subject ?? ''),
        String(row.message ?? ''),
        String(row.status ?? 'open'),
        row.admin_reply != null ? String(row.admin_reply) : null,
        row.replied_at != null ? String(row.replied_at) : null,
        String(row.created_at ?? nowIso()),
        String(row.updated_at ?? nowIso())
      );
      ticketsRestored += 1;
    }

    for (const row of t.email_campaigns || []) {
      db.prepare(
        `INSERT OR REPLACE INTO email_campaigns
         (id, sender_email, recipient_scope, recipient_count, subject, body_text, sent_count, failed_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(row.id),
        String(row.sender_email),
        String(row.recipient_scope ?? 'promo_opted_in'),
        Number(row.recipient_count ?? 0),
        String(row.subject ?? ''),
        String(row.body_text ?? ''),
        Number(row.sent_count ?? 0),
        Number(row.failed_count ?? 0),
        String(row.created_at ?? nowIso())
      );
    }

    for (const row of t.mpesa_stk_requests || []) {
      db.prepare(
        `INSERT OR REPLACE INTO mpesa_stk_requests
         (id, user_id, email, phone_number, coins, amount_ksh, checkout_request_id, merchant_request_id,
          mpesa_receipt, status, gateway_message, gateway_dispatched, created_at, completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(row.id),
        String(row.user_id),
        String(row.email),
        String(row.phone_number),
        Number(row.coins ?? 0),
        Number(row.amount_ksh ?? 0),
        row.checkout_request_id != null ? String(row.checkout_request_id) : null,
        row.merchant_request_id != null ? String(row.merchant_request_id) : null,
        row.mpesa_receipt != null ? String(row.mpesa_receipt) : null,
        String(row.status ?? 'pending'),
        row.gateway_message != null ? String(row.gateway_message) : null,
        Number(row.gateway_dispatched ?? 0),
        String(row.created_at ?? nowIso()),
        row.completed_at != null ? String(row.completed_at) : null,
        String(row.updated_at ?? nowIso())
      );
    }

    for (const row of t.bot_templates || []) {
      db.prepare(
        `INSERT OR REPLACE INTO bot_templates
         (id, name, repo_full_name, repo_url, session_pair_url, session_pair_host, description,
          image_url, image_alt, platform, framework, runtime, default_branch,
          install_command, build_command, start_command, default_env_vars_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(row.id),
        String(row.name),
        String(row.repo_full_name),
        String(row.repo_url),
        String(row.session_pair_url ?? ''),
        String(row.session_pair_host ?? ''),
        String(row.description ?? ''),
        String(row.image_url ?? ''),
        String(row.image_alt ?? ''),
        String(row.platform ?? 'whatsapp'),
        String(row.framework ?? 'Baileys MD'),
        String(row.runtime ?? 'node-20'),
        String(row.default_branch ?? 'main'),
        String(row.install_command ?? ''),
        String(row.build_command ?? ''),
        String(row.start_command ?? 'npm start'),
        String(row.default_env_vars_json ?? '[]'),
        String(row.created_by ?? ADMIN_EMAIL),
        String(row.created_at ?? nowIso())
      );
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  flushDbToDisk();
  return {
    usersRestored,
    deploymentsRestored,
    ticketsRestored,
    couponsRestored,
  };
}

