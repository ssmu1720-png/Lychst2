export type BotPlatform = 'discord' | 'telegram' | 'whatsapp' | 'slack' | 'custom';

export type RuntimeEnvironment =
  | 'node-20'
  | 'node-22'
  | 'python-3.12'
  | 'docker'
  | 'bun-1';

export type DeploymentStatus =
  | 'online'
  | 'building'
  | 'scanning'
  | 'stopped'
  | 'failed';

export type ComputeTier = 'nano' | 'standard' | 'pro' | 'cluster';

export type RestartPolicy = 'always' | 'on-failure' | 'never';

export const DEPLOY_REGIONS = [
  { id: 'us-east', label: 'us-east (Virginia, US)' },
  { id: 'us-west', label: 'us-west (Oregon, US)' },
  { id: 'ca-central', label: 'ca-central (Toronto, CA)' },
  { id: 'eu-west', label: 'eu-west (Frankfurt, DE)' },
  { id: 'uk-south', label: 'uk-south (London, UK)' },
  { id: 'eu-north', label: 'eu-north (Stockholm, SE)' },
  { id: 'ap-south', label: 'ap-south (Singapore, SG)' },
  { id: 'ap-northeast', label: 'ap-northeast (Tokyo, JP)' },
  { id: 'ap-southeast', label: 'ap-southeast (Sydney, AU)' },
  { id: 'sa-east', label: 'sa-east (Sao Paulo, BR)' },
  { id: 'af-south', label: 'af-south (Cape Town, ZA)' },
  { id: 'me-central', label: 'me-central (Dubai, UAE)' },
] as const;

export type DeployRegion = (typeof DEPLOY_REGIONS)[number]['id'];

export type SecuritySeverity = 'critical' | 'warning' | 'pass';

export interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  title: string;
  detail: string;
  filePath?: string;
}

export interface EnvVarEntry {
  key: string;
  value: string;
  isSecret: boolean;
  detectedFrom?: string;
}

export interface RepoFileNode {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

export interface GitHubScanResult {
  owner: string;
  repo: string;
  fullName: string;
  repoUrl: string;
  description: string;
  defaultBranch: string;
  branches: string[];
  stars: number;
  forks: number;
  language: string;
  license: string;
  isPrivate: boolean;
  latestCommitSha: string;
  latestCommitMessage: string;
  scannedAt: string;
  detectedPlatform: BotPlatform;
  detectedFramework: string;
  detectedRuntime: RuntimeEnvironment;
  detectedEntryPoint: string;
  suggestedInstallCmd: string;
  suggestedBuildCmd: string;
  suggestedStartCmd: string;
  hasDockerfile: boolean;
  hasPackageJson: boolean;
  hasRequirementsTxt: boolean;
  dependencies: string[];
  detectedEnvVars: EnvVarEntry[];
  securityFindings: SecurityFinding[];
  fileTree: RepoFileNode[];
  totalFiles: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  stage: string;
  message: string;
}

export const ADMIN_EMAIL = 'sharksam004@gmail.com';
export const SUPPORT_PHONE = '254106625145';

export type DeploymentPlanId = 'plan_15d' | 'plan_30d' | 'plan_unlimited';

export interface DeploymentPlanSpec {
  id: DeploymentPlanId;
  name: string;
  durationLabel: string;
  durationDays: number | null;
  coinCost: number;
  kshCost: number;
  memoryLimitMb: number;
  computeTier: ComputeTier;
  summary: string;
}

export const DEPLOYMENT_PLANS: DeploymentPlanSpec[] = [
  {
    id: 'plan_15d',
    name: '15-Day Standard',
    durationLabel: '15 Days',
    durationDays: 15,
    coinCost: 10,
    kshCost: 10,
    memoryLimitMb: 512,
    computeTier: 'standard',
    summary: 'Ideal for testing & lightweight bots · 512 MB dedicated RAM',
  },
  {
    id: 'plan_30d',
    name: '30-Day Pro',
    durationLabel: '30 Days',
    durationDays: 30,
    coinCost: 25,
    kshCost: 25,
    memoryLimitMb: 1024,
    computeTier: 'pro',
    summary: 'Full monthly hosting · 1024 MB high-throughput RAM',
  },
  {
    id: 'plan_unlimited',
    name: 'Unlimited Cluster',
    durationLabel: 'Unlimited Days',
    durationDays: null,
    coinCost: 50,
    kshCost: 50,
    memoryLimitMb: 2048,
    computeTier: 'cluster',
    summary: 'No expiry · Priority 2048 MB High-RAM allocation',
  },
];

export interface BotSettings {
  name: string;
  branch: string;
  region: DeployRegion;
  runtime: RuntimeEnvironment;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  computeTier: ComputeTier;
  planId?: DeploymentPlanId;
  restartPolicy: RestartPolicy;
  autoDeploy: boolean;
  healthCheckPath: string;
  envVars: EnvVarEntry[];
}

export interface TelemetryPoint {
  ts: string;
  cpuPercent: number;
  memoryMb: number;
  latencyMs: number;
  eventsPerMin: number;
}

export interface BotDeployment {
  id: string;
  numericId?: number;
  ownerUserId?: string;
  ownerEmail?: string;
  planId?: DeploymentPlanId;
  expiresAt?: string | null;
  pid?: number | null;
  gitToken?: string | null;
  name: string;
  repoUrl: string;
  repoFullName: string;
  platform: BotPlatform;
  framework: string;
  status: DeploymentStatus;
  desiredRunning?: boolean;
  commitSha: string;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt: string;
  uptimeSeconds: number;
  cpuPercent: number;
  memoryMb: number;
  memoryLimitMb: number;
  gatewayLatencyMs: number;
  eventsPerMin: number;
  networkKbps: number;
  onlineChecks?: number;
  totalChecks?: number;
  uptimePercentage?: number;
  healthScore?: number;
  appSlug?: string;
  monitorToken?: string;
  publicAppEnabled?: boolean;
  customDomain?: string | null;
  customDomainVerified?: boolean;
  telemetryHistory: TelemetryPoint[];
  settings: BotSettings;
  scanReport: GitHubScanResult | null;
  logs: LogEntry[];
}

export interface DeploymentNetworkingInfo {
  supported: boolean;
  publicAppEnabled: boolean;
  appSlug: string;
  monitorToken: string;
  internalPort: number;
  pathAppUrl: string | null;
  subdomainAppUrl: string | null;
  customDomain: string | null;
  customDomainVerified: boolean;
  customDomainUrl: string | null;
  uptimeMonitorUrl: string | null;
  serverHost: string;
  railwayDomain: string;
  railwayDomainSource: 'preference' | 'env' | 'detected' | 'none';
  platformWildcardDomain: string;
}

export interface PlatformPreferences {
  defaultRegion: DeployRegion;
  defaultRestartPolicy: RestartPolicy;
  defaultRuntime?: RuntimeEnvironment;
  telemetryCadenceSec?: 2 | 5 | 10;
  compactFleetCards?: boolean;
  deployAlertEmails?: boolean;
  autoClearStoppedLogs?: boolean;
  matrixIntensity: 'full' | 'subtle' | 'off';
  githubTokenConfigured: boolean;
  webhookSecret: string;
  promoEmailsOptIn?: boolean;
  lowCoinAlertThreshold?: number;
  railwayDomain?: string;
  platformWildcardDomain?: string;
}

export interface MpesaStkRequest {
  id: string;
  userId: string;
  email: string;
  phoneNumber: string;
  coins: number;
  amountKsh: number;
  checkoutRequestId: string | null;
  merchantRequestId: string | null;
  mpesaReceipt: string | null;
  status: 'pending' | 'completed' | 'failed';
  gatewayMessage: string | null;
  gatewayDispatched: boolean;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  createdAt: string;
  isAdmin: boolean;
  coinBalance: number;
  unlimitedCoins: boolean;
  maxDeployments: number;
  activeDeploymentsCount: number;
  referralCode: string;
  referralCount: number;
  streakCount: number;
  lastStreakDate: string | null;
  canClaimDailyStreak: boolean;
  promoEmailsOptIn: boolean;
}

export interface DailyStreakReward {
  claimedNow: boolean;
  coinsAwarded: number;
  streakCount: number;
  message: string;
}

export type CoinTransactionType =
  | 'daily_streak'
  | 'referral_bonus'
  | 'transfer_out'
  | 'transfer_in'
  | 'purchase'
  | 'deploy_spend'
  | 'coupon_redeem'
  | 'admin_grant';

export interface CoinTransaction {
  id: string;
  userId: string;
  type: CoinTransactionType;
  amount: number;
  balanceAfter: number;
  counterpartyEmail: string | null;
  description: string;
  referenceId: string | null;
  createdAt: string;
}

export interface CoinPurchase {
  id: string;
  userId: string;
  email: string;
  coins: number;
  amountKsh: number;
  paymentMethod: 'mpesa' | 'card' | 'instant';
  paymentReference: string;
  status: 'completed' | 'pending' | 'rejected';
  createdAt: string;
}

export interface ReferralEntry {
  id: string;
  email: string;
  rewarded: boolean;
  coinsEarned: number;
  createdAt: string;
}

export interface CouponRecord {
  code: string;
  coins: number;
  maxUses: number;
  usesCount: number;
  targetEmail: string | null;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  isActive: boolean;
}

export type SupportTicketCategory = 'complaint' | 'billing' | 'bug' | 'feature' | 'other';
export type SupportTicketPriority = 'normal' | 'high' | 'urgent';
export type SupportTicketStatus = 'open' | 'in_review' | 'resolved';

export interface SupportTicket {
  id: string;
  userId: string;
  userEmail: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  subject: string;
  message: string;
  status: SupportTicketStatus;
  adminReply: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailCampaign {
  id: string;
  senderEmail: string;
  recipientScope: string;
  recipientCount: number;
  subject: string;
  bodyText: string;
  sentCount: number;
  failedCount: number;
  createdAt: string;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  isAdmin: boolean;
  verified: boolean;
  coinBalance: number;
  unlimitedCoins: boolean;
  maxDeployments: number;
  deploymentCount: number;
  referralCode: string;
  referralCount: number;
  streakCount: number;
  promoEmailsOptIn: boolean;
  createdAt: string;
}

export interface AdminAppDetails {
  totalUsers: number;
  verifiedUsers: number;
  totalDeployments: number;
  onlineDeployments: number;
  totalCoinsInCirculation: number;
  totalKshPurchased: number;
  totalPurchasesCount: number;
  totalReferrals: number;
  activeCouponsCount: number;
  openTicketsCount: number;
  emailsSentTotal: number;
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  dbSizeKb: number;
  adminEmail: string;
}


