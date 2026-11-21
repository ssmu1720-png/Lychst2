import { Router, type IRouter } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import {
  ensureBotsDir,
  getBotDir,
  getLogs,
  isAutoRestarting,
  isRunning,
  safeRemoveDir,
  sendInput,
  startProcess,
  stopProcess,
  waitForProcessStability,
} from './processManager.ts';
import {
  buildEnvMap,
  cloneRepository,
  pullRepository,
  resolveDeploymentCommands,
  runShellStep,
  sanitizeRepoUrl,
  writeDotEnvFile,
} from './gitRunner.ts';
import {
  buildEmptyTelemetryHistory,
  makeId,
  nowIso,
  pushDeploymentLog,
  type PersistedState,
} from './stateStore.ts';
import type { BotDeployment } from '../src/types/lyrihost.ts';

type ApiBotStatus = 'stopped' | 'starting' | 'running' | 'error';

const CreateBotBody = z.object({
  name: z.string().min(1),
  gitUrl: z.string().min(1),
  command: z.string().min(1),
  autoRestart: z.boolean().optional().default(true),
  gitToken: z.string().optional(),
  installCommand: z.string().optional(),
});

const UpdateBotBody = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  gitUrl: z.string().min(1).optional(),
  autoRestart: z.boolean().optional(),
  gitToken: z.string().optional(),
  installCommand: z.string().optional(),
});

const SendTerminalInputBody = z.object({
  text: z.string(),
});

function mapDeploymentStatusToBotStatus(status: BotDeployment['status']): ApiBotStatus {
  if (status === 'online') return 'running';
  if (status === 'building' || status === 'scanning') return 'starting';
  if (status === 'failed') return 'error';
  return 'stopped';
}

export function formatBotResponse(dep: BotDeployment) {
  return {
    id: dep.numericId ?? 0,
    deploymentId: dep.id,
    name: dep.name,
    gitUrl: dep.repoUrl,
    command: dep.settings.startCommand,
    status: mapDeploymentStatusToBotStatus(dep.status),
    pid: dep.pid ?? null,
    autoRestart: dep.settings.restartPolicy !== 'never',
    gitToken: dep.gitToken ?? null,
    installCommand: dep.settings.installCommand || null,
    createdAt: dep.createdAt,
    updatedAt: dep.updatedAt,
  };
}

function findDeploymentByParam(state: PersistedState, rawId: string): BotDeployment | undefined {
  const num = Number(rawId);
  if (Number.isInteger(num) && num > 0) {
    const byNum = state.deployments.find((d) => d.numericId === num);
    if (byNum) return byNum;
  }
  return state.deployments.find((d) => d.id === rawId);
}

export function createBotsRouter(
  getState: () => PersistedState,
  saveState: () => void,
  broadcast: () => void
): IRouter {
  const router: IRouter = Router();

  // Healthcheck matching wh-panel-site
  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // System runtime info
  router.get('/system/info', (_req, res) => {
    res.json({
      nodeVersion: process.version,
      platform: process.platform,
    });
  });

  // List bots (1s in-memory cache matching wh-panel-site)
  let botsCache: { data: ReturnType<typeof formatBotResponse>[]; ts: number } | null = null;
  const invalidateCache = () => {
    botsCache = null;
  };

  router.get('/bots', (_req, res) => {
    const state = getState();
    if (botsCache && Date.now() - botsCache.ts < 1000) {
      res.setHeader('Cache-Control', 'no-store');
      res.json(botsCache.data);
      return;
    }

    let changed = false;
    for (const dep of state.deployments) {
      if (!isRunning(dep.id, dep.pid) && (dep.status === 'online' || dep.status === 'building')) {
        dep.status = 'stopped';
        dep.pid = null;
        changed = true;
      }
    }
    if (changed) saveState();

    const data = state.deployments
      .slice()
      .sort((a, b) => (a.numericId ?? 0) - (b.numericId ?? 0))
      .map(formatBotResponse);
    botsCache = { data, ts: Date.now() };
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  });

  // Create bot & clone repository into bot_instances/
  router.post('/bots', async (req, res) => {
    try {
      const body = CreateBotBody.parse(req.body);
      const state = getState();
      ensureBotsDir();

      const safeUrl = sanitizeRepoUrl(body.gitUrl);
      if (!safeUrl) {
        res.status(400).json({ error: 'Invalid git repository URL.' });
        return;
      }

      const repoFullName = safeUrl
        .replace(/^https?:\/\/github\.com\//i, '')
        .replace(/\.git$/i, '');

      const ts = nowIso();
      const numericId = state.nextNumericId++;
      const dep: BotDeployment = {
        id: makeId('bot'),
        numericId,
        pid: null,
        gitToken: body.gitToken ?? null,
        name: body.name.trim(),
        repoUrl: safeUrl.replace(/\.git$/i, ''),
        repoFullName,
        platform: 'custom',
        framework: 'Node.js Bot',
        status: 'building',
        commitSha: 'head',
        createdAt: ts,
        updatedAt: ts,
        lastDeployedAt: ts,
        uptimeSeconds: 0,
        cpuPercent: 0,
        memoryMb: 0,
        memoryLimitMb: 512,
        gatewayLatencyMs: 0,
        eventsPerMin: 0,
        networkKbps: 0,
        onlineChecks: 0,
        totalChecks: 0,
        uptimePercentage: 0,
        healthScore: 0,
        telemetryHistory: buildEmptyTelemetryHistory(),
        settings: {
          name: body.name.trim(),
          branch: 'main',
          region: state.preferences.defaultRegion,
          runtime: 'node-20',
          installCommand: body.installCommand || 'npm install --legacy-peer-deps',
          buildCommand: '',
          startCommand: body.command.trim(),
          computeTier: 'standard',
          restartPolicy: body.autoRestart ? 'always' : 'never',
          autoDeploy: false,
          healthCheckPath: '/health',
          envVars: [],
        },
        scanReport: null,
        logs: [],
      };

      state.deployments.unshift(dep);
      invalidateCache();
      saveState();
      broadcast();

      res.status(201).json(formatBotResponse(dep));

      // Clone repository asynchronously just like wh-panel-site
      const botDir = getBotDir(dep.id);
      const effectiveToken = body.gitToken || state.githubToken || undefined;
      const cloneResult = await cloneRepository(safeUrl, botDir, { gitToken: effectiveToken });
      // Ensure bot wasn't deleted while cloning
      if (!state.deployments.some((d) => d.id === dep.id)) return;
      if (cloneResult.ok) {
        dep.status = 'stopped';
        pushDeploymentLog(dep, 'success', 'clone', `Cloned repository ${repoFullName} into bot_${dep.id}`);
      } else {
        dep.status = 'failed';
        pushDeploymentLog(dep, 'error', 'clone', `Git clone failed: ${cloneResult.output}`);
      }
      invalidateCache();
      saveState();
      broadcast();
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid input' });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get single bot
  router.get('/bots/:id', (req, res) => {
    const state = getState();
    const dep = findDeploymentByParam(state, req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    if (!isRunning(dep.id, dep.pid) && (dep.status === 'online' || dep.status === 'building')) {
      dep.status = 'stopped';
      dep.pid = null;
      saveState();
    }
    res.json(formatBotResponse(dep));
  });

  // Update bot settings
  router.patch('/bots/:id', (req, res) => {
    try {
      const body = UpdateBotBody.parse(req.body);
      const state = getState();
      const dep = findDeploymentByParam(state, req.params.id);
      if (!dep) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      if (body.name !== undefined) {
        dep.name = body.name.trim();
        dep.settings.name = body.name.trim();
      }
      if (body.command !== undefined) {
        dep.settings.startCommand = body.command.trim();
      }
      if (body.gitUrl !== undefined) {
        const safeUrl = sanitizeRepoUrl(body.gitUrl);
        if (!safeUrl) {
          res.status(400).json({ error: 'Invalid git repository URL.' });
          return;
        }
        dep.repoUrl = safeUrl.replace(/\.git$/i, '');
      }
      if (body.autoRestart !== undefined) {
        dep.settings.restartPolicy = body.autoRestart ? 'always' : 'never';
      }
      if (body.gitToken !== undefined) {
        dep.gitToken = body.gitToken;
      }
      if (body.installCommand !== undefined) {
        dep.settings.installCommand = body.installCommand;
      }
      dep.updatedAt = nowIso();
      invalidateCache();
      saveState();
      broadcast();
      res.json(formatBotResponse(dep));
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid input' });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete bot & remove bot directory
  router.delete('/bots/:id', (req, res) => {
    const state = getState();
    const dep = findDeploymentByParam(state, req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    if (isRunning(dep.id, dep.pid)) {
      stopProcess(dep.id);
    }
    const botDir = getBotDir(dep.id);
    if (fs.existsSync(botDir)) {
      safeRemoveDir(botDir);
    }

    state.deployments = state.deployments.filter((d) => d.id !== dep.id);
    invalidateCache();
    saveState();
    broadcast();
    res.status(204).send();
  });

  // Start bot process
  router.post('/bots/:id/start', async (req, res) => {
    const state = getState();
    const dep = findDeploymentByParam(state, req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    if (isRunning(dep.id, dep.pid)) {
      res.json(formatBotResponse(dep));
      return;
    }
    const botDir = getBotDir(dep.id);
    if (!fs.existsSync(botDir)) {
      res.status(400).json({ error: 'Bot directory not found. Clone the repository first.' });
      return;
    }

    try {
      writeDotEnvFile(botDir, dep.settings.envVars);
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
        dep.pid = bp.pid;
        dep.uptimeSeconds = 1;
        dep.lastDeployedAt = nowIso();
        pushDeploymentLog(dep, 'success', 'runtime', `Started process (PID ${bp.pid}): ${resolved.startCommand}`);
      } else if (isAutoRestarting(dep.id)) {
        dep.status = 'building';
        dep.pid = null;
        pushDeploymentLog(dep, 'warn', 'runtime', `Process exited right after start (code ${stability.exitCode ?? 'null'}); auto-restart scheduled.`);
      } else {
        dep.status = stability.exitCode === 0 || stability.exitCode === null ? 'stopped' : 'failed';
        dep.pid = null;
        pushDeploymentLog(dep, dep.status === 'failed' ? 'error' : 'warn', 'runtime', `Process exited with code ${stability.exitCode ?? 'null'}.`);
      }
      invalidateCache();
      saveState();
      broadcast();
      res.json(formatBotResponse(dep));
    } catch (err) {
      dep.status = 'failed';
      pushDeploymentLog(dep, 'error', 'runtime', err instanceof Error ? err.message : 'Failed to start process');
      saveState();
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start bot' });
    }
  });

  // Stop bot process
  router.post('/bots/:id/stop', (req, res) => {
    const state = getState();
    const dep = findDeploymentByParam(state, req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    stopProcess(dep.id);
    dep.status = 'stopped';
    dep.pid = null;
    dep.cpuPercent = 0;
    dep.memoryMb = 0;
    dep.uptimeSeconds = 0;
    pushDeploymentLog(dep, 'warn', 'runtime', 'Bot process stopped by API request.');
    invalidateCache();
    saveState();
    broadcast();
    res.json(formatBotResponse(dep));
  });

  // Restart bot process
  router.post('/bots/:id/restart', async (req, res) => {
    const state = getState();
    const dep = findDeploymentByParam(state, req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    stopProcess(dep.id);
    await new Promise((r) => setTimeout(r, 500));

    const botDir = getBotDir(dep.id);
    if (!fs.existsSync(botDir)) {
      res.status(400).json({ error: 'Bot directory not found.' });
      return;
    }

    try {
      writeDotEnvFile(botDir, dep.settings.envVars);
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
        dep.pid = bp.pid;
        dep.uptimeSeconds = 1;
        pushDeploymentLog(dep, 'info', 'runtime', `Restarted process (PID ${bp.pid})`);
      } else if (isAutoRestarting(dep.id)) {
        dep.status = 'building';
        dep.pid = null;
        pushDeploymentLog(dep, 'warn', 'runtime', `Restart exited (code ${stability.exitCode ?? 'null'}); auto-restart scheduled.`);
      } else {
        dep.status = stability.exitCode === 0 || stability.exitCode === null ? 'stopped' : 'failed';
        dep.pid = null;
        pushDeploymentLog(dep, dep.status === 'failed' ? 'error' : 'warn', 'runtime', `Restart exited with code ${stability.exitCode ?? 'null'}.`);
      }
      invalidateCache();
      saveState();
      broadcast();
      res.json(formatBotResponse(dep));
    } catch (err) {
      dep.status = 'failed';
      pushDeploymentLog(dep, 'error', 'runtime', err instanceof Error ? err.message : 'Restart failed');
      saveState();
      res.status(500).json({ error: 'Failed to restart bot' });
    }
  });

  // Install bot dependencies
  router.post('/bots/:id/install', async (req, res) => {
    const state = getState();
    const dep = findDeploymentByParam(state, req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    const botDir = getBotDir(dep.id);
    if (!fs.existsSync(botDir)) {
      res.status(400).json({ error: 'Bot directory not found.' });
      return;
    }

    const resolved = resolveDeploymentCommands(botDir, dep.settings);
    const installCmd = resolved.installCommand || 'npm install --legacy-peer-deps --ignore-engines';

    let result = await runShellStep(installCmd, botDir, buildEnvMap(dep.settings.envVars));
    if (!result.ok && /\b(npm|yarn|pnpm|bun)\b/i.test(installCmd) && fs.existsSync(`${botDir}/package.json`)) {
      result = await runShellStep(
        'npm install --legacy-peer-deps --ignore-engines --ignore-scripts --no-audit --no-fund',
        botDir,
        buildEnvMap(dep.settings.envVars)
      );
    }
    const output = result.output || 'Done.';
    pushDeploymentLog(dep, result.ok ? 'success' : 'error', 'install', output.slice(-600));
    saveState();
    broadcast();
    res.json({ output });
  });

  // Git pull latest changes
  router.post('/bots/:id/pull', async (req, res) => {
    const state = getState();
    const dep = findDeploymentByParam(state, req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    const botDir = getBotDir(dep.id);
    if (!fs.existsSync(botDir)) {
      res.status(400).json({ error: 'Repository not cloned yet.' });
      return;
    }

    const token = dep.gitToken || state.githubToken || undefined;
    const result = await pullRepository(botDir, token);
    pushDeploymentLog(dep, result.ok ? 'info' : 'error', 'pull', result.output.slice(-600));
    saveState();
    broadcast();
    res.json({ output: result.output });
  });

  // Send input to bot stdin
  router.post('/bots/:id/terminal/input', (req, res) => {
    try {
      const body = SendTerminalInputBody.parse(req.body);
      const state = getState();
      const dep = findDeploymentByParam(state, req.params.id);
      if (!dep) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      const ok = sendInput(dep.id, body.text);
      if (ok) {
        pushDeploymentLog(dep, 'info', 'stdin', `> ${body.text}`);
        saveState();
        broadcast();
      }
      res.json({ ok });
    } catch {
      res.status(400).json({ error: 'Invalid input' });
    }
  });

  // Get live stdout/stderr buffer logs
  router.get('/bots/:id/logs', (req, res) => {
    const state = getState();
    const dep = findDeploymentByParam(state, req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    const live = getLogs(dep.id);
    const logs = live || dep.logs.map((l) => `[${l.timestamp}] [${l.stage.toUpperCase()}] ${l.message}`).join('\n');
    res.json({ logs });
  });

  return router;
}
