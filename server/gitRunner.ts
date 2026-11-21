import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BotSettings, EnvVarEntry, RuntimeEnvironment } from '../src/types/lyrihost.ts';
import { safeRemoveDir } from './processManager.ts';

const GIT_HTTPS_REWRITE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=no -o BatchMode=yes',
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_0: 'ssh://git@github.com/',
  GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_1: 'git+ssh://git@github.com/',
  GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_2: 'git@github.com:',
  GIT_CONFIG_KEY_3: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_3: 'git://github.com/',
};

export function commandExists(bin: string): boolean {
  const clean = bin.trim();
  if (!clean || !/^[A-Za-z0-9_.-]+$/.test(clean)) return false;
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [clean], {
      stdio: 'ignore',
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

export function buildCloneUrl(gitUrl: string, gitToken?: string | null): string {
  const trimmed = gitUrl.trim();
  if (!gitToken) return trimmed;
  try {
    const u = new URL(trimmed);
    u.username = gitToken;
    u.password = '';
    return u.toString();
  } catch {
    return trimmed;
  }
}

export function sanitizeRepoUrl(input: string): string | null {
  let trimmed = input.trim();
  if (!trimmed) return null;

  // Support git+https:// or git+ssh:// wrappers
  if (/^git\+https?:\/\//i.test(trimmed)) {
    trimmed = trimmed.replace(/^git\+/i, '');
  }
  const sshMatch = trimmed.match(/^(?:git\+ssh:\/\/)?git@([^:/]+):(.+)$/i);
  if (sshMatch) {
    const host = sshMatch[1];
    const repoPath = sshMatch[2].replace(/^\/+/, '');
    trimmed = `https://${host}/${repoPath}`;
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed.replace(/\.git$/i, '')}.git`;
  }

  const normalized = /^github\.com\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  try {
    const u = new URL(normalized);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // Strip /tree/<branch> or /blob/<branch>/... if user pasted a browser URL
    if (u.hostname.toLowerCase().includes('github.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const repoPart = parts[1].replace(/\.git$/i, '');
        return `https://github.com/${parts[0]}/${repoPart}.git`;
      }
    }
    return u.toString();
  } catch {
    return null;
  }
}

function redactSecret(text: string, token?: string | null): string {
  if (!token) return text;
  return text.split(token).join('***');
}

function runGitClone(
  args: string[],
  signal?: AbortSignal,
  token?: string | null
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const safeArgs = ['-c', 'credential.helper=', '-c', 'core.askPass=', ...args];
    execFile(
      'git',
      safeArgs,
      {
        timeout: 150000,
        signal,
        env: {
          ...process.env,
          ...GIT_HTTPS_REWRITE_ENV,
        },
      },
      (err, stdout, stderr) => {
        const combined = redactSecret(`${stdout || ''}\n${stderr || ''}`.trim(), token);
        if (err) {
          resolve({ ok: false, output: combined || redactSecret(err.message, token) });
        } else {
          resolve({ ok: true, output: combined || 'Cloned successfully.' });
        }
      }
    );
  });
}

export async function cloneRepository(
  gitUrl: string,
  targetDir: string,
  options: { branch?: string; gitToken?: string | null; signal?: AbortSignal } = {}
): Promise<{ ok: boolean; output: string }> {
  const safeUrl = sanitizeRepoUrl(gitUrl) ?? gitUrl.trim();
  const cloneUrl = buildCloneUrl(safeUrl, options.gitToken);
  const parent = path.dirname(targetDir);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
  if (fs.existsSync(targetDir)) {
    safeRemoveDir(targetDir);
  }

  const branch =
    options.branch && /^[A-Za-z0-9_./-]+$/.test(options.branch) ? options.branch : undefined;
  const baseArgs = ['clone', '--depth', '1'];
  if (branch) {
    baseArgs.push('--branch', branch);
  }

  let res = await runGitClone([...baseArgs, cloneUrl, targetDir], options.signal, options.gitToken);

  // Retry automatically on transient network/TLS/HTTP2 stream hiccups with HTTP/1.1 + larger postBuffer
  const transientPattern =
    /timed out|RPC failed|Could not resolve host|Connection reset|HTTP 5\d\d|TLS|GnuTLS|HTTP\/2|early EOF|unexpected disconnect|Failed to connect|unable to access|index-pack failed|fetch-pack/i;
  if (!res.ok && !options.signal?.aborted && transientPattern.test(res.output)) {
    if (fs.existsSync(targetDir)) {
      safeRemoveDir(targetDir);
    }
    await new Promise((r) => setTimeout(r, 1500));
    res = await runGitClone(
      [
        '-c',
        'http.version=HTTP/1.1',
        '-c',
        'http.postBuffer=524288000',
        '-c',
        'http.lowSpeedLimit=1000',
        '-c',
        'http.lowSpeedTime=30',
        ...baseArgs,
        cloneUrl,
        targetDir,
      ],
      options.signal,
      options.gitToken
    );
  }

  // If specified branch wasn't found, fall back to the repository's default branch
  if (
    !res.ok &&
    branch &&
    /Remote branch .+ not found|Could not find remote branch|did not match any file\(s\) known to git/i.test(
      res.output
    )
  ) {
    if (fs.existsSync(targetDir)) {
      safeRemoveDir(targetDir);
    }
    res = await runGitClone(
      ['-c', 'http.version=HTTP/1.1', 'clone', '--depth', '1', cloneUrl, targetDir],
      options.signal,
      options.gitToken
    );
  }

  if (!res.ok) {
    if (/could not read Username|Authentication failed|Repository not found|terminal prompts disabled/i.test(res.output)) {
      return {
        ok: false,
        output: `Repository not found or requires GitHub access token (${safeUrl}). Verify owner/repo is public or configure a GitHub Token in Platform Settings.`,
      };
    }
  }

  return res;
}

export function pullRepository(
  botDir: string,
  gitToken?: string | null
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    if (!fs.existsSync(botDir)) {
      resolve({ ok: false, output: 'Bot directory not found.' });
      return;
    }
    const args = gitToken
      ? [
          '-C',
          botDir,
          '-c',
          'credential.helper=',
          '-c',
          'core.askPass=',
          '-c',
          `http.extraHeader=Authorization: Bearer ${gitToken}`,
          'pull',
        ]
      : ['-C', botDir, '-c', 'credential.helper=', '-c', 'core.askPass=', 'pull'];

    execFile(
      'git',
      args,
      {
        timeout: 60000,
        env: {
          ...process.env,
          ...GIT_HTTPS_REWRITE_ENV,
        },
      },
      (err, stdout, stderr) => {
        const output = redactSecret(`${stdout || ''}\n${stderr || ''}`.trim(), gitToken) || 'Already up to date.';
        resolve({ ok: !err, output });
      }
    );
  });
}

export function getRepoHeadInfo(botDir: string): Promise<{ commitSha: string; branch: string }> {
  return new Promise((resolve) => {
    if (!fs.existsSync(botDir)) {
      resolve({ commitSha: 'head', branch: 'main' });
      return;
    }
    execFile(
      'git',
      ['-C', botDir, 'rev-parse', '--short', 'HEAD'],
      { timeout: 5000 },
      (err1, shaOut) => {
        const commitSha = !err1 && shaOut.trim() ? shaOut.trim().slice(0, 12) : 'head';
        execFile(
          'git',
          ['-C', botDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
          { timeout: 5000 },
          (err2, branchOut) => {
            const branch =
              !err2 && branchOut.trim() && branchOut.trim() !== 'HEAD' ? branchOut.trim() : 'main';
            resolve({ commitSha, branch });
          }
        );
      }
    );
  });
}

export interface ResolvedBotCommands {
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  runtime: RuntimeEnvironment;
  notes: string[];
}

export function resolveDeploymentCommands(
  botDir: string,
  settings: Pick<BotSettings, 'installCommand' | 'buildCommand' | 'startCommand' | 'runtime'>
): ResolvedBotCommands {
  const notes: string[] = [];
  let installCommand = (settings.installCommand || '').trim();
  let buildCommand = (settings.buildCommand || '').trim();
  let startCommand = (settings.startCommand || '').trim() || 'npm start';
  let runtime: RuntimeEnvironment = settings.runtime || 'node-20';

  const pkgPath = path.join(botDir, 'package.json');
  const reqPath = path.join(botDir, 'requirements.txt');
  const pyprojPath = path.join(botDir, 'pyproject.toml');

  const hasPkg = fs.existsSync(pkgPath);
  const hasReq = fs.existsSync(reqPath);
  const hasPyproj = fs.existsSync(pyprojPath);
  const pyEntries = ['bot.py', 'main.py', 'app.py', 'run.py', 'src/bot.py', 'src/main.py'];
  const foundPyEntry =
    pyEntries.find((rel) => fs.existsSync(path.join(botDir, rel))) ||
    fs.readdirSync(botDir).find((f) => f.endsWith('.py'));

  // Normalize unavailable docker runtime when Node/Python project files exist
  if (runtime === 'docker' && !commandExists('docker')) {
    if (hasPkg) {
      runtime = 'node-20';
      notes.push('Docker daemon unavailable in worker sandbox; switching to native Node.js execution.');
    } else if (hasReq || hasPyproj || foundPyEntry) {
      runtime = 'python-3.12';
      notes.push('Docker daemon unavailable in worker sandbox; switching to Python 3 execution.');
    }
  }

  if (hasPkg) {
    let pkg: {
      main?: string;
      scripts?: Record<string, string>;
    } = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as typeof pkg;
    } catch {
      pkg = {};
    }

    // Adapt package managers not installed in runtime (e.g. pnpm/yarn/bun -> npm fallback)
    if (/^\s*pnpm\b/i.test(installCommand) && !commandExists('pnpm')) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
      notes.push('pnpm binary not present; adapted install command to npm.');
    } else if (/^\s*yarn\b/i.test(installCommand) && !commandExists('yarn')) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
      notes.push('yarn binary not present; adapted install command to npm.');
    } else if (/^\s*bun\b/i.test(installCommand) && !commandExists('bun')) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
      notes.push('bun binary not present; adapted install command to npm.');
    } else if (/^\s*npm\s+ci\b/i.test(installCommand) && !fs.existsSync(path.join(botDir, 'package-lock.json'))) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
      notes.push('package-lock.json missing; switched npm ci to npm install.');
    } else if (!installCommand && (pkg.scripts || fs.existsSync(pkgPath))) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
    }

    if (/^\s*pnpm\b/i.test(buildCommand) && !commandExists('pnpm')) {
      buildCommand = buildCommand.replace(/^\s*pnpm\b/i, 'npm run');
    } else if (/^\s*yarn\b/i.test(buildCommand) && !commandExists('yarn')) {
      buildCommand = buildCommand.replace(/^\s*yarn\b/i, 'npm run');
    } else if (/^\s*bun\b/i.test(buildCommand) && !commandExists('bun')) {
      buildCommand = buildCommand.replace(/^\s*bun\b/i, 'npm');
    }

    if (buildCommand.startsWith('docker ')) {
      buildCommand = pkg.scripts?.build ? 'npm run build' : '';
    }

    // Resolve start command when `package.json` has no `scripts.start` or uses missing runtime binary
    const isDefaultStart =
      /^(npm\s+start|npm\s+run\s+start|yarn\s+start|pnpm\s+start|bun\s+run\s+start|docker\s+run)/i.test(
        startCommand
      );

    if (isDefaultStart && (!pkg.scripts || !pkg.scripts.start)) {
      const nodeCandidates = [
        pkg.main,
        'index.js',
        'bot.js',
        'main.js',
        'app.js',
        'server.js',
        'src/index.js',
        'src/bot.js',
      ].filter((c): c is string => Boolean(c));

      const matchedEntry = nodeCandidates.find((rel) => fs.existsSync(path.join(botDir, rel)));
      if (matchedEntry) {
        startCommand = `node ${JSON.stringify(matchedEntry)}`;
        notes.push(`package.json has no "start" script; auto-selected entrypoint ${matchedEntry}.`);
      }
    } else if (/^\s*bun\s+(run\s+)?start\b/i.test(startCommand) && !commandExists('bun')) {
      startCommand = 'npm start';
      notes.push('bun binary not present; adapted start command to npm start.');
    } else if (/^\s*yarn\s+start\b/i.test(startCommand) && !commandExists('yarn')) {
      startCommand = 'npm start';
    } else if (/^\s*pnpm\s+start\b/i.test(startCommand) && !commandExists('pnpm')) {
      startCommand = 'npm start';
    }
  } else if (hasReq || hasPyproj || foundPyEntry) {
    runtime = 'python-3.12';
    const pyBin = commandExists('python3') ? 'python3' : 'python';

    if (!installCommand || /^\s*(npm|yarn|pnpm|bun)\b/i.test(installCommand)) {
      if (hasReq) {
        installCommand = `${pyBin} -m pip install --break-system-packages -r requirements.txt || pip3 install --break-system-packages -r requirements.txt`;
        notes.push('Detected Python repository; adapted install command to pip requirements.txt.');
      } else {
        installCommand = '';
      }
    }

    if (buildCommand.startsWith('npm') || buildCommand.startsWith('docker')) {
      buildCommand = '';
    }

    if (/^\s*(npm|yarn|pnpm|bun|docker)\b/i.test(startCommand) && foundPyEntry) {
      startCommand = `${pyBin} ${JSON.stringify(foundPyEntry)}`;
      notes.push(`Detected Python entrypoint (${foundPyEntry}); adapted start command.`);
    }
  }

  // Ensure `python` works even if only `python3` is in PATH
  if (/^\s*python\s+/i.test(startCommand) && !commandExists('python') && commandExists('python3')) {
    startCommand = startCommand.replace(/^\s*python\s+/i, 'python3 ');
  }
  if (/^\s*pip\s+/i.test(installCommand) && !commandExists('pip') && commandExists('pip3')) {
    installCommand = installCommand.replace(/^\s*pip\s+/i, 'pip3 ');
  }

  return { installCommand, buildCommand, startCommand, runtime, notes };
}

export function runShellStep(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 300000,
  onLine?: (line: string) => void,
  signal?: AbortSignal
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, output: 'Aborted by operator.' });
      return;
    }

    const child = spawn(command, {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        npm_config_production: 'false',
        ...GIT_HTTPS_REWRITE_ENV,
        npm_config_yes: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_prefer_offline: 'false',
        PUPPETEER_SKIP_DOWNLOAD: 'true',
        SHARP_IGNORE_GLOBAL_LIBVIPS: '1',
        PYTHONUNBUFFERED: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        ...env,
      },
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let full = '';
    let lineBuffer = '';

    const killChildGroup = () => {
      const pid = child.pid;
      if (!pid) return;
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGTERM');
          return;
        } catch {
          // fallback
        }
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    };

    const onAbort = () => {
      killChildGroup();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      killChildGroup();
    }, timeoutMs);

    const handleChunk = (buf: Buffer) => {
      const str = buf.toString();
      full += str;
      if (full.length > 32000) {
        full = full.slice(-32000);
      }
      if (onLine) {
        lineBuffer += str;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const clean = line.trim();
          if (clean) onLine(clean);
        }
      }
    };

    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', handleChunk);

    child.on('exit', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (onLine && lineBuffer.trim()) {
        onLine(lineBuffer.trim());
      }
      resolve({ ok: code === 0, output: full.trim() });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ok: false, output: `${full}\n${err.message}`.trim() });
    });
  });
}

export function buildEnvMap(envVars: EnvVarEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of envVars) {
    const key = entry.key.trim();
    if (!key) continue;
    if (entry.value === '••••••••••••••••••••') continue;
    map[key] = entry.value;
  }

  // Sync Session aliases across templates (SESSION_ID <-> SESSION)
  if (map.SESSION_ID && !map.SESSION) {
    map.SESSION = map.SESSION_ID;
  } else if (map.SESSION && !map.SESSION_ID) {
    map.SESSION_ID = map.SESSION;
  }

  // Sync Prefix aliases across templates (PREFIX <-> BOT_PREFIX <-> PREFIXES)
  const effectivePrefix = map.PREFIX || map.BOT_PREFIX || map.PREFIXES || '';
  if (effectivePrefix) {
    if (!map.PREFIX) map.PREFIX = effectivePrefix;
    if (!map.BOT_PREFIX) map.BOT_PREFIX = effectivePrefix;
    if (!map.PREFIXES) map.PREFIXES = effectivePrefix;
  }

  // Sync Owner aliases across templates (OWNER_NUMBER <-> DEV)
  if (map.OWNER_NUMBER && !map.DEV) {
    map.DEV = map.OWNER_NUMBER;
  } else if (map.DEV && !map.OWNER_NUMBER) {
    map.OWNER_NUMBER = map.DEV;
  }

  // Sync Bot Mode aliases across templates (MODE <-> BOT_MODE <-> WORK_TYPE <-> WORKTYPE)
  const effectiveMode = map.MODE || map.BOT_MODE || map.WORK_TYPE || map.WORKTYPE || '';
  if (effectiveMode) {
    if (!map.MODE) map.MODE = effectiveMode;
    if (!map.BOT_MODE) map.BOT_MODE = effectiveMode;
    if (!map.WORK_TYPE) map.WORK_TYPE = effectiveMode;
    if (!map.WORKTYPE) map.WORKTYPE = effectiveMode;
  }

  return map;
}

function mergeEnvFile(filePath: string, map: Record<string, string>): void {
  const merged: Record<string, string> = {};
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    for (const rawLine of existing.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k) merged[k] = v;
    }
  }
  for (const [k, v] of Object.entries(map)) {
    if (v !== '') {
      merged[k] = JSON.stringify(v);
    } else if (!(k in merged)) {
      merged[k] = '""';
    }
  }
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  if (lines.length > 0) {
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  }
}

export function writeDotEnvFile(botDir: string, envVars: EnvVarEntry[]): void {
  const map = buildEnvMap(envVars);
  const lines = Object.entries(map).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  if (lines.length > 0) {
    fs.writeFileSync(path.join(botDir, '.env'), lines.join('\n') + '\n', 'utf-8');
  }

  // Sync repos that load set.env (e.g. Keith) or config.env explicitly
  for (const altEnv of ['set.env', 'config.env']) {
    const altPath = path.join(botDir, altEnv);
    if (fs.existsSync(altPath) && lines.length > 0) {
      mergeEnvFile(altPath, map);
    }
  }

  // Sync ELITE-PRO-V1 local database settings/owner JSON when present
  if (fs.existsSync(path.join(botDir, 'ElitePro.js'))) {
    try {
      const dbDir = path.join(botDir, 'database');
      fs.mkdirSync(dbDir, { recursive: true });
      const settingsPath = path.join(dbDir, 'settings.json');
      let currentSettings: Record<string, unknown> = {};
      if (fs.existsSync(settingsPath)) {
        try {
          currentSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
        } catch {
          currentSettings = {};
        }
      }
      if (map.MODE) {
        currentSettings.mode = map.MODE.toLowerCase();
      } else if (!currentSettings.mode) {
        currentSettings.mode = 'public';
      }
      if (map.PREFIX) {
        currentSettings.prefix = map.PREFIX;
      }
      fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2) + '\n', 'utf-8');

      if (map.OWNER_NUMBER) {
        const ownerPath = path.join(dbDir, 'owner.json');
        let owners: string[] = [];
        if (fs.existsSync(ownerPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf-8'));
            if (Array.isArray(parsed)) owners = parsed.map(String);
          } catch {
            owners = [];
          }
        }
        const digits = map.OWNER_NUMBER.replace(/\D/g, '');
        if (digits && !owners.includes(digits)) {
          owners.push(digits);
          fs.writeFileSync(ownerPath, JSON.stringify(owners, null, 2) + '\n', 'utf-8');
        }
      }
    } catch {
      // ignore non-critical JSON sync error
    }
  }
}

