import fs from 'node:fs';
import path from 'node:path';
import { getDeploymentPlan, getMeta, getUserById } from './db.ts';
import { sendDeploymentSuccessEmail } from './emailService.ts';
import {
  buildEnvMap,
  cloneRepository,
  getRepoHeadInfo,
  resolveDeploymentCommands,
  runShellStep,
  writeDotEnvFile,
} from './gitRunner.ts';
import {
  ensureBotsDir,
  getAssignedBotPort,
  getBotDir,
  isAutoRestarting,
  isRunning,
  killAllOrphanedBotProcesses,
  startProcess,
  stopProcess,
  stopProcessAndWait,
  waitForProcessStability,
} from './processManager.ts';
import { nowIso, pushDeploymentLog, type PersistedState } from './stateStore.ts';
import type { BotDeployment, ComputeTier, LogEntry } from '../src/types/lyrihost.ts';

const TIER_MEMORY_MB: Record<ComputeTier, number> = {
  nano: 256,
  standard: 512,
  pro: 1024,
  cluster: 2048,
};

const PERSISTENT_DATA_DIRS = [
  'database',
  'data',
  'db',
  'storage',
  'sessions',
  'auth',
  'auth_info',
  '.wwebjs_auth',
] as const;
const ROOT_DATA_FILE_RE =
  /^(?:store\.json|database\.json|baileys_store\.json)$/i;
const ROOT_DB_EXT_RE =
  /\.(?:db|db-wal|db-shm|sqlite|sqlite3|sqlite-wal|sqlite-shm)$/i;

export interface DeployEngineContext {
  getState: () => PersistedState;
  saveState: () => void;
  broadcast: () => void;
}

export class BotDeploymentEngine {
  private readonly aborts = new Map<string, AbortController>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly pendingEmail = new Map<string, { startCmd: string; envCount: number }>();
  public readonly activeRestores = new Set<string>();
  private readonly ctx: DeployEngineContext;

  constructor(ctx: DeployEngineContext) {
    this.ctx = ctx;
  }

  private appendLog(
    dep: BotDeployment,
    level: LogEntry['level'],
    stage: string,
    message: string
  ): void {
    pushDeploymentLog(dep, level, stage, message);
    this.ctx.saveState();
    this.ctx.broadcast();
  }

  public isPipelineActive(botId: string): boolean {
    return this.aborts.has(botId) || this.inFlight.has(botId);
  }

  public abort(botId: string): void {
    this.pendingEmail.delete(botId);
    const existing = this.aborts.get(botId);
    if (existing) {
      existing.abort();
      this.aborts.delete(botId);
    }
  }

  public onAutoRestarted(botId: string, pid: number): void {
    const state = this.ctx.getState();
    const target = state.deployments.find((d) => d.id === botId);
    if (!target) return;

    target.status = 'online';
    target.desiredRunning = true;
    target.pid = pid;
    target.uptimeSeconds = 1;
    pushDeploymentLog(target, 'info', 'runtime', `Auto-restarted bot process (PID ${pid}).`);

    const pending = this.pendingEmail.get(botId);
    if (pending) {
      this.pendingEmail.delete(botId);
      this.notifyDeployer(target, pending.startCmd, pid, pending.envCount);
    }

    this.ctx.saveState();
    this.ctx.broadcast();
  }

  private notifyDeployer(
    dep: BotDeployment,
    startCmd: string,
    pid: number,
    envVarCount: number
  ): void {
    const recipientEmail =
      dep.ownerEmail?.trim() ||
      (dep.ownerUserId ? getUserById(dep.ownerUserId)?.email?.trim() : '') ||
      '';
    if (!recipientEmail || !recipientEmail.includes('@')) {
      return;
    }

    let planName = dep.planId || dep.settings.computeTier.toUpperCase();
    try {
      planName = getDeploymentPlan(dep.planId || 'plan_15d').name;
    } catch {
      // keep fallback label
    }

    const rawDashboard =
      process.env.APP_URL?.trim() ||
      process.env.PUBLIC_URL?.trim() ||
      process.env.RENDER_EXTERNAL_URL?.trim() ||
      (process.env.RAILWAY_STATIC_URL?.trim()
        ? `https://${process.env.RAILWAY_STATIC_URL.trim().replace(/^https?:\/\//i, '')}`
        : '') ||
      (process.env.RAILWAY_PUBLIC_DOMAIN?.trim()
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim().replace(/^https?:\/\//i, '')}`
        : '') ||
      getMeta('public_keepalive_origin') ||
      '';

    const dashboardUrl = /^https?:\/\//i.test(rawDashboard) ? rawDashboard : null;

    void sendDeploymentSuccessEmail({
      toEmail: recipientEmail,
      botName: dep.name,
      deploymentId: dep.id,
      repoFullName: dep.repoFullName,
      branch: dep.settings.branch,
      commitSha: dep.commitSha,
      platform: dep.platform,
      framework: dep.framework,
      runtime: dep.settings.runtime,
      region: dep.settings.region,
      computeTier: dep.settings.computeTier,
      memoryLimitMb: dep.memoryLimitMb,
      planName,
      expiresAt: dep.expiresAt,
      startCommand: startCmd,
      pid,
      envVarCount,
      deployedAt: dep.lastDeployedAt || nowIso(),
      dashboardUrl,
    })
      .then((result) => {
        if (!this.ctx.getState().deployments.some((d) => d.id === dep.id)) return;
        if (result.ok) {
          this.appendLog(dep, 'info', 'notify', `Deployment details sent to ${recipientEmail}.`);
        } else {
          this.appendLog(
            dep,
            'warn',
            'notify',
            `Deployment email skipped: ${result.error || 'Email transport unavailable.'}`
          );
        }
      })
      .catch(() => {
        // non-fatal notification error
      });
  }

  private backupPersistentBotData(
    dep: BotDeployment,
    botDir: string,
    envMap: Record<string, string>
  ): { backupDir: string | null; itemCount: number } {
    if (!fs.existsSync(botDir)) return { backupDir: null, itemCount: 0 };

    const candidateDir = path.join(path.dirname(botDir), `.tmp_data_${dep.id}_${Date.now()}`);
    let backupDir: string | null = null;
    let itemCount = 0;

    const ensureBackupDir = () => {
      if (!backupDir) {
        fs.mkdirSync(candidateDir, { recursive: true });
        backupDir = candidateDir;
      }
    };

    for (const dirName of PERSISTENT_DATA_DIRS) {
      const srcDir = path.join(botDir, dirName);
      if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
        ensureBackupDir();
        fs.cpSync(srcDir, path.join(candidateDir, dirName), {
          recursive: true,
          filter: (srcPath) => !/\.(?:js|ts|mjs|cjs|map)$/i.test(srcPath),
        });
        itemCount++;
      }
    }

    if (dep.platform === 'whatsapp' && !envMap.SESSION_ID && !envMap.SESSION) {
      for (const candidate of ['session', 'auth_info_baileys']) {
        const candidatePath = path.join(botDir, candidate);
        if (fs.existsSync(path.join(candidatePath, 'creds.json'))) {
          ensureBackupDir();
          fs.cpSync(candidatePath, path.join(candidateDir, candidate), { recursive: true });
          itemCount++;
        }
      }
      const sessionTxt = path.join(botDir, 'session_id.txt');
      if (fs.existsSync(sessionTxt) && fs.statSync(sessionTxt).isFile()) {
        ensureBackupDir();
        fs.copyFileSync(sessionTxt, path.join(candidateDir, 'session_id.txt'));
        itemCount++;
      }
    }

    try {
      const rootEntries = fs.readdirSync(botDir, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (!entry.isFile()) continue;
        if (ROOT_DATA_FILE_RE.test(entry.name) || ROOT_DB_EXT_RE.test(entry.name)) {
          ensureBackupDir();
          fs.copyFileSync(path.join(botDir, entry.name), path.join(candidateDir, entry.name));
          itemCount++;
        }
      }
    } catch {
      // ignore non-fatal root scan failure
    }

    return { backupDir, itemCount };
  }

  public async deploy(dep: BotDeployment): Promise<void> {
    const prevRun = this.inFlight.get(dep.id);
    this.abort(dep.id);

    const controller = new AbortController();
    this.aborts.set(dep.id, controller);

    const runPromise = (async () => {
      if (prevRun) {
        await Promise.race([
          prevRun.catch(() => undefined),
          new Promise<void>((r) => setTimeout(r, 3000)),
        ]);
        if (controller.signal.aborted) return;
      }

      const state = this.ctx.getState();
      ensureBotsDir();
      dep.status = 'building';
      dep.pid = null;
      dep.cpuPercent = 0;
      dep.memoryMb = 0;
      dep.uptimeSeconds = 0;
      dep.gatewayLatencyMs = 0;
      dep.eventsPerMin = 0;
      dep.networkKbps = 0;
      dep.healthScore = 0;
      dep.memoryLimitMb = TIER_MEMORY_MB[dep.settings.computeTier] || 512;
      this.ctx.saveState();
      this.ctx.broadcast();

      const botDir = getBotDir(dep.id);
      const envMap = buildEnvMap(dep.settings.envVars);
      const effectiveToken =
        dep.gitToken || state.githubToken || process.env.GITHUB_TOKEN || undefined;

      const isAborted = () => {
        if (controller.signal.aborted) return true;
        const current = this.ctx.getState().deployments.find((d) => d.id === dep.id);
        return !current || current.status === 'stopped';
      };

      let backupDir: string | null = null;
      let restoredItems = 0;

      try {
        // 1. Stop previous bot process cleanly
        await stopProcessAndWait(dep.id, dep.id, 1500);
        if (isAborted()) return;

        this.appendLog(
          dep,
          'info',
          'init',
          `Starting deployment pipeline for ${dep.repoFullName} (branch: ${dep.settings.branch}, region: ${dep.settings.region})`
        );

        // 2. Preserve existing bot DB/session files before fresh clone
        const backup = this.backupPersistentBotData(dep, botDir, envMap);
        backupDir = backup.backupDir;
        restoredItems = backup.itemCount;

        // 3. Clone repository cleanly via Git
        const cloneRes = await cloneRepository(dep.repoUrl, botDir, {
          branch: dep.settings.branch,
          gitToken: effectiveToken,
          signal: controller.signal,
        });
        if (isAborted()) return;

        if (!cloneRes.ok) {
          dep.status = 'failed';
          this.appendLog(dep, 'error', 'clone', `Git clone failed: ${cloneRes.output.slice(-500)}`);
          return;
        }

        if (backupDir && fs.existsSync(backupDir) && restoredItems > 0) {
          try {
            fs.cpSync(backupDir, botDir, { recursive: true, force: true });
            this.appendLog(
              dep,
              'info',
              'clone',
              `Restored ${restoredItems} persistent storage/session item(s).`
            );
          } catch {
            // non-fatal restore failure
          }
        }

        const headInfo = await getRepoHeadInfo(botDir);
        dep.commitSha = headInfo.commitSha;
        dep.settings.branch = headInfo.branch;
        this.appendLog(
          dep,
          'success',
          'clone',
          `Cloned ${dep.repoFullName} (${headInfo.branch} @ ${headInfo.commitSha}) into bot_${dep.id}`
        );

        const assignedPort = getAssignedBotPort(dep.numericId);

        // 4. Write environment files (.env / set.env / config.env / session_id.txt / JSON configs)
        writeDotEnvFile(botDir, dep.settings.envVars, { assignedPort });
        this.appendLog(
          dep,
          'info',
          'scan',
          `Injected ${Object.keys(envMap).length} environment variable(s).`
        );

        // 5. Resolve documented runtime, install, build, and start commands
        const resolved = resolveDeploymentCommands(botDir, dep.settings);
        for (const note of resolved.notes) {
          this.appendLog(dep, 'info', 'config', note);
        }
        dep.settings.runtime = resolved.runtime;
        dep.settings.installCommand = resolved.installCommand;
        dep.settings.buildCommand = resolved.buildCommand;
        dep.settings.startCommand = resolved.startCommand;

        // 6. Install dependencies cleanly
        const installCmd = resolved.installCommand.trim();
        if (installCmd) {
          this.appendLog(dep, 'info', 'install', `Executing: ${installCmd}`);
          let installRes = await runShellStep(
            installCmd,
            botDir,
            envMap,
            480000,
            (line) => this.appendLog(dep, 'info', 'install', line),
            controller.signal
          );
          if (isAborted()) return;

          if (!installRes.ok && /\b(npm|yarn|pnpm|bun)\b/i.test(installCmd) && fs.existsSync(path.join(botDir, 'package.json'))) {
            if (!/npm\s+install.*--legacy-peer-deps/i.test(installCmd)) {
              const fallbackCmd =
                'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
              this.appendLog(
                dep,
                'warn',
                'install',
                `Retrying install cleanly: ${fallbackCmd}`
              );
              installRes = await runShellStep(
                fallbackCmd,
                botDir,
                envMap,
                480000,
                (line) => this.appendLog(dep, 'info', 'install', line),
                controller.signal
              );
              if (isAborted()) return;
            }
          }

          if (!installRes.ok) {
            dep.status = 'failed';
            this.appendLog(
              dep,
              'error',
              'install',
              `Install failed (${installCmd}): ${installRes.output.slice(-500)}`
            );
            return;
          }
          this.appendLog(dep, 'success', 'install', 'Dependencies installed cleanly.');
        }

        // 7. Build step (when configured)
        const buildCmd = resolved.buildCommand.trim();
        if (buildCmd) {
          this.appendLog(dep, 'info', 'build', `Executing: ${buildCmd}`);
          const buildRes = await runShellStep(
            buildCmd,
            botDir,
            envMap,
            300000,
            (line) => this.appendLog(dep, 'info', 'build', line),
            controller.signal
          );
          if (isAborted()) return;
          if (!buildRes.ok) {
            dep.status = 'failed';
            this.appendLog(
              dep,
              'error',
              'build',
              `Build failed (${buildCmd}): ${buildRes.output.slice(-500)}`
            );
            return;
          }
          this.appendLog(dep, 'success', 'build', 'Build completed cleanly.');
        }

        // Re-sync .env right before launch
        writeDotEnvFile(botDir, dep.settings.envVars, { assignedPort });

        // 8. Run prestart hook cleanly when startCommand launches node directly without npm start
        const startCmd = resolved.startCommand.trim() || 'npm start';
        if (!/^(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?start\b/i.test(startCmd)) {
          const pkgPath = path.join(botDir, 'package.json');
          if (fs.existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
                scripts?: Record<string, string>;
              };
              if (pkg.scripts?.prestart) {
                this.appendLog(dep, 'info', 'build', `Executing prestart: ${pkg.scripts.prestart}`);
                await runShellStep(
                  'npm run prestart',
                  botDir,
                  envMap,
                  120000,
                  (line) => this.appendLog(dep, 'info', 'build', line),
                  controller.signal
                );
                if (isAborted()) return;
              }
            } catch {
              // ignore prestart check error
            }
          }
        }

        // 9. Start standard supervised child process
        this.appendLog(dep, 'info', 'runtime', `Launching process: ${startCmd}`);
        const bp = startProcess(dep.id, startCmd, {
          numericId: dep.numericId,
          restartPolicy: dep.settings.restartPolicy,
          memoryLimitMb: dep.memoryLimitMb,
          env: envMap,
        });

        const stability = await waitForProcessStability(dep.id, 2600);
        if (isAborted()) {
          stopProcess(dep.id);
          return;
        }

        if (stability.alive) {
          this.pendingEmail.delete(dep.id);
          dep.status = 'online';
          dep.desiredRunning = true;
          dep.pid = bp.pid;
          dep.lastDeployedAt = nowIso();
          dep.uptimeSeconds = 2;
          this.appendLog(dep, 'success', 'runtime', `Bot process online (PID ${bp.pid}): ${startCmd}`);
          this.notifyDeployer(dep, startCmd, bp.pid, Object.keys(envMap).length);
        } else if (isAutoRestarting(dep.id)) {
          this.pendingEmail.set(dep.id, {
            startCmd,
            envCount: Object.keys(envMap).length,
          });
          dep.status = 'building';
          dep.desiredRunning = true;
          dep.pid = null;
          this.appendLog(
            dep,
            'warn',
            'runtime',
            `Process exited after launch (code ${stability.exitCode ?? 'null'}); scheduling restart...`
          );
        } else {
          this.pendingEmail.delete(dep.id);
          dep.status = stability.exitCode === 0 || stability.exitCode === null ? 'stopped' : 'failed';
          dep.desiredRunning = false;
          dep.pid = null;
          this.appendLog(
            dep,
            dep.status === 'failed' ? 'error' : 'warn',
            'runtime',
            `Bot exited after startup with code ${stability.exitCode ?? 'null'}. Review console output above.`
          );
        }
      } catch (err) {
        if (!isAborted()) {
          dep.status = 'failed';
          this.appendLog(
            dep,
            'error',
            'runtime',
            `Deployment error: ${err instanceof Error ? err.message : 'Unknown error'}`
          );
        }
      } finally {
        if (backupDir && fs.existsSync(backupDir)) {
          try {
            fs.rmSync(backupDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup failure
          }
        }
        const isLatest = this.aborts.get(dep.id) === controller;
        if (isLatest) {
          this.aborts.delete(dep.id);
          this.ctx.saveState();
          this.ctx.broadcast();
        }
      }
    })();

    this.inFlight.set(dep.id, runPromise);
    try {
      await runPromise;
    } finally {
      if (this.inFlight.get(dep.id) === runPromise) {
        this.inFlight.delete(dep.id);
      }
    }
  }

  public async restoreOnBoot(): Promise<void> {
    try {
      ensureBotsDir();
      killAllOrphanedBotProcesses();
      const state = this.ctx.getState();
      if (!state.deployments.length) return;

      const resumeIds = new Set<string>();
      for (const dep of state.deployments) {
        const wasActive = dep.status === 'online' || dep.desiredRunning === true;
        const notExpired = !dep.expiresAt || Date.parse(dep.expiresAt) > Date.now();
        if (wasActive && notExpired && dep.settings.restartPolicy !== 'never') {
          resumeIds.add(dep.id);
          this.activeRestores.add(dep.id);
          dep.status = 'building';
          dep.pid = null;
        } else if (
          dep.status === 'building' ||
          dep.status === 'scanning' ||
          (dep.status === 'online' && !isRunning(dep.id, dep.pid))
        ) {
          dep.status = 'stopped';
          dep.pid = null;
          dep.cpuPercent = 0;
          dep.memoryMb = 0;
          dep.uptimeSeconds = 0;
        }
      }
      this.ctx.saveState();
      this.ctx.broadcast();

      for (const dep of state.deployments) {
        try {
          const botDir = getBotDir(dep.id);
          const needsClone = !fs.existsSync(botDir);
          const needsNodeInstall =
            fs.existsSync(botDir) &&
            fs.existsSync(path.join(botDir, 'package.json')) &&
            !fs.existsSync(path.join(botDir, 'node_modules'));

          if (needsClone) {
            const token = dep.gitToken || state.githubToken || process.env.GITHUB_TOKEN || undefined;
            const cloneRes = await cloneRepository(dep.repoUrl, botDir, {
              branch: dep.settings.branch,
              gitToken: token,
            });
            if (cloneRes.ok) {
              writeDotEnvFile(botDir, dep.settings.envVars, {
                assignedPort: getAssignedBotPort(dep.numericId),
              });
              const resolved = resolveDeploymentCommands(botDir, dep.settings);
              dep.settings.installCommand = resolved.installCommand;
              dep.settings.buildCommand = resolved.buildCommand;
              dep.settings.startCommand = resolved.startCommand;
              dep.settings.runtime = resolved.runtime;
              if (resolved.installCommand) {
                await runShellStep(resolved.installCommand, botDir, buildEnvMap(dep.settings.envVars), 480000);
              }
              if (resolved.buildCommand) {
                await runShellStep(resolved.buildCommand, botDir, buildEnvMap(dep.settings.envVars), 300000);
              }
            }
          } else if (needsNodeInstall && resumeIds.has(dep.id)) {
            const resolved = resolveDeploymentCommands(botDir, dep.settings);
            if (resolved.installCommand) {
              await runShellStep(resolved.installCommand, botDir, buildEnvMap(dep.settings.envVars), 480000);
            }
            if (resolved.buildCommand) {
              await runShellStep(resolved.buildCommand, botDir, buildEnvMap(dep.settings.envVars), 300000);
            }
          }

          if (resumeIds.has(dep.id) && fs.existsSync(botDir)) {
            try {
              writeDotEnvFile(botDir, dep.settings.envVars, {
                assignedPort: getAssignedBotPort(dep.numericId),
              });
              const resolved = resolveDeploymentCommands(botDir, dep.settings);
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
                pushDeploymentLog(dep, 'info', 'runtime', `Restored bot process after server boot (PID ${bp.pid}).`);
              } else if (!isAutoRestarting(dep.id)) {
                dep.status = 'stopped';
                dep.pid = null;
              }
            } catch (err) {
              dep.status = 'failed';
              dep.pid = null;
              pushDeploymentLog(
                dep,
                'error',
                'runtime',
                `Auto-restore failed on boot: ${err instanceof Error ? err.message : 'Unknown error'}`
              );
            }
          }
        } finally {
          this.activeRestores.delete(dep.id);
        }
      }
      this.ctx.saveState();
      this.ctx.broadcast();
    } catch (err) {
      this.activeRestores.clear();
      console.error('Startup bot restore error:', err);
    }
  }
}
