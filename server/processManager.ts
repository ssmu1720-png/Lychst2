import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const BOTS_DIR = process.env.BOTS_DIR
  ? path.resolve(process.env.BOTS_DIR)
  : process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH), 'bot_instances')
    : path.join(process.cwd(), 'bot_instances');

export interface BotProcess {
  pid: number;
  botId: string;
  numericId?: number;
  startedAt: number;
  lastOutputAt: number;
  command: string;
  process: ChildProcess;
  logs: string[];
}

export const processEmitter = new EventEmitter();
processEmitter.setMaxListeners(100);

const runningProcesses = new Map<string, BotProcess>();
const restartingIds = new Set<string>();
const restartTimers = new Map<string, NodeJS.Timeout>();
const intentionallyStopped = new Set<string>();
const consecutiveFailures = new Map<string, number>();
const lastOutputAtMap = new Map<string, number>();
const MAX_LOG_LINES = 500;
const STABLE_UPTIME_RESET_MS = 45000;

type DbRestartCallback = (botId: string, pid: number) => Promise<void> | void;
type ProcessExitCallback = (botId: string, code: number | null) => Promise<void> | void;

let _dbRestartCallback: DbRestartCallback | null = null;
let _processExitCallback: ProcessExitCallback | null = null;

export function setDbRestartCallback(cb: DbRestartCallback): void {
  _dbRestartCallback = cb;
}

export function setProcessExitCallback(cb: ProcessExitCallback): void {
  _processExitCallback = cb;
}

export function getBotsRootDir(): string {
  return BOTS_DIR;
}

export function getBotDir(botKey: string | number): string {
  const safeKey = String(botKey).replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(BOTS_DIR, `bot_${safeKey}`);
}

export function ensureBotsDir(): void {
  if (!fs.existsSync(BOTS_DIR)) {
    fs.mkdirSync(BOTS_DIR, { recursive: true });
  }
}

export function getProcess(botId: string): BotProcess | undefined {
  return runningProcesses.get(botId);
}

export function isAutoRestarting(botId: string): boolean {
  return restartingIds.has(botId) || restartTimers.has(botId);
}

export function getLastOutputAt(botId: string): number | null {
  return lastOutputAtMap.get(botId) ?? runningProcesses.get(botId)?.lastOutputAt ?? null;
}

export function getConsecutiveFailures(botId: string): number {
  return consecutiveFailures.get(botId) ?? 0;
}

export function getAssignedBotPort(numericId?: number | null): number {
  return 10000 + (numericId && numericId > 0 ? numericId : 1);
}

export function isRunning(botId: string, fallbackPid?: number | null): boolean {
  const bp = runningProcesses.get(botId);
  if (bp && bp.pid > 0) {
    try {
      process.kill(bp.pid, 0);
      if (process.platform === 'linux' && fs.existsSync(`/proc/${bp.pid}/stat`)) {
        const stat = fs.readFileSync(`/proc/${bp.pid}/stat`, 'utf-8');
        const rparen = stat.lastIndexOf(')');
        if (rparen !== -1) {
          const stateChar = stat.slice(rparen + 2, rparen + 3);
          if (stateChar === 'Z') {
            runningProcesses.delete(botId);
            return false;
          }
        }
      }
      return true;
    } catch {
      runningProcesses.delete(botId);
      return false;
    }
  }
  if (fallbackPid && fallbackPid > 0) {
    try {
      process.kill(fallbackPid, 0);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function getLogs(botId: string): string {
  const bp = runningProcesses.get(botId);
  if (!bp) return '';
  return bp.logs.join('');
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1B(?:\[[0-9;]*[mGKHFJ]|\][^\x07]*\x07|[()][A-Z0-9])/g, '');
}

export interface StartProcessOptions {
  dirKey?: string | number;
  numericId?: number;
  autoRestart?: boolean;
  restartPolicy?: 'always' | 'on-failure' | 'never';
  memoryLimitMb?: number;
  env?: Record<string, string>;
}

function clearPendingRestartTimer(botId: string): void {
  const existing = restartTimers.get(botId);
  if (existing) {
    clearTimeout(existing);
    restartTimers.delete(botId);
  }
  restartingIds.delete(botId);
}

function computeRestartDelayMs(failureCount: number): number {
  const schedule = [1000, 2500, 5000, 12000, 25000, 45000];
  const idx = Math.max(0, Math.min(schedule.length - 1, failureCount - 1));
  return schedule[idx];
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 0) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fallback to direct PID if group kill fails
    }
  }
  process.kill(pid, signal);
}

export function killProcessesInDirectory(targetDir: string): void {
  const resolvedTarget = path.resolve(targetDir);

  for (const [id, bp] of runningProcesses.entries()) {
    const bpDir = path.resolve(getBotDir(id));
    if (bpDir === resolvedTarget || bpDir.startsWith(resolvedTarget + path.sep)) {
      stopProcess(id);
      if (bp.pid > 0) {
        try {
          killProcessGroup(bp.pid, 'SIGKILL');
        } catch {
          // already exited
        }
      }
    }
  }

  if (process.platform !== 'linux' || !fs.existsSync('/proc')) return;

  try {
    const entries = fs.readdirSync('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid <= 1 || pid === process.pid) continue;
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd === resolvedTarget || cwd.startsWith(resolvedTarget + path.sep)) {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        // ignore unreadable proc entries or exited processes
      }
    }
  } catch {
    // ignore /proc scan failure
  }
}

export function killAllOrphanedBotProcesses(): void {
  if (!fs.existsSync(BOTS_DIR)) return;
  const rootDir = path.resolve(BOTS_DIR);
  const activePids = new Set<number>(Array.from(runningProcesses.values()).map((bp) => bp.pid));

  if (process.platform !== 'linux' || !fs.existsSync('/proc')) return;

  try {
    const entries = fs.readdirSync('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid <= 1 || pid === process.pid || activePids.has(pid)) continue;
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd === rootDir || cwd.startsWith(rootDir + path.sep)) {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

export function safeRemoveDir(targetDir: string): void {
  if (!fs.existsSync(targetDir)) return;
  killProcessesInDirectory(targetDir);
  try {
    fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch {
    // Second pass after killing any lingering descriptors
    killProcessesInDirectory(targetDir);
    fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function waitForProcessStability(
  botId: string,
  durationMs = 1200
): Promise<{ alive: boolean; exitCode: number | null }> {
  return new Promise((resolve) => {
    const bp = runningProcesses.get(botId);
    if (!bp) {
      resolve({ alive: false, exitCode: 1 });
      return;
    }

    let settled = false;
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ alive: false, exitCode: code });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      processEmitter.off(`exit:${botId}`, onExit);
      resolve({ alive: isRunning(botId, bp.pid), exitCode: null });
    }, durationMs);

    processEmitter.once(`exit:${botId}`, onExit);
  });
}

export async function stopProcessAndWait(
  botId: string,
  dirKey?: string | number,
  timeoutMs = 1500
): Promise<void> {
  const existing = runningProcesses.get(botId);
  const hadPid = existing?.pid;
  stopProcess(botId);
  if (hadPid && hadPid > 0) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        processEmitter.off(`exit:${botId}`, done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      processEmitter.once(`exit:${botId}`, done);
    });
  }
  const botDir = getBotDir(dirKey ?? botId);
  if (fs.existsSync(botDir)) {
    killProcessesInDirectory(botDir);
  }
}

export function startProcess(
  botId: string,
  command: string,
  options: StartProcessOptions = {}
): BotProcess {
  const dirKey = options.dirKey ?? botId;
  const botDir = getBotDir(dirKey);
  if (!fs.existsSync(botDir)) {
    throw new Error(`Bot directory not found: ${botDir}`);
  }

  const trimmedCmd = command.trim();
  if (!trimmedCmd) {
    throw new Error('Start command is empty.');
  }

  if (runningProcesses.has(botId)) {
    stopProcess(botId);
  }
  killProcessesInDirectory(botDir);
  intentionallyStopped.delete(botId);
  clearPendingRestartTimer(botId);

  const heapLimitMb = Math.max(768, Math.min(2048, options.memoryLimitMb || 768));
  const hookPath = path.resolve(process.cwd(), 'server', 'lyrihostBotHook.cjs');
  const nodeOptions = fs.existsSync(hookPath)
    ? `--require ${JSON.stringify(hookPath)} --max-old-space-size=${heapLimitMb}`
    : `--max-old-space-size=${heapLimitMb}`;

  const hostPort = String(process.env.PORT || 3000);
  const parentEnv: NodeJS.ProcessEnv = { ...process.env };
  delete parentEnv.PORT;

  const assignedPort = String(getAssignedBotPort(options.numericId));
  const child = spawn(trimmedCmd, {
    cwd: botDir,
    env: {
      ...parentEnv,
      PORT: assignedPort,
      LYRIHOST_HOST_PORT: hostPort,
      ...(options.env || {}),
      NODE_ENV: 'production',
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
      NODE_OPTIONS: nodeOptions,
      NODE_NO_WARNINGS: '1',
      PYTHONUNBUFFERED: '1',
      UV_THREADPOOL_SIZE: '16',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
  });

  const startedAt = Date.now();
  const bp: BotProcess = {
    pid: child.pid ?? 0,
    botId,
    numericId: options.numericId,
    startedAt,
    lastOutputAt: startedAt,
    command: trimmedCmd,
    process: child,
    logs: [],
  };

  runningProcesses.set(botId, bp);
  lastOutputAtMap.set(botId, startedAt);

  const emitOutput = (data: Buffer) => {
    const text = stripAnsi(data.toString());
    const now = Date.now();
    bp.lastOutputAt = now;
    lastOutputAtMap.set(botId, now);
    bp.logs.push(text);
    if (bp.logs.length > MAX_LOG_LINES) {
      bp.logs = bp.logs.slice(-MAX_LOG_LINES);
    }
    processEmitter.emit('output', { botId, chunk: text });
    processEmitter.emit(`output:${botId}`, text);
    if (options.numericId !== undefined) {
      processEmitter.emit(`output:${options.numericId}`, text);
    }
  };

  child.stdout?.on('data', emitOutput);
  child.stderr?.on('data', emitOutput);

  const effectivePolicy =
    options.restartPolicy ?? (options.autoRestart === false ? 'never' : 'always');

  child.on('exit', (code) => {
    const current = runningProcesses.get(botId);
    if (current && current.process !== child) {
      return;
    }

    const wasManualStop = intentionallyStopped.has(botId);
    intentionallyStopped.delete(botId);
    runningProcesses.delete(botId);

    processEmitter.emit(`exit:${botId}`, code);
    if (options.numericId !== undefined) {
      processEmitter.emit(`exit:${options.numericId}`, code);
    }

    if (wasManualStop) {
      consecutiveFailures.delete(botId);
      clearPendingRestartTimer(botId);
      return;
    }

    const aliveMs = Date.now() - bp.startedAt;
    if (aliveMs >= STABLE_UPTIME_RESET_MS) {
      consecutiveFailures.delete(botId);
    }

    const shouldRestart =
      effectivePolicy === 'always' ||
      (effectivePolicy === 'on-failure' && code !== 0 && code !== null);

    if (shouldRestart) {
      const nextFailures = (consecutiveFailures.get(botId) ?? 0) + 1;
      consecutiveFailures.set(botId, nextFailures);

      // For 'on-failure', pause after 6 consecutive rapid crashes; for 'always' (24/7 mode), keep recovering with bounded backoff
      if (effectivePolicy === 'on-failure' && nextFailures > 6) {
        consecutiveFailures.delete(botId);
        emitOutput(
          Buffer.from(
            `\r\n[RUNTIME] Crash loop detected (${nextFailures - 1} rapid exits, last exit code ${code ?? 'null'}). Auto-restart paused; inspect logs above.\r\n`
          )
        );
        if (_processExitCallback) {
          void _processExitCallback(botId, code === 0 ? 1 : code);
        }
        return;
      }

      const delayMs = computeRestartDelayMs(nextFailures);
      emitOutput(
        Buffer.from(
          `\r\n[SUPERVISOR] Bot exited (code ${code ?? 'null'}) after ${Math.round(aliveMs / 1000)}s. 24/7 recovery scheduled in ${Math.round(delayMs / 1000)}s (attempt #${nextFailures})...\r\n`
        )
      );

      restartingIds.add(botId);
      const timer = setTimeout(async () => {
        restartTimers.delete(botId);
        restartingIds.delete(botId);
        if (runningProcesses.has(botId) || intentionallyStopped.has(botId)) return;
        try {
          const restarted = startProcess(botId, trimmedCmd, options);
          if (_dbRestartCallback && restarted.pid) {
            await _dbRestartCallback(botId, restarted.pid);
          }
        } catch (err) {
          console.error(`[processManager] Auto-restart failed for ${botId}:`, err);
          if (_processExitCallback) {
            void _processExitCallback(botId, code);
          }
        }
      }, delayMs);
      restartTimers.set(botId, timer);
      return;
    }

    consecutiveFailures.delete(botId);
    if (_processExitCallback) {
      void _processExitCallback(botId, code);
    }
  });

  child.on('error', (err) => {
    const current = runningProcesses.get(botId);
    if (current && current.process !== child) {
      return;
    }
    intentionallyStopped.delete(botId);
    clearPendingRestartTimer(botId);
    emitOutput(Buffer.from(`\r\n[ERROR] ${err.message}\r\n`));
    runningProcesses.delete(botId);
    processEmitter.emit(`exit:${botId}`, 1);
    if (options.numericId !== undefined) {
      processEmitter.emit(`exit:${options.numericId}`, 1);
    }
    if (_processExitCallback) {
      void _processExitCallback(botId, 1);
    }
  });

  return bp;
}

export function stopProcess(botId: string): boolean {
  intentionallyStopped.add(botId);
  clearPendingRestartTimer(botId);
  consecutiveFailures.delete(botId);

  const bp = runningProcesses.get(botId);
  if (!bp) return false;

  const targetPid = bp.pid;
  runningProcesses.delete(botId);

  try {
    killProcessGroup(targetPid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(targetPid, 0);
        killProcessGroup(targetPid, 'SIGKILL');
      } catch {
        // already exited
      }
    }, 4000);
    return true;
  } catch {
    return false;
  }
}

export function sendInput(botId: string, text: string): boolean {
  const bp = runningProcesses.get(botId);
  if (!bp || !bp.process.stdin) return false;
  try {
    bp.process.stdin.write(text + '\n');
    return true;
  } catch {
    return false;
  }
}

export function sendRawInput(botId: string, rawData: string): boolean {
  const bp = runningProcesses.get(botId);
  if (!bp || !bp.process.stdin) return false;
  try {
    bp.process.stdin.write(rawData);
    return true;
  } catch {
    return false;
  }
}

const statsCache = new Map<number, { value: { cpuPercent: number; memoryMb: number } | null; expiresAt: number }>();

export function sampleProcessStats(
  pid: number,
  options: { bypassCache?: boolean } = {}
): Promise<{ cpuPercent: number; memoryMb: number } | null> {
  return new Promise((resolve) => {
    if (!pid || pid <= 0) {
      resolve(null);
      return;
    }
    const now = Date.now();
    if (!options.bypassCache) {
      const cached = statsCache.get(pid);
      if (cached && cached.expiresAt > now) {
        resolve(cached.value);
        return;
      }
    }
    const args =
      process.platform === 'linux'
        ? ['--no-headers', '-o', '%cpu=,rss=', '-g', String(pid)]
        : ['-p', String(pid), '-o', '%cpu=,rss='];

    execFile('ps', args, { timeout: 1000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        // Fallback to single PID query if process group query returns empty
        execFile('ps', ['-p', String(pid), '-o', '%cpu=,rss='], { timeout: 1000 }, (err2, out2) => {
          if (err2 || !out2.trim()) {
            statsCache.set(pid, { value: null, expiresAt: Date.now() + 4500 });
            resolve(null);
            return;
          }
          const parsed = parsePsOutput(out2);
          statsCache.set(pid, { value: parsed, expiresAt: Date.now() + 4500 });
          resolve(parsed);
        });
        return;
      }
      const parsed = parsePsOutput(stdout);
      statsCache.set(pid, { value: parsed, expiresAt: Date.now() + 4500 });
      resolve(parsed);
    });
  });
}

function parsePsOutput(output: string): { cpuPercent: number; memoryMb: number } {
  let totalCpu = 0;
  let totalRssKb = 0;
  for (const rawLine of output.trim().split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    const cpu = Number.parseFloat(parts[0] || '0');
    const rss = Number.parseInt(parts[1] || '0', 10);
    if (Number.isFinite(cpu)) totalCpu += cpu;
    if (Number.isFinite(rss)) totalRssKb += rss;
  }
  return {
    cpuPercent: Number(totalCpu.toFixed(1)),
    memoryMb: Math.round(totalRssKb / 1024),
  };
}

export interface BotProbeResult {
  botId: string;
  processAlive: boolean;
  pid: number | null;
  osState: string | null;
  autoRestarting: boolean;
  consecutiveFailures: number;
  uptimeMs: number;
  lastOutputAt: string | null;
  cpuPercent: number;
  memoryMb: number;
  httpProbe: {
    checkedPort: number;
    listening: boolean;
    statusCode: number | null;
    latencyMs: number | null;
  };
  responsive: boolean;
}

export async function probeBotProcessHealth(params: {
  botId: string;
  numericId?: number | null;
  fallbackPid?: number | null;
  customPort?: number | null;
  healthCheckPath?: string;
}): Promise<BotProbeResult> {
  const bp = runningProcesses.get(params.botId);
  const alive = isRunning(params.botId, params.fallbackPid);
  const activePid = bp?.pid ?? params.fallbackPid ?? null;
  let osState: string | null = null;

  if (alive && activePid && process.platform === 'linux' && fs.existsSync(`/proc/${activePid}/stat`)) {
    try {
      const stat = fs.readFileSync(`/proc/${activePid}/stat`, 'utf-8');
      const rparen = stat.lastIndexOf(')');
      if (rparen !== -1) {
        osState = stat.slice(rparen + 2, rparen + 3) || null;
      }
    } catch {
      osState = null;
    }
  }

  const stats = alive && activePid ? await sampleProcessStats(activePid, { bypassCache: true }) : null;
  const candidatePort =
    params.customPort && params.customPort > 0 && params.customPort <= 65535
      ? params.customPort
      : getAssignedBotPort(params.numericId);

  const rawPath = (params.healthCheckPath || '/health').trim();
  const healthPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

  let listening = false;
  let statusCode: number | null = null;
  let httpLatencyMs: number | null = null;

  if (alive && candidatePort > 0) {
    const start = performance.now();
    try {
      const resp = await fetch(`http://127.0.0.1:${candidatePort}${healthPath}`, {
        method: 'GET',
        signal: AbortSignal.timeout(800),
      });
      listening = true;
      statusCode = resp.status;
      httpLatencyMs = Math.max(1, Math.round(performance.now() - start));
    } catch {
      listening = false;
    }
  }

  const lastOut = getLastOutputAt(params.botId);
  const uptimeMs = bp && alive ? Math.max(0, Date.now() - bp.startedAt) : 0;

  return {
    botId: params.botId,
    processAlive: alive,
    pid: alive ? activePid : null,
    osState,
    autoRestarting: isAutoRestarting(params.botId),
    consecutiveFailures: getConsecutiveFailures(params.botId),
    uptimeMs,
    lastOutputAt: lastOut ? new Date(lastOut).toISOString() : null,
    cpuPercent: stats?.cpuPercent ?? 0,
    memoryMb: stats?.memoryMb ?? 0,
    httpProbe: {
      checkedPort: candidatePort,
      listening,
      statusCode,
      latencyMs: httpLatencyMs,
    },
    responsive: alive && osState !== 'Z',
  };
}
