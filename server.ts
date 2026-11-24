import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { createAdminRouter } from './server/adminRouter.ts';
import {
  createAuthRouter,
  requireAuth,
  resolveAuthenticatedUser,
  type AuthenticatedRequest,
} from './server/authRouter.ts';
import { createBotsRouter } from './server/botsRouter.ts';
import {
  buildAuthUser,
  deleteDeploymentFromDb,
  detectEnvRailwayDomain,
  flushDbToDisk,
  getDeploymentPlan,
  getMeta,
  getUserById,
  getUserPreferences,
  isAdminEmail,
  listCustomBotTemplates,
  renewDeploymentPlan,
  saveUserPreferences,
  setMeta,
  spendCoinsForDeployment,
} from './server/db.ts';
import { createSupportRouter } from './server/supportRouter.ts';
import { createWalletRouter } from './server/walletRouter.ts';
import {
  buildEnvMap,
  pullRepository,
  resolveDeploymentCommands,
  runShellStep,
  writeDotEnvFile,
} from './server/gitRunner.ts';
import {
  getAssignedBotPort,
  getBotDir,
  getProcess,
  isAutoRestarting,
  isRunning,
  probeBotProcessHealth,
  processEmitter,
  safeRemoveDir,
  sampleProcessStats,
  sendInput,
  sendRawInput,
  setDbRestartCallback,
  setProcessExitCallback,
  startProcess,
  stopProcess,
  stopProcessAndWait,
  waitForProcessStability,
} from './server/processManager.ts';
import { getEmailTransportStatus } from './server/emailService.ts';
import { BotDeploymentEngine } from './server/deployEngine.ts';
import {
  buildDeploymentNetworkingInfo,
  extractRequestHost,
  isNodeHostedRuntime,
  normalizeHostname,
  proxyHttpRequest,
  proxyWebSocketUpgrade,
  resolveDeploymentByProxyRequest,
  supportsPublicEndpoints,
  verifyCustomDomainDns,
} from './server/appProxy.ts';
import { TEMPLATE_BOTS } from './src/catalog/templateBots.ts';
import {
  buildEmptyTelemetryHistory,
  generateMonitorToken,
  generateUniqueAppSlug,
  loadState,
  makeId,
  nowIso,
  pushDeploymentLog,
  saveStateToDisk,
  type PersistedState,
} from './server/stateStore.ts';
import type {
  BotDeployment,
  BotPlatform,
  BotSettings,
  ComputeTier,
  DeploymentPlanId,
  EnvVarEntry,
  GitHubScanResult,
  LogEntry,
  PlatformPreferences,
  RepoFileNode,
  RuntimeEnvironment,
  SecurityFinding,
} from './src/types/lyrihost.ts';

const PORT = Number(process.env.PORT || 3000);

const TIER_MEMORY_MB: Record<ComputeTier, number> = {
  nano: 256,
  standard: 512,
  pro: 1024,
  cluster: 2048,
};

let state: PersistedState = loadState();
const sseClients = new Map<express.Response, { userId: string | null; isAdmin: boolean }>();

function saveState(): void {
  saveStateToDisk(state);
}

function getVisibleDeployments(userId: string | null, isAdmin: boolean): BotDeployment[] {
  if (isAdmin) return state.deployments;
  if (!userId) return state.deployments;
  return state.deployments.filter((d) => !d.ownerUserId || d.ownerUserId === userId);
}

function canManageDeployment(req: express.Request, dep: BotDeployment): boolean {
  const user = resolveAuthenticatedUser(req);
  if (!user) return !dep.ownerUserId;
  if (isAdminEmail(user.email)) return true;
  return !dep.ownerUserId || dep.ownerUserId === user.id;
}

function broadcastDeployments(): void {
  if (sseClients.size === 0) return;
  const serverTime = nowIso();
  for (const [client, meta] of sseClients.entries()) {
    try {
      const scoped = getVisibleDeployments(meta.userId, meta.isAdmin);
      const payload = `data: ${JSON.stringify({ deployments: scoped, serverTime })}\n\n`;
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

const deployEngine = new BotDeploymentEngine({
  getState: () => state,
  saveState,
  broadcast: broadcastDeployments,
});

processEmitter.on('output', ({ botId, chunk }: { botId: string; chunk: string }) => {
  const target = state.deployments.find((d) => d.id === botId);
  if (!target) return;
  const lines = chunk
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return;
  for (const line of lines.slice(0, 25)) {
    const lower = line.toLowerCase();
    const level: LogEntry['level'] =
      lower.includes('error') || lower.includes('[erro') || lower.includes('uncaught')
        ? 'error'
        : lower.includes('warn')
          ? 'warn'
          : 'info';
    pushDeploymentLog(target, level, 'stdout', line);
  }
  broadcastDeployments();
});

setDbRestartCallback((botId, pid) => {
  deployEngine.onAutoRestarted(botId, pid);
});

setProcessExitCallback((botId, code) => {
  const target = state.deployments.find((d) => d.id === botId);
  if (!target) return;
  target.status = code === 0 || code === null ? 'stopped' : 'failed';
  if (target.settings.restartPolicy === 'never') {
    target.desiredRunning = false;
  }
  target.pid = null;
  target.cpuPercent = 0;
  target.memoryMb = 0;
  target.gatewayLatencyMs = 0;
  target.uptimeSeconds = 0;
  target.healthScore = 0;
  pushDeploymentLog(
    target,
    code === 0 || code === null ? 'warn' : 'error',
    'runtime',
    `Process exited with code ${code ?? 'null'}.`
  );
  saveState();
  broadcastDeployments();
});

const watchdogLastAttempt = new Map<string, number>();

async function recoverBotProcess(dep: BotDeployment): Promise<void> {
  const now = Date.now();
  const last = watchdogLastAttempt.get(dep.id) ?? 0;
  if (now - last < 10000) return;
  watchdogLastAttempt.set(dep.id, now);

  if (
    dep.status === 'building' ||
    isRunning(dep.id, dep.pid) ||
    isAutoRestarting(dep.id) ||
    deployEngine.isPipelineActive(dep.id) ||
    deployEngine.activeRestores.has(dep.id)
  ) {
    return;
  }

  const botDir = getBotDir(dep.id);
  const hasNodeModulesOrPy =
    fs.existsSync(botDir) &&
    (!fs.existsSync(path.join(botDir, 'package.json')) || fs.existsSync(path.join(botDir, 'node_modules')));

  if (!fs.existsSync(botDir) || !hasNodeModulesOrPy) {
    pushDeploymentLog(dep, 'warn', 'runtime', '24/7 Watchdog rebuilding missing workspace...');
    saveState();
    broadcastDeployments();
    void deployEngine.deploy(dep);
    return;
  }

  try {
    writeDotEnvFile(botDir, dep.settings.envVars, {
      assignedPort: getAssignedBotPort(dep.numericId),
    });
    const resolved = resolveDeploymentCommands(botDir, dep.settings);
    dep.settings.startCommand = resolved.startCommand;
    const bp = startProcess(dep.id, resolved.startCommand, {
      numericId: dep.numericId,
      restartPolicy: dep.settings.restartPolicy,
      memoryLimitMb: dep.memoryLimitMb,
      env: buildEnvMap(dep.settings.envVars),
    });
    const stability = await waitForProcessStability(dep.id, 1000);
    if (stability.alive) {
      dep.status = 'online';
      dep.desiredRunning = true;
      dep.pid = bp.pid;
      dep.uptimeSeconds = 1;
      pushDeploymentLog(dep, 'success', 'runtime', `24/7 Watchdog recovered bot process (PID ${bp.pid}).`);
      saveState();
      broadcastDeployments();
    }
  } catch (err) {
    pushDeploymentLog(
      dep,
      'error',
      'runtime',
      `24/7 Watchdog recovery attempt failed: ${err instanceof Error ? err.message : 'Unknown error'}`
    );
    saveState();
    broadcastDeployments();
  }
}

async function measureBotProbeLatency(dep: BotDeployment, statsStartMs: number): Promise<number> {
  const portEntry = dep.settings.envVars.find((v) => v.key === 'PORT' || v.key === 'WEB_PORT');
  const envPort = portEntry ? Number.parseInt(portEntry.value.trim(), 10) : Number.NaN;
  const candidatePort =
    Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 && envPort !== PORT
      ? envPort
      : getAssignedBotPort(dep.numericId);

  if (candidatePort > 0 && candidatePort <= 65535 && candidatePort !== PORT) {
    const rawPath = (dep.settings.healthCheckPath || '/health').trim();
    const healthPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const probeStart = performance.now();
    try {
      await fetch(`http://127.0.0.1:${candidatePort}${healthPath}`, {
        method: 'GET',
        signal: AbortSignal.timeout(400),
      });
      return Math.max(1, Math.round(performance.now() - probeStart));
    } catch {
      // Bot may not expose an HTTP server (e.g. Baileys WebSocket-only); fall back to OS probe RTT
    }
  }
  return Math.max(1, Math.round(performance.now() - statsStartMs));
}

function computeBotHealthScore(
  latencyMs: number,
  memoryMb: number,
  memoryLimitMb: number,
  uptimePercentage: number
): number {
  const latencyScore =
    latencyMs <= 40
      ? 100
      : latencyMs <= 350
        ? Math.round(100 - ((latencyMs - 40) / 310) * 80)
        : Math.max(0, Math.round(20 - (latencyMs - 350) / 25));

  const memRatio = memoryMb / Math.max(1, memoryLimitMb);
  const memoryScore =
    memRatio <= 0.65
      ? 100
      : memRatio <= 1
        ? Math.round(100 - ((memRatio - 0.65) / 0.35) * 85)
        : Math.max(0, Math.round(15 - (memRatio - 1) * 50));

  const clampedUptime = Math.max(0, Math.min(100, uptimePercentage));
  return Math.max(
    0,
    Math.min(100, Math.round(latencyScore * 0.35 + memoryScore * 0.35 + clampedUptime * 0.3))
  );
}

// Real-time 1.5s telemetry loop: samples real OS process CPU/RAM, probe latency, uptime %, and health score
let tickCounter = 0;
setInterval(() => {
  tickCounter += 1;
  void (async () => {
    const ts = nowIso();
    let changed = false;

    for (const dep of state.deployments) {
      const expired = Boolean(dep.expiresAt && Date.parse(dep.expiresAt) <= Date.now());
      if (dep.status === 'online') {
        if (expired) {
          deployEngine.abort(dep.id);
          stopProcess(dep.id);
          dep.status = 'stopped';
          dep.desiredRunning = false;
          dep.pid = null;
          dep.cpuPercent = 0;
          dep.memoryMb = 0;
          dep.gatewayLatencyMs = 0;
          dep.uptimeSeconds = 0;
          dep.healthScore = 0;
          pushDeploymentLog(
            dep,
            'warn',
            'runtime',
            'Hosting plan expired. Renew or upgrade plan in Coins / Deployments to restart.'
          );
          changed = true;
          continue;
        }
        if (isAutoRestarting(dep.id)) {
          continue;
        }
        if (!isRunning(dep.id, dep.pid)) {
          if (dep.desiredRunning !== false && dep.settings.restartPolicy !== 'never') {
            dep.pid = null;
            void recoverBotProcess(dep);
            continue;
          }
          dep.status = 'stopped';
          dep.desiredRunning = false;
          dep.pid = null;
          dep.cpuPercent = 0;
          dep.memoryMb = 0;
          dep.gatewayLatencyMs = 0;
          dep.uptimeSeconds = 0;
          dep.healthScore = 0;
          changed = true;
        } else {
          dep.uptimeSeconds += tickCounter % 2 === 0 ? 2 : 1;
          const probeStart = performance.now();
          const [stats, latencyMs] = await Promise.all([
            dep.pid ? sampleProcessStats(dep.pid) : Promise.resolve(null),
            measureBotProbeLatency(dep, probeStart),
          ]);
          if (stats) {
            dep.cpuPercent = stats.cpuPercent;
            dep.memoryMb = stats.memoryMb;
          }
          dep.gatewayLatencyMs = latencyMs;
          dep.onlineChecks = (dep.onlineChecks ?? 0) + 1;
          dep.totalChecks = (dep.totalChecks ?? 0) + 1;
          dep.uptimePercentage =
            dep.totalChecks > 0
              ? Math.round((dep.onlineChecks / dep.totalChecks) * 1000) / 10
              : 100;
          dep.healthScore = computeBotHealthScore(
            dep.gatewayLatencyMs,
            dep.memoryMb,
            dep.memoryLimitMb,
            dep.uptimePercentage
          );
          dep.telemetryHistory.push({
            ts,
            cpuPercent: dep.cpuPercent,
            memoryMb: dep.memoryMb,
            latencyMs: dep.gatewayLatencyMs,
            eventsPerMin: dep.eventsPerMin,
          });
          if (dep.telemetryHistory.length > 28) {
            dep.telemetryHistory = dep.telemetryHistory.slice(-28);
          }
          continue;
        }
      }

      if (
        !expired &&
        dep.desiredRunning === true &&
        dep.settings.restartPolicy === 'always' &&
        (dep.status === 'stopped' || dep.status === 'failed') &&
        !isRunning(dep.id, dep.pid) &&
        !isAutoRestarting(dep.id) &&
        !deployEngine.isPipelineActive(dep.id) &&
        !deployEngine.activeRestores.has(dep.id)
      ) {
        void recoverBotProcess(dep);
      }

      if (dep.status === 'failed') {
        dep.totalChecks = (dep.totalChecks ?? 0) + 1;
        dep.uptimePercentage =
          dep.totalChecks > 0
            ? Math.round(((dep.onlineChecks ?? 0) / dep.totalChecks) * 1000) / 10
            : 0;
      }

      dep.cpuPercent = 0;
      dep.memoryMb = 0;
      dep.gatewayLatencyMs = 0;
      dep.eventsPerMin = 0;
      dep.networkKbps = 0;
      dep.healthScore = 0;
      dep.telemetryHistory.push({
        ts,
        cpuPercent: 0,
        memoryMb: 0,
        latencyMs: 0,
        eventsPerMin: 0,
      });
      if (dep.telemetryHistory.length > 28) {
        dep.telemetryHistory = dep.telemetryHistory.slice(-28);
      }
    }

    if (changed || tickCounter % 4 === 0) {
      saveState();
    }
    broadcastDeployments();
  })();
}, 1500);

function parseGitHubRepo(input: string): { owner: string; repo: string; requestedBranch?: string } | null {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!trimmed) return null;

  // Support owner/repo shorthand
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    const [owner, repo] = trimmed.split('/');
    return { owner, repo };
  }

  try {
    const normalized = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    const url = new URL(normalized);
    if (!url.hostname.toLowerCase().includes('github.com')) {
      return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, '');
    let requestedBranch: string | undefined;
    if (parts[2] === 'tree' && parts[3]) {
      requestedBranch = parts.slice(3).join('/');
    }
    return { owner, repo, requestedBranch };
  } catch {
    return null;
  }
}

async function githubFetchJson<T>(url: string, token?: string): Promise<{ ok: boolean; status: number; data?: T; message?: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Lyrihost-Bot-Scanner/1.0',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    let errMsg = `GitHub API returned HTTP ${resp.status}`;
    try {
      const errBody = (await resp.json()) as { message?: string };
      if (errBody?.message) errMsg = errBody.message;
    } catch {
      // ignore json parse error
    }
    return { ok: false, status: resp.status, message: errMsg };
  }
  const data = (await resp.json()) as T;
  return { ok: true, status: resp.status, data };
}

async function fetchRepoFileContent(
  owner: string,
  repo: string,
  filePath: string,
  branch: string,
  token?: string
): Promise<string | null> {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const res = await githubFetchJson<{ content?: string; encoding?: string }>(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    token
  );
  if (!res.ok || !res.data?.content) return null;
  try {
    if (res.data.encoding === 'base64') {
      return Buffer.from(res.data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
    }
    return res.data.content;
  } catch {
    return null;
  }
}

function isLikelySecretKey(key: string): boolean {
  return /(TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH|CREDENTIAL|URI|DSN)/i.test(key);
}

const SCAN_COLLIDING_PORTS = new Set(['', '3000', '5000', '8000', '8080']);
const SCAN_PLACEHOLDER_RE = /^(?:YOUR_SESSION_ID_HERE|254XXXXXXXXX|62xxxx|your[_-].*)$/i;

function parseEnvFileKeys(content: string, sourceFile: string): EnvVarEntry[] {
  const entries: EnvVarEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim().replace(/^export\s+/, '');
    if (!/^[A-Z0-9_]+$/i.test(key) || seen.has(key)) continue;
    seen.add(key);
    let val = line.slice(eqIndex + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if ((key === 'PORT' || key === 'SERVER_PORT') && SCAN_COLLIDING_PORTS.has(val.trim())) {
      continue;
    }
    if (SCAN_PLACEHOLDER_RE.test(val.trim())) {
      val = '';
    }
    const secret = isLikelySecretKey(key);
    entries.push({
      key,
      value: secret ? '' : val,
      isSecret: secret,
      detectedFrom: sourceFile,
    });
  }
  return entries;
}

function detectEnvKeysInCode(code: string, sourceFile: string): EnvVarEntry[] {
  const entries: EnvVarEntry[] = [];
  const seen = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
    /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /os\.environ(?:\.get)?\[?\(?['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  ];
  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(code)) !== null) {
      const key = match[1];
      if (key === 'NODE_ENV' || key === 'PORT' || seen.has(key)) continue;
      seen.add(key);
      entries.push({
        key,
        value: '',
        isSecret: isLikelySecretKey(key),
        detectedFrom: sourceFile,
      });
    }
  }
  return entries;
}

function detectHardcodedSecrets(code: string, filePath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const secretChecks: Array<{ name: string; regex: RegExp }> = [
    { name: 'Discord Bot Token pattern', regex: /[MN][A-Za-z\d]{23,26}\.[\w-]{6}\.[\w-]{27,38}/ },
    { name: 'Telegram Bot Token pattern', regex: /\b\d{8,11}:[A-Za-z0-9_-]{30,40}\b/ },
    { name: 'GitHub Personal Access Token', regex: /\bgh[ps]_[A-Za-z0-9]{30,}\b/ },
    { name: 'OpenAI / API Secret Key', regex: /\bsk-[A-Za-z0-9]{24,}\b/ },
  ];
  for (const check of secretChecks) {
    if (check.regex.test(code)) {
      findings.push({
        id: makeId('sec'),
        severity: 'critical',
        title: `Hardcoded ${check.name} detected`,
        detail: `Found a credential-like literal inside ${filePath}. Move this value into Lyrihost encrypted environment variables and rotate the token immediately.`,
        filePath,
      });
    }
  }
  return findings;
}

async function performGitHubScan(
  repoInput: string,
  branchOverride?: string,
  requestToken?: string
): Promise<GitHubScanResult> {
  const parsed = parseGitHubRepo(repoInput);
  if (!parsed) {
    throw new Error('Enter a valid GitHub repository URL or owner/repo path (for example: telegraf/telegraf).');
  }

  const effectiveToken = requestToken?.trim() || state.githubToken || process.env.GITHUB_TOKEN || undefined;
  const { owner, repo, requestedBranch } = parsed;

  interface GitHubRepoResponse {
    full_name: string;
    html_url: string;
    description: string | null;
    default_branch: string;
    stargazers_count: number;
    forks_count: number;
    language: string | null;
    private: boolean;
    license?: { spdx_id?: string; name?: string } | null;
  }

  const repoRes = await githubFetchJson<GitHubRepoResponse>(
    `https://api.github.com/repos/${owner}/${repo}`,
    effectiveToken
  );

  if (!repoRes.ok || !repoRes.data) {
    if (repoRes.status === 404) {
      throw new Error(`Repository "${owner}/${repo}" was not found on GitHub or is private (configure a GitHub Token in Settings for private repos).`);
    }
    if (repoRes.status === 403) {
      throw new Error(`GitHub API rate limit exceeded (${repoRes.message ?? '403'}). Add a GitHub Personal Access Token in Platform Settings to raise limits.`);
    }
    throw new Error(repoRes.message || `Failed to read repository "${owner}/${repo}".`);
  }

  const repoMeta = repoRes.data;
  const targetBranch = branchOverride || requestedBranch || repoMeta.default_branch || 'main';

  const [branchesRes, commitRes, treeRes] = await Promise.all([
    githubFetchJson<Array<{ name: string }>>(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=30`,
      effectiveToken
    ),
    githubFetchJson<{ sha: string; commit?: { message?: string } }>(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(targetBranch)}`,
      effectiveToken
    ),
    githubFetchJson<{ tree?: Array<{ path: string; type: 'blob' | 'tree'; size?: number }>; truncated?: boolean }>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(targetBranch)}?recursive=1`,
      effectiveToken
    ),
  ]);

  const branches = branchesRes.ok && branchesRes.data
    ? branchesRes.data.map((b) => b.name)
    : [targetBranch];
  if (!branches.includes(targetBranch)) {
    branches.unshift(targetBranch);
  }

  const allTreeNodes: RepoFileNode[] = (treeRes.ok && treeRes.data?.tree ? treeRes.data.tree : [])
    .map((n) => ({
      path: n.path,
      type: n.type,
      size: n.size,
    }));

  const filePaths = allTreeNodes.filter((n) => n.type === 'blob').map((n) => n.path);
  const pathSet = new Set(filePaths);

  const hasDockerfile = pathSet.has('Dockerfile') || filePaths.some((p) => p.endsWith('/Dockerfile'));
  const hasPackageJson = pathSet.has('package.json');
  const hasRequirementsTxt = pathSet.has('requirements.txt');
  const hasPyproject = pathSet.has('pyproject.toml');
  const hasGitignore = pathSet.has('.gitignore');
  const committedEnvFiles = filePaths.filter((p) => /(^|\/)\.env(\.local|\.prod|\.production)?$/i.test(p));

  const envTemplatePath = [
    '.env.example',
    '.env.sample',
    '.env-sample',
    'set.env',
    'config.env',
    '.env',
    'session_id.txt',
  ].find((f) => pathSet.has(f));
  const [pkgRaw, reqRaw, pyprojRaw, dockerRaw, envExampleRaw, appJsonRaw, procfileRaw, gitignoreRaw] =
    await Promise.all([
      hasPackageJson ? fetchRepoFileContent(owner, repo, 'package.json', targetBranch, effectiveToken) : Promise.resolve(null),
      hasRequirementsTxt ? fetchRepoFileContent(owner, repo, 'requirements.txt', targetBranch, effectiveToken) : Promise.resolve(null),
      hasPyproject ? fetchRepoFileContent(owner, repo, 'pyproject.toml', targetBranch, effectiveToken) : Promise.resolve(null),
      pathSet.has('Dockerfile') ? fetchRepoFileContent(owner, repo, 'Dockerfile', targetBranch, effectiveToken) : Promise.resolve(null),
      envTemplatePath
        ? fetchRepoFileContent(owner, repo, envTemplatePath, targetBranch, effectiveToken)
        : Promise.resolve(null),
      pathSet.has('app.json') ? fetchRepoFileContent(owner, repo, 'app.json', targetBranch, effectiveToken) : Promise.resolve(null),
      pathSet.has('Procfile') ? fetchRepoFileContent(owner, repo, 'Procfile', targetBranch, effectiveToken) : Promise.resolve(null),
      hasGitignore ? fetchRepoFileContent(owner, repo, '.gitignore', targetBranch, effectiveToken) : Promise.resolve(null),
    ]);

  let dependencies: string[] = [];
  let detectedRuntime: RuntimeEnvironment = 'node-20';
  let detectedPlatform: BotPlatform = 'custom';
  let detectedFramework = 'Custom Bot Service';
  let detectedEntryPoint = '';
  let suggestedInstallCmd = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
  let suggestedBuildCmd = '';
  let suggestedStartCmd = 'npm start';

  const securityFindings: SecurityFinding[] = [];
  const envMap = new Map<string, EnvVarEntry>();

  if (envExampleRaw && envTemplatePath) {
    for (const item of parseEnvFileKeys(envExampleRaw, envTemplatePath)) {
      envMap.set(item.key, item);
    }
  }

  if (appJsonRaw) {
    try {
      const appJson = JSON.parse(appJsonRaw) as {
        env?: Record<string, { value?: string; description?: string; required?: boolean }>;
      };
      if (appJson.env && typeof appJson.env === 'object') {
        for (const [k, meta] of Object.entries(appJson.env)) {
          const cleanKey = k.trim();
          if (!/^[A-Z0-9_]+$/i.test(cleanKey) || envMap.has(cleanKey)) continue;
          if (cleanKey === 'PORT' || cleanKey === 'SERVER_PORT') continue;
          const rawVal = typeof meta?.value === 'string' ? meta.value.trim() : '';
          const val = SCAN_PLACEHOLDER_RE.test(rawVal) ? '' : rawVal;
          const secret = isLikelySecretKey(cleanKey);
          envMap.set(cleanKey, {
            key: cleanKey,
            value: secret ? '' : val,
            isSecret: secret,
            detectedFrom: 'app.json',
          });
        }
      }
    } catch {
      // ignore invalid app.json
    }
  }

  // Parse Node.js package.json
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        main?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        engines?: { node?: string };
      };
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
      dependencies = Object.keys(pkg.dependencies || {});
      const depKeysLower = Object.keys(allDeps).map((d) => d.toLowerCase());

      if (
        (pkg.engines?.node && /(?:>=?\s*22|\b22\b)/i.test(pkg.engines.node)) ||
        /--experimental-sqlite/i.test(pkg.scripts?.start || '')
      ) {
        detectedRuntime = 'node-22';
      } else if (pathSet.has('bun.lockb') || pathSet.has('bun.lock')) {
        detectedRuntime = 'bun-1';
      } else {
        detectedRuntime = 'node-20';
      }

      // Framework detection
      if (depKeysLower.some((d) => d === 'discord.js' || d === 'eris' || d === 'oceanic.js')) {
        detectedPlatform = 'discord';
        detectedFramework = depKeysLower.includes('discord.js') ? 'discord.js' : depKeysLower.includes('eris') ? 'Eris' : 'Oceanic.js';
      } else if (depKeysLower.some((d) => d === 'telegraf' || d === 'grammy' || d === 'node-telegram-bot-api')) {
        detectedPlatform = 'telegram';
        detectedFramework = depKeysLower.includes('telegraf') ? 'Telegraf' : depKeysLower.includes('grammy') ? 'grammY' : 'node-telegram-bot-api';
      } else if (depKeysLower.some((d) => d.includes('baileys') || d === 'whatsapp-web.js')) {
        detectedPlatform = 'whatsapp';
        detectedFramework = depKeysLower.some((d) => d.includes('baileys')) ? 'Baileys' : 'whatsapp-web.js';
      } else if (depKeysLower.some((d) => d === '@slack/bolt' || d === '@slack/web-api')) {
        detectedPlatform = 'slack';
        detectedFramework = 'Slack Bolt';
      } else {
        detectedFramework = 'Node.js Bot';
      }

      if (detectedRuntime === 'bun-1') {
        suggestedInstallCmd = 'bun install';
      } else {
        suggestedInstallCmd = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
      }

      if (pkg.scripts?.build) {
        suggestedBuildCmd = detectedRuntime === 'bun-1' ? 'bun run build' : 'npm run build';
      }
      if (pkg.scripts?.start) {
        suggestedStartCmd = detectedRuntime === 'bun-1' ? 'bun run start' : 'npm start';
        if (pkg.main) {
          detectedEntryPoint = pkg.main;
        }
      } else if (procfileRaw) {
        const procLine = procfileRaw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => /^(?:web|worker)\s*:/i.test(l));
        if (procLine) {
          suggestedStartCmd = procLine.replace(/^(?:web|worker)\s*:\s*/i, '').trim() || 'npm start';
        }
        if (pkg.main) {
          detectedEntryPoint = pkg.main;
        }
      } else if (pkg.main) {
        suggestedStartCmd = `node ${pkg.main}`;
        detectedEntryPoint = pkg.main;
      }

      if (!pkg.scripts?.start && !pkg.main && !procfileRaw) {
        securityFindings.push({
          id: makeId('sec'),
          severity: 'warning',
          title: 'Missing start script in package.json',
          detail: 'package.json does not specify a "start" script or "main" entry file. Confirm your Start Command before deploying.',
          filePath: 'package.json',
        });
      }
    } catch {
      securityFindings.push({
        id: makeId('sec'),
        severity: 'warning',
        title: 'Invalid package.json syntax',
        detail: 'Could not parse package.json cleanly during static inspection.',
        filePath: 'package.json',
      });
    }
  } else if (reqRaw || pyprojRaw || repoMeta.language === 'Python') {
    detectedRuntime = 'python-3.12';
    suggestedInstallCmd = hasRequirementsTxt ? 'pip install -r requirements.txt' : 'pip install .';
    suggestedBuildCmd = '';

    const pyDepsText = `${reqRaw || ''}\n${pyprojRaw || ''}`.toLowerCase();
    if (reqRaw) {
      dependencies = reqRaw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(/[=<>!~]/)[0].trim())
        .slice(0, 40);
    }

    if (pyDepsText.includes('discord.py') || pyDepsText.includes('nextcord') || pyDepsText.includes('py-cord') || pyDepsText.includes('hikari')) {
      detectedPlatform = 'discord';
      detectedFramework = pyDepsText.includes('discord.py') ? 'discord.py' : pyDepsText.includes('nextcord') ? 'Nextcord' : 'Python Discord';
    } else if (pyDepsText.includes('python-telegram-bot') || pyDepsText.includes('aiogram') || pyDepsText.includes('telethon') || pyDepsText.includes('pyrogram')) {
      detectedPlatform = 'telegram';
      detectedFramework = pyDepsText.includes('aiogram') ? 'aiogram' : pyDepsText.includes('telethon') ? 'Telethon' : 'python-telegram-bot';
    } else if (pyDepsText.includes('slack_bolt') || pyDepsText.includes('slack-sdk')) {
      detectedPlatform = 'slack';
      detectedFramework = 'Slack Bolt Python';
    } else {
      detectedFramework = 'Python Bot';
    }

    const pyEntryCandidates = ['bot.py', 'main.py', 'app.py', 'src/bot.py', 'src/main.py'];
    const foundPy = pyEntryCandidates.find((c) => pathSet.has(c)) || filePaths.find((p) => p.endsWith('.py'));
    if (foundPy) {
      detectedEntryPoint = foundPy;
      suggestedStartCmd = `python ${foundPy}`;
    } else {
      suggestedStartCmd = 'python main.py';
    }
  } else if (hasDockerfile) {
    detectedRuntime = 'docker';
    suggestedInstallCmd = '';
    suggestedBuildCmd = 'docker build -t lyrihost-bot .';
    suggestedStartCmd = 'docker run --rm lyrihost-bot';
    detectedFramework = 'Docker Container';
  }

  // Fallback platform check from repo name/description if still custom
  if (detectedPlatform === 'custom') {
    const metaText = `${repoMeta.full_name} ${repoMeta.description || ''}`.toLowerCase();
    if (metaText.includes('discord')) detectedPlatform = 'discord';
    else if (metaText.includes('telegram') || metaText.includes('telegraf')) detectedPlatform = 'telegram';
    else if (metaText.includes('whatsapp') || metaText.includes('baileys')) detectedPlatform = 'whatsapp';
    else if (metaText.includes('slack')) detectedPlatform = 'slack';
  }

  // Locate candidate source entry files to scan for env vars & hardcoded secrets
  const candidateFiles = [
    detectedEntryPoint,
    'settings.js',
    'set.js',
    'config.js',
    'config/settings.js',
    'core/setup.js',
    'system/config.js',
    'Guru Tech/index.js',
    'black/index.js',
    'index.js',
    'index.ts',
    'src/index.ts',
    'src/index.js',
    'src/bot.ts',
    'src/bot.js',
    'bot.js',
    'bot.py',
    'main.py',
  ]
    .filter((p): p is string => Boolean(p) && pathSet.has(p))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 6);

  const codeContents = await Promise.all(
    candidateFiles.map(async (filePath) => ({
      filePath,
      content: await fetchRepoFileContent(owner, repo, filePath, targetBranch, effectiveToken),
    }))
  );

  for (const { filePath, content } of codeContents) {
    if (!content) continue;
    for (const envItem of detectEnvKeysInCode(content, filePath)) {
      if (!envMap.has(envItem.key)) {
        envMap.set(envItem.key, envItem);
      }
    }
    securityFindings.push(...detectHardcodedSecrets(content, filePath));
  }

  if (!detectedEntryPoint && candidateFiles.length > 0) {
    detectedEntryPoint = candidateFiles[0];
  } else if (!detectedEntryPoint) {
    detectedEntryPoint = filePaths[0] || 'README.md';
  }

  // Security & hygiene rules
  if (committedEnvFiles.length > 0) {
    securityFindings.unshift({
      id: makeId('sec'),
      severity: 'critical',
      title: 'Committed .env file present in repository',
      detail: `Detected ${committedEnvFiles.join(', ')} tracked in Git. Remove environment files from version control and rotate any exposed bot tokens.`,
      filePath: committedEnvFiles[0],
    });
  } else {
    securityFindings.push({
      id: makeId('sec'),
      severity: 'pass',
      title: 'No committed .env files found',
      detail: 'Repository tree contains no tracked .env files exposing plaintext tokens.',
    });
  }

  if (!hasGitignore) {
    securityFindings.push({
      id: makeId('sec'),
      severity: 'warning',
      title: 'Missing .gitignore configuration',
      detail: 'Add a .gitignore file excluding .env, node_modules, and __pycache__ before pushing future updates.',
    });
  } else if (gitignoreRaw && !gitignoreRaw.includes('.env')) {
    securityFindings.push({
      id: makeId('sec'),
      severity: 'warning',
      title: '.env pattern missing from .gitignore',
      detail: 'Your .gitignore does not explicitly exclude .env files.',
      filePath: '.gitignore',
    });
  } else {
    securityFindings.push({
      id: makeId('sec'),
      severity: 'pass',
      title: 'Gitignore secret protection active',
      detail: '.gitignore correctly excludes local environment files from source control.',
      filePath: '.gitignore',
    });
  }

  if (hasDockerfile && dockerRaw) {
    if (/USER\s+root/i.test(dockerRaw) || !/USER\s+/i.test(dockerRaw)) {
      securityFindings.push({
        id: makeId('sec'),
        severity: 'warning',
        title: 'Container runs as default root user',
        detail: 'Dockerfile does not declare a non-root USER instruction. Lyrihost will enforce sandboxed runtime isolation.',
        filePath: 'Dockerfile',
      });
    } else {
      securityFindings.push({
        id: makeId('sec'),
        severity: 'pass',
        title: 'Dockerfile non-root runtime verified',
        detail: 'Dockerfile specifies an unprivileged USER context.',
        filePath: 'Dockerfile',
      });
    }
  }

  if (envMap.size === 0) {
    // Provide helpful default bot token placeholder if platform detected
    const defaultKey =
      detectedPlatform === 'discord'
        ? 'DISCORD_TOKEN'
        : detectedPlatform === 'telegram'
          ? 'BOT_TOKEN'
          : detectedPlatform === 'slack'
            ? 'SLACK_BOT_TOKEN'
            : 'BOT_API_KEY';
    envMap.set(defaultKey, {
      key: defaultKey,
      value: '',
      isSecret: true,
      detectedFrom: 'Suggested for ' + detectedFramework,
    });
  }

  const commitSha = commitRes.ok && commitRes.data?.sha ? commitRes.data.sha.slice(0, 7) : 'head';
  const commitMsg = commitRes.ok && commitRes.data?.commit?.message
    ? commitRes.data.commit.message.split('\n')[0]
    : 'Latest commit on ' + targetBranch;

  return {
    owner,
    repo,
    fullName: repoMeta.full_name,
    repoUrl: repoMeta.html_url,
    description: repoMeta.description || 'No repository description provided.',
    defaultBranch: repoMeta.default_branch,
    branches,
    stars: repoMeta.stargazers_count,
    forks: repoMeta.forks_count,
    language: repoMeta.language || 'Unknown',
    license: repoMeta.license?.spdx_id || repoMeta.license?.name || 'None',
    isPrivate: repoMeta.private,
    latestCommitSha: commitSha,
    latestCommitMessage: commitMsg,
    scannedAt: nowIso(),
    detectedPlatform,
    detectedFramework,
    detectedRuntime,
    detectedEntryPoint,
    suggestedInstallCmd,
    suggestedBuildCmd,
    suggestedStartCmd,
    hasDockerfile,
    hasPackageJson,
    hasRequirementsTxt,
    dependencies: dependencies.slice(0, 40),
    detectedEnvVars: Array.from(envMap.values()),
    securityFindings,
    fileTree: allTreeNodes.slice(0, 220),
    totalFiles: filePaths.length,
  };
}

function appendLog(dep: BotDeployment, level: LogEntry['level'], stage: string, message: string): void {
  pushDeploymentLog(dep, level, stage, message);
  saveState();
  broadcastDeployments();
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);

  const getEffectiveWildcardDomain = (): string =>
    normalizeHostname(state.preferences.platformWildcardDomain || process.env.APP_WILDCARD_DOMAIN || '') || '';

  // Auto-detect live public origin so PaaS keepalive & public app links work without manual APP_URL env
  let learnedPublicOrigin = getMeta('public_keepalive_origin') || '';

  const getEffectiveRailwayDomain = (): {
    domain: string;
    source: 'preference' | 'env' | 'detected' | 'none';
  } => {
    const prefDomain = state.preferences.railwayDomain
      ? normalizeHostname(state.preferences.railwayDomain)
      : null;
    if (prefDomain) {
      return { domain: prefDomain, source: 'preference' };
    }
    const envHost = normalizeHostname(detectEnvRailwayDomain());
    if (envHost) {
      return { domain: envHost, source: 'env' };
    }
    if (learnedPublicOrigin) {
      try {
        const learnedHost = normalizeHostname(new URL(learnedPublicOrigin).hostname);
        if (learnedHost && learnedHost.endsWith('.up.railway.app')) {
          return { domain: learnedHost, source: 'detected' };
        }
      } catch {
        // ignore invalid learned origin
      }
    }
    return { domain: '', source: 'none' };
  };

  const resolveRequestPublicContext = (req?: express.Request): {
    origin: string;
    serverHost: string;
    railwayDomain: string;
    railwayDomainSource: 'preference' | 'env' | 'detected' | 'none';
  } => {
    const rawHost = req
      ? (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim()
      : '';
    const rawProto = req
      ? (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim()
      : 'https';

    const railway = getEffectiveRailwayDomain();
    const envExternal =
      (railway.domain ? `https://${railway.domain}` : '') ||
      process.env.APP_URL?.trim() ||
      process.env.PUBLIC_URL?.trim() ||
      process.env.RENDER_EXTERNAL_URL?.trim() ||
      '';

    const hostOnly = extractRequestHost(rawHost);
    const wildcard = getEffectiveWildcardDomain();
    const isUserHost = Boolean(
      hostOnly &&
        (state.deployments.some((d) => d.customDomain && d.customDomain === hostOnly) ||
          (wildcard && hostOnly.endsWith(`.${wildcard}`)))
    );

    let origin = envExternal || learnedPublicOrigin;
    if (railway.domain) {
      origin = `https://${railway.domain}`;
    } else if (
      !isUserHost &&
      rawHost &&
      !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(rawHost) &&
      !/\.internal(:\d+)?$/i.test(rawHost)
    ) {
      origin = `${rawProto === 'https' ? 'https' : 'http'}://${rawHost}`;
    } else if (!origin && rawHost) {
      origin = `${rawProto === 'https' ? 'https' : 'http'}://${rawHost}`;
    }

    let serverHost = railway.domain;
    if (!serverHost && origin) {
      try {
        serverHost = new URL(origin).hostname;
      } catch {
        serverHost = extractRequestHost(rawHost);
      }
    } else if (!serverHost && rawHost) {
      serverHost = extractRequestHost(rawHost);
    }

    return {
      origin: origin.replace(/\/+$/, ''),
      serverHost,
      railwayDomain: railway.domain,
      railwayDomainSource: railway.source,
    };
  };

  // Reverse-proxy incoming requests for custom domains, <slug>.<wildcard>, or /app/<slug>/ BEFORE express.json()
  app.use((req, res, next) => {
    const match = resolveDeploymentByProxyRequest(
      req.originalUrl || req.url || '/',
      req.headers['x-forwarded-host'] || req.headers.host,
      state.deployments,
      getEffectiveWildcardDomain()
    );
    if (match) {
      proxyHttpRequest(req, res, match);
      return;
    }
    next();
  });

  app.use(cors());
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, _res, next) => {
    const rawHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
    const rawProto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
    if (
      rawHost &&
      !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(rawHost) &&
      !/\.internal(:\d+)?$/i.test(rawHost)
    ) {
      // Only learn main platform origins, never user-app subdomains or custom domains
      const hostOnly = extractRequestHost(rawHost);
      const wildcard = getEffectiveWildcardDomain();
      const isUserDomain =
        state.deployments.some((d) => d.customDomain && d.customDomain === hostOnly) ||
        Boolean(wildcard && hostOnly.endsWith(`.${wildcard}`));
      if (!isUserDomain) {
        const origin = `${rawProto === 'https' ? 'https' : 'http'}://${rawHost}`;
        if (origin !== learnedPublicOrigin) {
          learnedPublicOrigin = origin;
          try {
            setMeta('public_keepalive_origin', origin);
          } catch {
            // ignore meta write error
          }
        }
      }
    }
    next();
  });

  // Mount authentication, wallet, support, and admin routes
  app.use('/api/auth', createAuthRouter());
  app.use('/api/wallet', createWalletRouter());
  app.use('/api/support', createSupportRouter((userId) => state.deployments.filter((d) => d.ownerUserId === userId)));
  app.use(
    '/api/admin',
    createAdminRouter(
      () => state.deployments,
      () => {
        state = loadState();
        broadcastDeployments();
      }
    )
  );

  // Mount wh-panel-site compatible API routes (/api/bots/*, /api/healthz, /api/system/info)
  app.use(
    '/api',
    createBotsRouter(
      () => state,
      saveState,
      broadcastDeployments
    )
  );

  // Health endpoint (also surfaces safe mail transport status & active bot count)
  app.get('/api/health', async (_req, res) => {
    const emailStatus = await getEmailTransportStatus().catch(() => null);
    res.json({
      ok: true,
      service: 'lyrihost',
      timestamp: nowIso(),
      uptimeSeconds: Math.round(process.uptime()),
      onlineBots: state.deployments.filter((d) => d.status === 'online').length,
      totalBots: state.deployments.length,
      email: emailStatus
        ? {
            configured: emailStatus.configured,
            activeProvider: emailStatus.activeProvider,
            resendSandboxOnly: emailStatus.resendSandboxOnly,
          }
        : null,
    });
  });

  // Public UptimeRobot / external monitor endpoint (Node apps & Node bots only; returns 200 UP / 503 DOWN)
  app.all('/up/:id/:token', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (
      !dep ||
      !supportsPublicEndpoints(dep) ||
      dep.publicAppEnabled === false ||
      !dep.monitorToken ||
      dep.monitorToken !== req.params.token
    ) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).json({ status: 'NOT_FOUND', error: 'Monitor endpoint not found or disabled.' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');

    const isExpired = Boolean(dep.expiresAt && Date.parse(dep.expiresAt) <= Date.now());
    const portEntry = dep.settings.envVars.find((v) => v.key === 'PORT' || v.key === 'WEB_PORT');
    const customPort = portEntry ? Number.parseInt(portEntry.value.trim(), 10) : null;
    const probe = await probeBotProcessHealth({
      botId: dep.id,
      numericId: dep.numericId,
      fallbackPid: dep.pid,
      customPort: Number.isInteger(customPort) ? customPort : null,
      healthCheckPath: dep.settings.healthCheckPath,
    });

    const isUp =
      !isExpired &&
      dep.status === 'online' &&
      probe.processAlive &&
      probe.osState !== 'Z';

    const payload = {
      status: isUp ? 'UP' : 'DOWN',
      name: dep.name,
      platform: dep.platform,
      runtime: dep.settings.runtime,
      state: isExpired ? 'expired' : dep.status,
      pidAlive: probe.processAlive,
      uptimeSeconds: isUp ? Math.max(dep.uptimeSeconds, Math.round(probe.uptimeMs / 1000)) : 0,
      httpListening: probe.httpProbe.listening,
      httpStatusCode: probe.httpProbe.statusCode,
      latencyMs: probe.httpProbe.latencyMs,
      checkedAt: nowIso(),
    };

    if (req.method === 'HEAD') {
      res.status(isUp ? 200 : 503).end();
      return;
    }
    res.status(isUp ? 200 : 503).json(payload);
  });

  // Curated + Admin-added WhatsApp & Multi-Device Bot Templates
  app.get('/api/templates', (_req, res) => {
    const customTemplates = listCustomBotTemplates();
    res.json([...TEMPLATE_BOTS, ...customTemplates]);
  });

  // Real-time Server-Sent Events stream for live dashboard telemetry & logs
  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const user = resolveAuthenticatedUser(req);
    const meta = {
      userId: user ? user.id : null,
      isAdmin: user ? isAdminEmail(user.email) : false,
    };
    sseClients.set(res, meta);
    const initialScoped = getVisibleDeployments(meta.userId, meta.isAdmin);
    res.write(`data: ${JSON.stringify({ deployments: initialScoped, serverTime: nowIso() })}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  // Platform preferences (per-user persisted in SQLite when authenticated)
  app.get('/api/preferences', (req, res) => {
    const railway = getEffectiveRailwayDomain();
    const user = resolveAuthenticatedUser(req);
    if (user) {
      const prefs = getUserPreferences(user.id);
      res.json({
        ...prefs,
        railwayDomain: prefs.railwayDomain || railway.domain,
      });
      return;
    }
    res.json({
      ...state.preferences,
      railwayDomain: state.preferences.railwayDomain || railway.domain,
      githubTokenConfigured: Boolean(state.githubToken || process.env.GITHUB_TOKEN),
    });
  });

  app.patch('/api/preferences', (req, res) => {
    const body = req.body as Partial<PlatformPreferences> & { githubToken?: string; clearGithubToken?: boolean };
    const user = resolveAuthenticatedUser(req);

    if (body.clearGithubToken) {
      delete state.githubToken;
    } else if (typeof body.githubToken === 'string' && body.githubToken.trim()) {
      state.githubToken = body.githubToken.trim();
    }

    if (body.defaultRegion) state.preferences.defaultRegion = body.defaultRegion;
    if (body.defaultRestartPolicy) state.preferences.defaultRestartPolicy = body.defaultRestartPolicy;
    if (body.defaultRuntime) state.preferences.defaultRuntime = body.defaultRuntime;
    if (
      body.telemetryCadenceSec === 2 ||
      body.telemetryCadenceSec === 5 ||
      body.telemetryCadenceSec === 10
    ) {
      state.preferences.telemetryCadenceSec = body.telemetryCadenceSec;
    }
    if (typeof body.compactFleetCards === 'boolean') {
      state.preferences.compactFleetCards = body.compactFleetCards;
    }
    if (typeof body.deployAlertEmails === 'boolean') {
      state.preferences.deployAlertEmails = body.deployAlertEmails;
    }
    if (typeof body.autoClearStoppedLogs === 'boolean') {
      state.preferences.autoClearStoppedLogs = body.autoClearStoppedLogs;
    }
    if (body.matrixIntensity) state.preferences.matrixIntensity = body.matrixIntensity;
    if (typeof body.webhookSecret === 'string' && body.webhookSecret.trim()) {
      state.preferences.webhookSecret = body.webhookSecret.trim();
    }
    if (typeof body.railwayDomain === 'string' && (!user || isAdminEmail(user.email))) {
      const cleanedRailway = body.railwayDomain.trim();
      if (!cleanedRailway) {
        state.preferences.railwayDomain = '';
        body.railwayDomain = '';
      } else {
        const normalizedRailway = normalizeHostname(cleanedRailway);
        if (!normalizedRailway) {
          res.status(400).json({
            error: 'Enter a valid Railway domain (for example: lyrihost-production.up.railway.app).',
          });
          return;
        }
        state.preferences.railwayDomain = normalizedRailway;
        body.railwayDomain = normalizedRailway;
      }
    }
    if (typeof body.platformWildcardDomain === 'string' && (!user || isAdminEmail(user.email))) {
      const cleanedWildcard = body.platformWildcardDomain.trim();
      if (!cleanedWildcard) {
        state.preferences.platformWildcardDomain = '';
        body.platformWildcardDomain = '';
      } else {
        const normalizedWildcard = normalizeHostname(cleanedWildcard);
        if (!normalizedWildcard) {
          res.status(400).json({ error: 'Enter a valid domain name for Platform Wildcard Domain (e.g. lyrihost.site).' });
          return;
        }
        state.preferences.platformWildcardDomain = normalizedWildcard;
        body.platformWildcardDomain = normalizedWildcard;
      }
    }
    state.preferences.githubTokenConfigured = Boolean(state.githubToken || process.env.GITHUB_TOKEN);
    saveState();

    const railway = getEffectiveRailwayDomain();
    if (user) {
      const updatedUserPrefs = saveUserPreferences(user.id, body);
      res.json({
        ...updatedUserPrefs,
        railwayDomain: updatedUserPrefs.railwayDomain || railway.domain,
      });
      return;
    }
    res.json({
      ...state.preferences,
      railwayDomain: state.preferences.railwayDomain || railway.domain,
    });
  });

  // Real GitHub Repository Scanner
  app.post('/api/github/scan', async (req, res) => {
    try {
      const { repoUrl, branch, githubToken } = req.body as {
        repoUrl?: string;
        branch?: string;
        githubToken?: string;
      };
      if (!repoUrl || !repoUrl.trim()) {
        res.status(400).json({ error: 'Please provide a GitHub repository URL or owner/repo.' });
        return;
      }
      const scan = await performGitHubScan(repoUrl, branch, githubToken);
      res.json(scan);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'GitHub scan failed.';
      res.status(400).json({ error: message });
    }
  });

  // Fetch file content preview from scanned GitHub repo
  app.post('/api/github/file', async (req, res) => {
    try {
      const { owner, repo, path: filePath, branch } = req.body as {
        owner?: string;
        repo?: string;
        path?: string;
        branch?: string;
      };
      if (!owner || !repo || !filePath || !branch) {
        res.status(400).json({ error: 'Missing repository file parameters.' });
        return;
      }
      const effectiveToken = state.githubToken || process.env.GITHUB_TOKEN || undefined;
      const content = await fetchRepoFileContent(owner, repo, filePath, branch, effectiveToken);
      if (content === null) {
        res.status(404).json({ error: 'File content could not be loaded (binary or oversized file).' });
        return;
      }
      res.json({ path: filePath, content: content.slice(0, 64000) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load file preview.' });
    }
  });

  // List deployments (scoped to operator or full view for admin)
  app.get('/api/deployments', (req, res) => {
    const user = resolveAuthenticatedUser(req);
    const list = getVisibleDeployments(user ? user.id : null, user ? isAdminEmail(user.email) : false);
    res.json(list);
  });

  // Get single deployment
  app.get('/api/deployments/:id', (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep || !canManageDeployment(req, dep)) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    res.json(dep);
  });

  // Create & deploy a scanned repository (enforces coin plan + per-user deployment limit + RAM tier)
  app.post('/api/deployments', (req, res) => {
    const authUser = resolveAuthenticatedUser(req);
    if (!authUser) {
      res.status(401).json({ error: 'Please sign in to deploy a bot.' });
      return;
    }

    const {
      repoUrl,
      repoFullName,
      platform,
      framework,
      commitSha,
      gitToken,
      planId: requestedPlanId,
      customDomain: requestedCustomDomain,
      settings,
      scanReport,
    } = req.body as {
      repoUrl?: string;
      repoFullName?: string;
      platform?: BotPlatform;
      framework?: string;
      commitSha?: string;
      gitToken?: string;
      planId?: DeploymentPlanId;
      customDomain?: string | null;
      settings?: BotSettings;
      scanReport?: GitHubScanResult | null;
    };

    if (!repoUrl || !settings || !settings.name?.trim()) {
      res.status(400).json({ error: 'Bot name, repository URL, and configuration settings are required.' });
      return;
    }

    // Enforce Acceptable Use Consent: block bug bots, crashers, flooders, crypto-miners, or destructive scripts
    const combinedPolicyText = [
      repoUrl,
      repoFullName || '',
      settings.name,
      settings.installCommand || '',
      settings.buildCommand || '',
      settings.startCommand || '',
    ]
      .join(' ')
      .toLowerCase();

    const prohibitedPatterns: Array<{ label: string; regex: RegExp }> = [
      { label: 'bug bot / WhatsApp crasher', regex: /\b(bug[-_\s]?bot|wa[-_\s]?bug|crash[-_\s]?bot|bugwa|virtex|killer[-_\s]?bot|freeze[-_\s]?bot)\b/i },
      { label: 'DDoS / spam flooder', regex: /\b(ddos|flooder|spammer|bomber|sms[-_\s]?bomb|raid[-_\s]?bot)\b/i },
      { label: 'crypto miner / malware', regex: /\b(xmrig|cryptominer|coinhive|ransomware|keylogger|stealer)\b/i },
      { label: 'destructive shell command', regex: /(rm\s+-rf\s+\/|:\(\)\{\s*:\|\:&\s*\};:|mkfs\.|dd\s+if=\/dev)/i },
    ];
    const matchedProhibition = prohibitedPatterns.find((p) => p.regex.test(combinedPolicyText));
    if (matchedProhibition) {
      res.status(400).json({
        error: `Deployment blocked by Lyrihost Acceptable Use Policy: detected prohibited "${matchedProhibition.label}" pattern. Bug bots and harmful scripts are strictly prohibited.`,
      });
      return;
    }

    const isNode = isNodeHostedRuntime(settings.runtime);
    let initialCustomDomain: string | null = null;
    if (typeof requestedCustomDomain === 'string' && requestedCustomDomain.trim()) {
      if (!isNode) {
        res.status(400).json({
          error: 'Custom domains are supported for Node.js apps and Node bots only.',
        });
        return;
      }
      const normalized = normalizeHostname(requestedCustomDomain);
      if (!normalized) {
        res.status(400).json({
          error: 'Enter a valid custom domain (for example: app.yourdomain.com). IP addresses and localhost are not allowed.',
        });
        return;
      }
      const conflict = state.deployments.find(
        (other) => other.customDomain?.toLowerCase() === normalized
      );
      if (conflict) {
        res.status(409).json({
          error: `Domain "${normalized}" is already connected to another deployment.`,
        });
        return;
      }
      initialCustomDomain = normalized;
    }

    const resolvedPlanId: DeploymentPlanId =
      requestedPlanId ||
      settings.planId ||
      (settings.computeTier === 'cluster'
        ? 'plan_unlimited'
        : settings.computeTier === 'pro'
          ? 'plan_30d'
          : 'plan_15d');

    const botId = makeId('bot');
    let billingResult;
    try {
      billingResult = spendCoinsForDeployment({
        userId: authUser.id,
        planId: resolvedPlanId,
        botId,
        botName: settings.name.trim(),
      });
    } catch (err) {
      res.status(402).json({
        error: err instanceof Error ? err.message : 'Unable to authorize deployment coins.',
      });
      return;
    }

    const sanitizedEnvVars: EnvVarEntry[] = (settings.envVars || [])
      .filter((e) => e.key.trim())
      .map((e) => ({
        key: e.key.trim(),
        value: e.value,
        isSecret: Boolean(e.isSecret),
        detectedFrom: e.detectedFrom,
      }));

    const numericId = state.nextNumericId++;
    const timestamp = nowIso();
    const { plan, expiresAt } = billingResult;

    const newDeployment: BotDeployment = {
      id: botId,
      numericId,
      ownerUserId: authUser.id,
      ownerEmail: authUser.email,
      planId: plan.id,
      expiresAt,
      pid: null,
      gitToken: gitToken?.trim() || null,
      name: settings.name.trim(),
      repoUrl,
      repoFullName: repoFullName || repoUrl,
      platform: platform || 'custom',
      framework: framework || 'Custom Bot',
      status: 'building',
      desiredRunning: true,
      commitSha: commitSha || 'head',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastDeployedAt: timestamp,
      uptimeSeconds: 0,
      cpuPercent: 0,
      memoryMb: 0,
      memoryLimitMb: plan.memoryLimitMb,
      gatewayLatencyMs: 0,
      eventsPerMin: 0,
      networkKbps: 0,
      onlineChecks: 0,
      totalChecks: 0,
      uptimePercentage: 0,
      healthScore: 0,
      ...(isNode
        ? {
            appSlug: generateUniqueAppSlug(settings.name.trim(), state.deployments, botId),
            monitorToken: generateMonitorToken(),
            publicAppEnabled: true,
            customDomain: initialCustomDomain,
            customDomainVerified: false,
          }
        : {}),
      telemetryHistory: buildEmptyTelemetryHistory(),
      settings: {
        ...settings,
        name: settings.name.trim(),
        computeTier: plan.computeTier,
        planId: plan.id,
        envVars: sanitizedEnvVars,
      },
      scanReport: scanReport || null,
      logs: [],
    };

    state.deployments.unshift(newDeployment);
    saveState();
    void deployEngine.deploy(newDeployment);
    res.status(201).json(newDeployment);
  });

  // Public App Links, UptimeRobot Monitor URL & In-App Custom Domain APIs (Node apps & Node bots)
  app.get('/api/deployments/:id/networking', (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep || !canManageDeployment(req, dep)) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    const { origin, serverHost, railwayDomain, railwayDomainSource } = resolveRequestPublicContext(req);
    res.json(
      buildDeploymentNetworkingInfo({
        dep,
        origin,
        serverHost,
        railwayDomain,
        railwayDomainSource,
        platformWildcardDomain: getEffectiveWildcardDomain(),
      })
    );
  });

  app.patch('/api/deployments/:id/domain', (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    if (!canManageDeployment(req, dep)) {
      res.status(403).json({ error: 'You do not have permission to update this domain.' });
      return;
    }
    if (!supportsPublicEndpoints(dep)) {
      res.status(400).json({
        error: 'Public web access and custom domains are available for Node.js apps and Node bots only.',
      });
      return;
    }

    const { customDomain, publicAppEnabled } = (req.body ?? {}) as {
      customDomain?: string | null;
      publicAppEnabled?: boolean;
    };

    if (typeof publicAppEnabled === 'boolean') {
      dep.publicAppEnabled = publicAppEnabled;
    }

    if (customDomain !== undefined) {
      const raw = (customDomain || '').trim();
      if (!raw) {
        dep.customDomain = null;
        dep.customDomainVerified = false;
      } else {
        const normalized = normalizeHostname(raw);
        if (!normalized) {
          res.status(400).json({
            error: 'Enter a valid domain or subdomain (for example: app.yourdomain.com). IP addresses and localhost are not allowed.',
          });
          return;
        }
        const conflict = state.deployments.find(
          (other) => other.id !== dep.id && other.customDomain?.toLowerCase() === normalized
        );
        if (conflict) {
          res.status(409).json({
            error: `Domain "${normalized}" is already connected to another deployment.`,
          });
          return;
        }
        if (dep.customDomain !== normalized) {
          dep.customDomain = normalized;
          dep.customDomainVerified = false;
        }
      }
    }

    if (!dep.appSlug) {
      dep.appSlug = generateUniqueAppSlug(dep.name, state.deployments, dep.id);
    }
    if (!dep.monitorToken) {
      dep.monitorToken = generateMonitorToken();
    }
    dep.updatedAt = nowIso();
    saveState();
    broadcastDeployments();

    const { origin, serverHost, railwayDomain, railwayDomainSource } = resolveRequestPublicContext(req);
    res.json({
      deployment: dep,
      networking: buildDeploymentNetworkingInfo({
        dep,
        origin,
        serverHost,
        railwayDomain,
        railwayDomainSource,
        platformWildcardDomain: getEffectiveWildcardDomain(),
      }),
    });
  });

  app.post('/api/deployments/:id/domain/verify', async (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    if (!canManageDeployment(req, dep)) {
      res.status(403).json({ error: 'You do not have permission to verify this domain.' });
      return;
    }
    if (!supportsPublicEndpoints(dep) || !dep.customDomain) {
      res.status(400).json({ error: 'Save a custom domain first before running DNS verification.' });
      return;
    }

    const { origin, serverHost, railwayDomain, railwayDomainSource } = resolveRequestPublicContext(req);
    const result = await verifyCustomDomainDns(dep.customDomain, railwayDomain || serverHost);
    dep.customDomainVerified = result.verified;
    dep.updatedAt = nowIso();
    saveState();
    broadcastDeployments();

    res.json({
      ...result,
      deployment: dep,
      networking: buildDeploymentNetworkingInfo({
        dep,
        origin,
        serverHost,
        railwayDomain,
        railwayDomainSource,
        platformWildcardDomain: getEffectiveWildcardDomain(),
      }),
    });
  });

  // Renew or upgrade an existing bot's hosting plan & RAM allocation
  app.post('/api/deployments/:id/renew', requireAuth, (req: AuthenticatedRequest, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep || !canManageDeployment(req, dep)) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    const { planId } = (req.body ?? {}) as { planId?: DeploymentPlanId };
    const plan = getDeploymentPlan(planId || dep.planId || 'plan_15d');

    try {
      const renewal = renewDeploymentPlan({
        userId: req.authUser!.id,
        botId: dep.id,
        planId: plan.id,
        currentExpiresAt: dep.expiresAt ?? null,
        botName: dep.name,
      });

      dep.planId = renewal.plan.id;
      dep.expiresAt = renewal.expiresAt;
      dep.memoryLimitMb = renewal.plan.memoryLimitMb;
      dep.settings.computeTier = renewal.plan.computeTier;
      dep.settings.planId = renewal.plan.id;
      if (!dep.ownerUserId) {
        dep.ownerUserId = req.authUser!.id;
        dep.ownerEmail = req.authUser!.email;
      }

      appendLog(
        dep,
        'success',
        'config',
        `Plan updated to ${renewal.plan.name} (${renewal.plan.durationLabel} · ${renewal.plan.memoryLimitMb} MB RAM).`
      );
      const freshUser = getUserById(req.authUser!.id);
      res.json({
        deployment: dep,
        user: freshUser ? buildAuthUser(freshUser) : undefined,
      });
    } catch (err) {
      res.status(402).json({
        error: err instanceof Error ? err.message : 'Unable to renew deployment plan.',
      });
    }
  });

  // Update deployment settings (and optionally redeploy)
  app.patch('/api/deployments/:id/settings', (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    if (!canManageDeployment(req, dep)) {
      res.status(403).json({ error: 'You do not have permission to modify this deployment.' });
      return;
    }
    const { settings, redeploy } = req.body as { settings?: Partial<BotSettings>; redeploy?: boolean };
    if (!settings) {
      res.status(400).json({ error: 'Settings payload is required.' });
      return;
    }

    dep.settings = {
      ...dep.settings,
      ...settings,
      name: settings.name?.trim() || dep.settings.name,
    };
    dep.name = dep.settings.name;
    dep.memoryLimitMb = TIER_MEMORY_MB[dep.settings.computeTier] || 512;
    dep.updatedAt = nowIso();

    const botDir = getBotDir(dep.id);
    if (fs.existsSync(botDir)) {
      writeDotEnvFile(botDir, dep.settings.envVars, {
        assignedPort: getAssignedBotPort(dep.numericId),
      });
    }

    appendLog(dep, 'info', 'config', 'Updated deployment configuration and environment variables.');

    if (redeploy) {
      void deployEngine.deploy(dep);
    } else {
      saveState();
    }
    res.json(dep);
  });

  // Re-run security scan on existing deployment
  app.post('/api/deployments/:id/rescan', async (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    if (!canManageDeployment(req, dep)) {
      res.status(403).json({ error: 'You do not have permission to rescan this deployment.' });
      return;
    }
    try {
      const scan = await performGitHubScan(dep.repoUrl, dep.settings.branch, dep.gitToken || undefined);
      dep.scanReport = scan;
      dep.commitSha = scan.latestCommitSha;
      dep.framework = scan.detectedFramework;
      dep.platform = scan.detectedPlatform;
      appendLog(
        dep,
        'info',
        'scan',
        `Completed fresh GitHub scan (${scan.totalFiles} files inspected, ${scan.securityFindings.filter((f) => f.severity === 'critical').length} critical findings).`
      );
      saveState();
      res.json(dep);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Rescan failed.' });
    }
  });

  // Git pull on existing deployment
  app.post('/api/deployments/:id/pull', async (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    if (!canManageDeployment(req, dep)) {
      res.status(403).json({ error: 'You do not have permission to pull this deployment.' });
      return;
    }
    const botDir = getBotDir(dep.id);
    const token = dep.gitToken || state.githubToken || process.env.GITHUB_TOKEN || undefined;
    const pullRes = await pullRepository(botDir, token);
    appendLog(dep, pullRes.ok ? 'info' : 'error', 'pull', pullRes.output.slice(-600));
    res.json({ ok: pullRes.ok, output: pullRes.output });
  });

  // Install dependencies on existing deployment
  app.post('/api/deployments/:id/install', async (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    if (!canManageDeployment(req, dep)) {
      res.status(403).json({ error: 'You do not have permission to install dependencies for this deployment.' });
      return;
    }
    const botDir = getBotDir(dep.id);
    if (!fs.existsSync(botDir)) {
      res.status(400).json({ error: 'Bot directory not found.' });
      return;
    }
    const resolved = resolveDeploymentCommands(botDir, dep.settings);
    const installCmd = resolved.installCommand || 'npm install --legacy-peer-deps --ignore-engines';
    appendLog(dep, 'info', 'install', `Executing: ${installCmd}`);
    const result = await runShellStep(
      installCmd,
      botDir,
      buildEnvMap(dep.settings.envVars),
      300000,
      (line) => appendLog(dep, 'info', 'install', line)
    );
    appendLog(
      dep,
      result.ok ? 'success' : 'error',
      'install',
      result.ok ? 'Dependencies installed cleanly.' : 'Dependency install failed.'
    );
    res.json({ ok: result.ok, output: result.output });
  });

  // Send stdin command to running deployment process
  app.post('/api/deployments/:id/terminal/input', (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    if (!canManageDeployment(req, dep)) {
      res.status(403).json({ error: 'You do not have permission to access this terminal.' });
      return;
    }
    const { text } = req.body as { text?: string };
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'Input text is required.' });
      return;
    }
    const ok = sendInput(dep.id, text);
    if (ok) {
      appendLog(dep, 'info', 'stdin', `> ${text}`);
    }
    res.json({ ok });
  });

  // Runtime lifecycle actions: start | stop | restart | redeploy
  app.post('/api/deployments/:id/action', async (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    if (!canManageDeployment(req, dep)) {
      res.status(403).json({ error: 'You do not have permission to control this deployment.' });
      return;
    }
    const { action } = req.body as { action?: 'start' | 'stop' | 'restart' | 'redeploy' };

    if (action === 'stop') {
      deployEngine.abort(dep.id);
      stopProcess(dep.id);
      dep.status = 'stopped';
      dep.desiredRunning = false;
      dep.pid = null;
      dep.cpuPercent = 0;
      dep.memoryMb = 0;
      dep.uptimeSeconds = 0;
      dep.gatewayLatencyMs = 0;
      dep.eventsPerMin = 0;
      dep.networkKbps = 0;
      appendLog(dep, 'warn', 'runtime', 'Bot process stopped by operator.');
    } else if (action === 'start') {
      if (dep.expiresAt && Date.parse(dep.expiresAt) <= Date.now()) {
        res.status(402).json({
          error: 'This deployment plan has expired. Renew or upgrade it before starting.',
        });
        return;
      }
      dep.desiredRunning = true;
      const botDir = getBotDir(dep.id);
      const hasNodeModulesOrPy =
        fs.existsSync(botDir) &&
        (!fs.existsSync(path.join(botDir, 'package.json')) || fs.existsSync(path.join(botDir, 'node_modules')));
      if (deployEngine.isPipelineActive(dep.id) || deployEngine.activeRestores.has(dep.id)) {
        res.json(dep);
        return;
      }
      if (!fs.existsSync(botDir) || !hasNodeModulesOrPy) {
        void deployEngine.deploy(dep);
      } else if (!isRunning(dep.id, dep.pid)) {
        try {
          await stopProcessAndWait(dep.id, dep.id, 1000);
          writeDotEnvFile(botDir, dep.settings.envVars, {
            assignedPort: getAssignedBotPort(dep.numericId),
          });
          const resolved = resolveDeploymentCommands(botDir, dep.settings);
          dep.settings.startCommand = resolved.startCommand;
          const bp = startProcess(dep.id, resolved.startCommand, {
            numericId: dep.numericId,
            restartPolicy: dep.settings.restartPolicy,
            memoryLimitMb: dep.memoryLimitMb,
            env: buildEnvMap(dep.settings.envVars),
          });
          const stability = await waitForProcessStability(dep.id, 1500);
          if (stability.alive) {
            dep.status = 'online';
            dep.desiredRunning = true;
            dep.pid = bp.pid;
            dep.uptimeSeconds = 1;
            appendLog(
              dep,
              'success',
              'runtime',
              `Started bot process (PID ${bp.pid}): ${resolved.startCommand}`
            );
          } else if (isAutoRestarting(dep.id)) {
            dep.status = 'building';
            dep.desiredRunning = true;
            dep.pid = null;
            appendLog(
              dep,
              'warn',
              'runtime',
              `Process exited right after start (code ${stability.exitCode ?? 'null'}); auto-restart scheduled.`
            );
          } else {
            dep.status = stability.exitCode === 0 || stability.exitCode === null ? 'stopped' : 'failed';
            dep.desiredRunning = false;
            dep.pid = null;
            appendLog(
              dep,
              dep.status === 'failed' ? 'error' : 'warn',
              'runtime',
              `Process exited right after start with code ${stability.exitCode ?? 'null'}.`
            );
          }
        } catch (err) {
          dep.status = 'failed';
          appendLog(
            dep,
            'error',
            'runtime',
            err instanceof Error ? err.message : 'Failed to start bot process.'
          );
        }
      }
    } else if (action === 'restart' || action === 'redeploy') {
      if (dep.expiresAt && Date.parse(dep.expiresAt) <= Date.now()) {
        res.status(402).json({
          error: 'This deployment plan has expired. Renew or upgrade it before restarting.',
        });
        return;
      }
      dep.desiredRunning = true;
      if (action === 'redeploy') {
        void deployEngine.deploy(dep);
      } else {
        deployEngine.abort(dep.id);
        await stopProcessAndWait(dep.id, dep.id, 1500);
        const botDir = getBotDir(dep.id);
        const hasNodeModulesOrPy =
          fs.existsSync(botDir) &&
          (!fs.existsSync(path.join(botDir, 'package.json')) || fs.existsSync(path.join(botDir, 'node_modules')));
        if (!fs.existsSync(botDir) || !hasNodeModulesOrPy) {
          void deployEngine.deploy(dep);
        } else {
          try {
            writeDotEnvFile(botDir, dep.settings.envVars, {
              assignedPort: getAssignedBotPort(dep.numericId),
            });
            const resolved = resolveDeploymentCommands(botDir, dep.settings);
            dep.settings.startCommand = resolved.startCommand;
            const bp = startProcess(dep.id, resolved.startCommand, {
              numericId: dep.numericId,
              restartPolicy: dep.settings.restartPolicy,
              memoryLimitMb: dep.memoryLimitMb,
              env: buildEnvMap(dep.settings.envVars),
            });
            const stability = await waitForProcessStability(dep.id, 1000);
            if (stability.alive) {
              dep.status = 'online';
              dep.desiredRunning = true;
              dep.pid = bp.pid;
              dep.uptimeSeconds = 1;
              appendLog(dep, 'info', 'runtime', `Restarted bot process (PID ${bp.pid}).`);
            } else if (isAutoRestarting(dep.id)) {
              dep.status = 'building';
              dep.desiredRunning = true;
              dep.pid = null;
              appendLog(
                dep,
                'warn',
                'runtime',
                `Process exited right after restart (code ${stability.exitCode ?? 'null'}); auto-restart scheduled.`
              );
            } else {
              dep.status = stability.exitCode === 0 || stability.exitCode === null ? 'stopped' : 'failed';
              dep.desiredRunning = false;
              dep.pid = null;
              appendLog(
                dep,
                dep.status === 'failed' ? 'error' : 'warn',
                'runtime',
                `Process exited right after restart with code ${stability.exitCode ?? 'null'}.`
              );
            }
          } catch (err) {
            dep.status = 'failed';
            appendLog(
              dep,
              'error',
              'runtime',
              err instanceof Error ? err.message : 'Failed to restart bot process.'
            );
          }
        }
      }
    } else {
      res.status(400).json({ error: 'Unsupported action.' });
      return;
    }

    saveState();
    broadcastDeployments();
    res.json(dep);
  });

  // Live responsiveness & OS/HTTP probe for deployment
  app.get('/api/deployments/:id/probe', async (req, res) => {
    const dep = state.deployments.find((d) => d.id === req.params.id);
    if (!dep || !canManageDeployment(req, dep)) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    const portEntry = dep.settings.envVars.find((v) => v.key === 'PORT' || v.key === 'WEB_PORT');
    const customPort = portEntry ? Number.parseInt(portEntry.value.trim(), 10) : null;
    const probe = await probeBotProcessHealth({
      botId: dep.id,
      numericId: dep.numericId,
      fallbackPid: dep.pid,
      customPort: Number.isInteger(customPort) ? customPort : null,
      healthCheckPath: dep.settings.healthCheckPath,
    });
    res.json({
      ...probe,
      status: dep.status,
      desiredRunning: Boolean(dep.desiredRunning),
      restartPolicy: dep.settings.restartPolicy,
      is24x7Protected: Boolean(dep.desiredRunning && dep.settings.restartPolicy !== 'never'),
    });
  });

  // Delete deployment and clean up cloned directory
  app.delete('/api/deployments/:id', (req, res) => {
    const idx = state.deployments.findIndex((d) => d.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Deployment not found.' });
      return;
    }
    if (!canManageDeployment(req, state.deployments[idx])) {
      res.status(403).json({ error: 'You do not have permission to delete this deployment.' });
      return;
    }
    const [removed] = state.deployments.splice(idx, 1);
    deployEngine.abort(removed.id);
    stopProcess(removed.id);
    const botDir = getBotDir(removed.id);
    if (fs.existsSync(botDir)) {
      safeRemoveDir(botDir);
    }
    deleteDeploymentFromDb(removed.id);
    saveState();
    broadcastDeployments();
    res.json({ deleted: true });
  });

  // Vite dev middleware or static dist serving
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // HTTP + WebSocket Server (/ws/bots/:id/terminal + proxied Node app WebSockets)
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '';
    const match = url.match(/\/ws\/bots\/([A-Za-z0-9_-]+)\/terminal/);
    if (match) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, match[1]);
      });
      return;
    }

    const proxyMatch = resolveDeploymentByProxyRequest(
      url,
      request.headers['x-forwarded-host'] || request.headers.host,
      state.deployments,
      getEffectiveWildcardDomain()
    );
    if (proxyMatch) {
      proxyWebSocketUpgrade(request, socket, head, proxyMatch);
    }
  });

  wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, rawBotKey: string) => {
    const num = Number(rawBotKey);
    const dep =
      Number.isInteger(num) && num > 0
        ? state.deployments.find((d) => d.numericId === num)
        : state.deployments.find((d) => d.id === rawBotKey);

    if (!dep) {
      ws.close(1008, 'Bot not found');
      return;
    }

    const existingProcess = getProcess(dep.id);
    if (existingProcess && existingProcess.logs.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: existingProcess.logs.join('') }));
    }

    const onOutput = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    };
    const onExit = (code: number | null) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code }));
      }
    };

    processEmitter.on(`output:${dep.id}`, onOutput);
    processEmitter.on(`exit:${dep.id}`, onExit);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; data?: string };
        if (msg.type === 'input' && typeof msg.data === 'string') {
          sendRawInput(dep.id, msg.data);
        }
      } catch {
        // ignore malformed ws frame
      }
    });

    ws.on('close', () => {
      processEmitter.off(`output:${dep.id}`, onOutput);
      processEmitter.off(`exit:${dep.id}`, onExit);
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Lyrihost server listening on http://0.0.0.0:${PORT}`);
    void deployEngine.restoreOnBoot();

    // Continuous 24/7 anti-sleep keepalive (every 30s): keeps PaaS ingress, host, and active bot HTTP servers warm
    const localKeepaliveUrl = `http://127.0.0.1:${PORT}/api/health`;
    const envExternal =
      process.env.APP_URL?.trim() ||
      process.env.PUBLIC_URL?.trim() ||
      process.env.RENDER_EXTERNAL_URL?.trim() ||
      (process.env.RAILWAY_STATIC_URL?.trim()
        ? `https://${process.env.RAILWAY_STATIC_URL.trim().replace(/^https?:\/\//i, '')}`
        : '') ||
      (process.env.RAILWAY_PUBLIC_DOMAIN?.trim()
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim().replace(/^https?:\/\//i, '')}`
        : '');

    setInterval(() => {
      const activeBots = state.deployments.filter((d) => d.status === 'online' || d.desiredRunning);
      if (activeBots.length === 0) return;

      fetch(localKeepaliveUrl, { method: 'GET', signal: AbortSignal.timeout(3000) }).catch(() => {});

      const externalTarget =
        (getEffectiveRailwayDomain().domain ? `https://${getEffectiveRailwayDomain().domain}` : '') ||
        envExternal ||
        learnedPublicOrigin;
      if (externalTarget && /^https?:\/\//i.test(externalTarget)) {
        const keepaliveUrl = `${externalTarget.replace(/\/+$/, '')}/api/health`;
        fetch(keepaliveUrl, { method: 'GET', signal: AbortSignal.timeout(5000) }).catch(() => {});
      }

      for (const dep of activeBots) {
        const portEntry = dep.settings.envVars.find((v) => v.key === 'PORT' || v.key === 'WEB_PORT');
        const envPort = portEntry ? Number.parseInt(portEntry.value.trim(), 10) : Number.NaN;
        const botPort =
          Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 && envPort !== PORT
            ? envPort
            : getAssignedBotPort(dep.numericId);
        if (botPort > 0 && botPort !== PORT) {
          const rawPath = (dep.settings.healthCheckPath || '/health').trim();
          const healthPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
          fetch(`http://127.0.0.1:${botPort}${healthPath}`, {
            method: 'GET',
            signal: AbortSignal.timeout(1500),
          }).catch(() => {});
        }
      }
    }, 30 * 1000).unref();
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});

const handleGracefulShutdown = (signal: string) => {
  console.log(`[server] Received ${signal}; flushing database and saving state...`);
  try {
    saveState();
    flushDbToDisk();
  } catch {
    // ignore shutdown flush failure
  }
  process.exit(0);
};

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
