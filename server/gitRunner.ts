import crypto from 'node:crypto';
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

function parseProcfileStartCommand(botDir: string): string | null {
  const procfilePath = path.join(botDir, 'Procfile');
  if (!fs.existsSync(procfilePath)) return null;
  try {
    const lines = fs.readFileSync(procfilePath, 'utf-8').split(/\r?\n/);
    let workerCmd: string | null = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const webMatch = line.match(/^web\s*:\s*(.+)$/i);
      if (webMatch && webMatch[1].trim()) {
        return webMatch[1].trim();
      }
      const workMatch = line.match(/^worker\s*:\s*(.+)$/i);
      if (workMatch && workMatch[1].trim() && !workerCmd) {
        workerCmd = workMatch[1].trim();
      }
    }
    return workerCmd;
  } catch {
    return null;
  }
}

function parseEcosystemTarget(botDir: string, fileName: string): { script: string; nodeArgs?: string } | null {
  const ecoPath = path.join(botDir, fileName);
  if (!fs.existsSync(ecoPath)) return null;
  try {
    const raw = fs.readFileSync(ecoPath, 'utf-8');
    const scriptMatch = raw.match(/script\s*:\s*['"`]([^'"`]+)['"`]/);
    if (!scriptMatch || !scriptMatch[1]) return null;
    const argsMatch = raw.match(/node_args\s*:\s*['"`]([^'"`]+)['"`]/);
    return {
      script: scriptMatch[1].trim(),
      nodeArgs: argsMatch?.[1]?.trim() || undefined,
    };
  } catch {
    return null;
  }
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
  const procfileCmd = parseProcfileStartCommand(botDir);

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
      engines?: { node?: string };
      scripts?: Record<string, string>;
    } = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as typeof pkg;
    } catch {
      pkg = {};
    }

    if (
      (pkg.engines?.node && /(?:>=?\s*22|\b22\b)/i.test(pkg.engines.node)) ||
      /--experimental-sqlite/i.test(pkg.scripts?.start || '')
    ) {
      runtime = 'node-22';
    }

    // Adapt package managers not installed in runtime or brittle frozen/ci commands
    if (/^\s*pnpm\b/i.test(installCommand) && !commandExists('pnpm')) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
      notes.push('pnpm binary not present; adapted install command to npm.');
    } else if (/^\s*yarn\b/i.test(installCommand) && !commandExists('yarn')) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
      notes.push('yarn binary not present; adapted install command to npm.');
    } else if (/^\s*bun\b/i.test(installCommand) && !commandExists('bun')) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
      notes.push('bun binary not present; adapted install command to npm.');
    } else if (/^\s*npm\s+ci\b/i.test(installCommand)) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
      if (!fs.existsSync(path.join(botDir, 'package-lock.json'))) {
        notes.push('package-lock.json missing; switched npm ci to compatible npm install.');
      }
    } else if (/^\s*npm\s+install\s*$/i.test(installCommand)) {
      installCommand = 'npm install --legacy-peer-deps --ignore-engines --no-audit --no-fund';
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

    // Unwrap PM2 / Nodemon / Forever process-manager wrappers so bots run directly under Lyrihost's 24/7 supervisor
    const unwrapStartTarget = (cmdText: string): string | null => {
      const pm2Match = cmdText.match(/\b(?:pm2|pm2-runtime|forever)\s+(?:start\s+)?([^\s;&|]+)/i);
      if (pm2Match && pm2Match[1] && !pm2Match[1].startsWith('-')) {
        const target = pm2Match[1];
        if (/ecosystem\.config\.(?:c?js|mjs|json)$/i.test(target)) {
          const eco = parseEcosystemTarget(botDir, target);
          if (eco) {
            if (/\.(?:ts|tsx|mts|cts)$/i.test(eco.script)) {
              return `npx --yes tsx ${JSON.stringify(eco.script)}`;
            }
            return eco.nodeArgs
              ? `node ${eco.nodeArgs} ${JSON.stringify(eco.script)}`
              : `node ${JSON.stringify(eco.script)}`;
          }
          const fallbackEntry = ['index.js', 'bot.js', 'main.js', 'server.js'].find((f) =>
            fs.existsSync(path.join(botDir, f))
          );
          return fallbackEntry ? `node ${JSON.stringify(fallbackEntry)}` : null;
        }
        if (/\.(?:ts|tsx|mts|cts)$/i.test(target)) {
          return `npx --yes tsx ${JSON.stringify(target)}`;
        }
        return `node ${JSON.stringify(target)}`;
      }
      const nodemonMatch = cmdText.match(/\bnodemon\s+([^\s;&|]+)/i);
      if (nodemonMatch && nodemonMatch[1] && !nodemonMatch[1].startsWith('-')) {
        const target = nodemonMatch[1];
        if (/\.(?:ts|tsx|mts|cts)$/i.test(target)) {
          return `npx --yes tsx ${JSON.stringify(target)}`;
        }
        return `node ${JSON.stringify(target)}`;
      }
      return null;
    };

    const isDefaultStart =
      /^(npm\s+start|npm\s+run\s+start|yarn\s+start|pnpm\s+start|bun\s+run\s+start|docker\s+run)/i.test(
        startCommand
      );

    const directOverride = unwrapStartTarget(startCommand);
    if (directOverride) {
      startCommand = directOverride;
      notes.push(`Adapted external process manager command to direct supervised execution (${startCommand}).`);
    } else if (
      isDefaultStart &&
      pkg.scripts?.start &&
      (/\b(?:pm2|pm2-runtime|nodemon|forever)\b/i.test(pkg.scripts.start) ||
        (/^\s*bun\b/i.test(pkg.scripts.start) && !commandExists('bun')))
    ) {
      const unwrapped = unwrapStartTarget(pkg.scripts.start);
      if (unwrapped) {
        startCommand = unwrapped;
        notes.push(`Unwrapped package.json start script under Lyrihost 24/7 supervisor (${startCommand}).`);
      } else if (/^\s*bun\s+(?:run\s+)?([^\s;&|]+)/i.test(pkg.scripts.start)) {
        const bunTarget = pkg.scripts.start.match(/^\s*bun\s+(?:run\s+)?([^\s;&|]+)/i)?.[1];
        if (bunTarget && /\.(?:ts|tsx|js|mjs|cjs)$/i.test(bunTarget)) {
          startCommand = /\.(?:ts|tsx)$/i.test(bunTarget)
            ? `npx --yes tsx ${JSON.stringify(bunTarget)}`
            : `node ${JSON.stringify(bunTarget)}`;
          notes.push(`Adapted Bun script to Node execution (${startCommand}).`);
        }
      }
    } else if (isDefaultStart && (!pkg.scripts || !pkg.scripts.start)) {
      const procUnwrapped = procfileCmd ? unwrapStartTarget(procfileCmd) || procfileCmd : null;
      if (procUnwrapped && !/\b(npm|yarn|pnpm|bun)\s+(run\s+)?start\b/i.test(procUnwrapped)) {
        startCommand = procUnwrapped;
        notes.push(`package.json has no "start" script; using Procfile command (${startCommand}).`);
      } else {
        const nodeCandidates = [
          pkg.main,
          'dist/index.js',
          'build/index.js',
          'index.js',
          'bot.js',
          'main.js',
          'app.js',
          'server.js',
          'index.mjs',
          'index.cjs',
          'src/index.js',
          'src/bot.js',
          'src/main.js',
          'index.ts',
          'bot.ts',
          'main.ts',
          'src/index.ts',
          'src/bot.ts',
          'src/main.ts',
        ].filter((c): c is string => Boolean(c));

        const matchedEntry = nodeCandidates.find((rel) => fs.existsSync(path.join(botDir, rel)));
        if (matchedEntry) {
          if (/\.(?:ts|tsx|mts|cts)$/i.test(matchedEntry)) {
            if (pkg.scripts?.build && !buildCommand) {
              buildCommand = 'npm run build';
            }
            startCommand = `npx --yes tsx ${JSON.stringify(matchedEntry)}`;
            notes.push(`package.json has no "start" script; auto-selected TypeScript entrypoint ${matchedEntry}.`);
          } else {
            startCommand = `node ${JSON.stringify(matchedEntry)}`;
            notes.push(`package.json has no "start" script; auto-selected entrypoint ${matchedEntry}.`);
          }
        }
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
      } else if (hasPyproj) {
        installCommand = `${pyBin} -m pip install --break-system-packages . || pip3 install --break-system-packages .`;
        notes.push('Detected pyproject.toml; adapted install command to pip install.');
      } else {
        installCommand = '';
      }
    }

    if (buildCommand.startsWith('npm') || buildCommand.startsWith('docker')) {
      buildCommand = '';
    }

    if (/^\s*(npm|yarn|pnpm|bun|docker)\b/i.test(startCommand)) {
      if (procfileCmd && /\bpython/i.test(procfileCmd)) {
        startCommand = procfileCmd;
        notes.push(`Detected Python Procfile command (${startCommand}).`);
      } else if (foundPyEntry) {
        startCommand = `${pyBin} ${JSON.stringify(foundPyEntry)}`;
        notes.push(`Detected Python entrypoint (${foundPyEntry}); adapted start command.`);
      }
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

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'development',
      npm_config_omit: '',
      ...GIT_HTTPS_REWRITE_ENV,
      npm_config_yes: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_optional: 'true',
      npm_config_prefer_offline: 'false',
      PUPPETEER_SKIP_DOWNLOAD: 'true',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      SHARP_IGNORE_GLOBAL_LIBVIPS: '1',
      PYTHONUNBUFFERED: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      ...env,
    };
    delete childEnv.npm_config_production;
    delete childEnv.NPM_CONFIG_PRODUCTION;

    const child = spawn(command, {
      cwd,
      env: childEnv,
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

  // Sync Owner aliases across templates (OWNER_NUMBER <-> DEV <-> NUMBER)
  const effectiveOwner = map.OWNER_NUMBER || map.DEV || map.NUMBER || map.PAIRING_NUMBER || '';
  if (effectiveOwner) {
    if (!map.OWNER_NUMBER) map.OWNER_NUMBER = effectiveOwner;
    if (!map.DEV) map.DEV = effectiveOwner;
    if (!map.NUMBER) map.NUMBER = effectiveOwner;
  } else if (map.PHONE_NUMBER) {
    map.OWNER_NUMBER = map.PHONE_NUMBER;
  }

  // Sync Bot Name aliases across templates (BOT_NAME <-> BOTNAME)
  if (map.BOT_NAME && !map.BOTNAME) {
    map.BOTNAME = map.BOT_NAME;
  } else if (map.BOTNAME && !map.BOT_NAME) {
    map.BOT_NAME = map.BOTNAME;
  }

  // Sync Bot Mode aliases across templates (MODE <-> BOT_MODE <-> WORK_TYPE <-> WORKTYPE)
  const effectiveMode = map.MODE || map.BOT_MODE || map.WORK_TYPE || map.WORKTYPE || '';
  if (effectiveMode) {
    if (!map.MODE) map.MODE = effectiveMode;
    if (!map.BOT_MODE) map.BOT_MODE = effectiveMode;
    if (!map.WORK_TYPE) map.WORK_TYPE = effectiveMode;
    if (!map.WORKTYPE) map.WORKTYPE = effectiveMode;
  }

  // Sync Timezone aliases across templates (TZ <-> TIME_ZONE <-> TIMEZONE <-> BOT_TIMEZONE)
  const effectiveTz = map.TZ || map.TIME_ZONE || map.TIMEZONE || map.BOT_TIMEZONE || '';
  if (effectiveTz) {
    if (!map.TZ) map.TZ = effectiveTz;
    if (!map.TIME_ZONE) map.TIME_ZONE = effectiveTz;
    if (!map.TIMEZONE) map.TIMEZONE = effectiveTz;
    if (!map.BOT_TIMEZONE) map.BOT_TIMEZONE = effectiveTz;
  }

  return map;
}

function formatEnvValue(val: string): string {
  if (val === '') return '""';
  if (/^[A-Za-z0-9_.,/:;@+~-]+$/.test(val)) return val;
  return JSON.stringify(val);
}

const COLLIDING_DEFAULT_PORTS = new Set(['', '3000', '5000', '8000', '8080']);
const PLACEHOLDER_VALUE_RE = /^(?:"?YOUR_SESSION_ID_HERE"?|"?254XXXXXXXXX"?|"?62xxxx"?)$/i;

function sanitizePortInEnvMap(map: Record<string, string>, assignedPort?: number): Record<string, string> {
  if (!assignedPort || assignedPort <= 0) return map;
  const hostPort = String(process.env.PORT || '3000');
  const next = { ...map };
  const portStr = String(assignedPort);

  if (next.PORT !== undefined) {
    const clean = next.PORT.trim();
    if (COLLIDING_DEFAULT_PORTS.has(clean) || clean === hostPort) {
      next.PORT = portStr;
    }
  }
  if (next.SERVER_PORT !== undefined) {
    const cleanSrv = next.SERVER_PORT.trim();
    if (COLLIDING_DEFAULT_PORTS.has(cleanSrv) || cleanSrv === hostPort) {
      next.SERVER_PORT = portStr;
    }
  }
  return next;
}

function mergeEnvFile(filePath: string, map: Record<string, string>, assignedPort?: number): void {
  const merged: Record<string, string> = {};
  const hostPort = String(process.env.PORT || '3000');

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    for (const rawLine of existing.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim().replace(/^export\s+/, '');
      const v = line.slice(eq + 1).trim();
      if (!k) continue;
      if (PLACEHOLDER_VALUE_RE.test(v)) continue;
      if (
        (k === 'PORT' || k === 'SERVER_PORT') &&
        assignedPort &&
        (COLLIDING_DEFAULT_PORTS.has(v.replace(/^["']|["']$/g, '')) || v.replace(/^["']|["']$/g, '') === hostPort)
      ) {
        merged[k] = String(assignedPort);
      } else {
        merged[k] = v;
      }
    }
  }

  for (const [k, v] of Object.entries(map)) {
    if (v !== '') {
      merged[k] = formatEnvValue(v);
    } else if (!(k in merged)) {
      merged[k] = '""';
    }
  }
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  if (lines.length > 0) {
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  }
}

function tryDecodeBaileysCreds(rawSession: string): Record<string, unknown> | null {
  const trimmed = rawSession.trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/^data:application\/json;base64,/i, '')
    .replace(/^base64:/i, '');
  const strippedPrefix = cleaned.includes('~')
    ? cleaned.slice(cleaned.indexOf('~') + 1)
    : cleaned.includes(';;;')
      ? cleaned.slice(cleaned.indexOf(';;;') + 3)
      : cleaned;

  const candidates = [cleaned, strippedPrefix];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && ('noiseKey' in obj || 'signedIdentityKey' in obj)) {
        return obj;
      }
    } catch {
      // ignore non-JSON
    }
    try {
      const decoded = Buffer.from(c, 'base64').toString('utf-8');
      const obj = JSON.parse(decoded) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && ('noiseKey' in obj || 'signedIdentityKey' in obj)) {
        return obj;
      }
    } catch {
      // ignore non-base64 JSON
    }
  }
  return null;
}

function resetStaleSessionIfChanged(botDir: string, sessionVal: string): void {
  const cleanSession = sessionVal.trim();
  if (!cleanSession) return;
  const sigFile = path.join(botDir, '.lyrihost_session_sig');
  const nextSig = crypto.createHash('sha256').update(cleanSession).digest('hex').slice(0, 24);
  try {
    const prevSig = fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf-8').trim() : '';
    if (prevSig && prevSig !== nextSig) {
      for (const dir of ['session', 'auth_info_baileys', path.join('database', 'auth')]) {
        const target = path.join(botDir, dir);
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      }
    }
    fs.writeFileSync(sigFile, nextSig + '\n', 'utf-8');
  } catch {
    // non-fatal signature sync error
  }
}

export function writeDotEnvFile(
  botDir: string,
  envVars: EnvVarEntry[],
  options: { assignedPort?: number } = {}
): void {
  const rawMap = buildEnvMap(envVars);
  const map = sanitizePortInEnvMap(rawMap, options.assignedPort);

  resetStaleSessionIfChanged(botDir, map.SESSION_ID || map.SESSION || '');

  // Merge .env instead of wiping repository defaults (ELITE-PRO-V1, KING-MD, vanguardmd)
  const dotEnvPath = path.join(botDir, '.env');
  if (Object.keys(map).length > 0 || fs.existsSync(dotEnvPath)) {
    mergeEnvFile(dotEnvPath, map, options.assignedPort);
  }

  // Sync repos that load set.env (Keith) or config.env (BWM-XMD-GO-V2, TurboFex)
  for (const altEnv of ['set.env', 'config.env']) {
    const altPath = path.join(botDir, altEnv);
    if (fs.existsSync(altPath)) {
      mergeEnvFile(altPath, map, options.assignedPort);
    }
  }

  // Sync TurboFex session_id.txt & config.env when present
  const sessionTxtPath = path.join(botDir, 'session_id.txt');
  if (fs.existsSync(sessionTxtPath) && map.SESSION_ID) {
    try {
      fs.writeFileSync(sessionTxtPath, `SESSION_ID=${map.SESSION_ID}\n`, 'utf-8');
      mergeEnvFile(path.join(botDir, 'config.env'), map, options.assignedPort);
    } catch {
      // non-fatal TurboFex config sync error
    }
  }

  // Sync ELITE-PRO-V1 local database settings/owner JSON when present (ELITE-PRO-V1 ignores .env MODE and defaults to private!)
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
      for (const [envKey, jsonKey] of [
        ['AUTO_VIEW_STATUS', 'autoviewstatus'],
        ['AUTO_LIKE_STATUS', 'autolikestatus'],
        ['AUTO_READ', 'autoread'],
        ['AUTO_TYPING', 'autoTyping'],
        ['AUTO_RECORDING', 'autoRecording'],
        ['AUTO_RECORD_TYPE', 'autorecordtype'],
        ['AUTO_BIO', 'autobio'],
        ['AUTO_REACT', 'autoreact'],
      ] as const) {
        if (map[envKey] === 'true' || map[envKey] === 'false') {
          currentSettings[jsonKey] = map[envKey] === 'true';
        }
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
        // Replace default author placeholder if user explicitly set their own owner number(s)
        const userOwners = map.OWNER_NUMBER.split(',')
          .map((n) => n.replace(/\D/g, ''))
          .filter(Boolean);
        if (userOwners.length > 0) {
          const mergedOwners = Array.from(
            new Set([
              ...owners.filter((n) => n !== '2347047504860' || userOwners.includes('2347047504860')),
              ...userOwners,
            ])
          );
          fs.writeFileSync(ownerPath, JSON.stringify(mergedOwners, null, 2) + '\n', 'utf-8');
        }
      }
    } catch {
      // ignore non-critical JSON sync error
    }
  }

  // Sync silentwolf-bot system/config.js + database/settings.json + optional creds.json
  const silentwolfConfigPath = path.join(botDir, 'system', 'config.js');
  if (fs.existsSync(silentwolfConfigPath)) {
    try {
      const dbDir = path.join(botDir, 'database');
      fs.mkdirSync(dbDir, { recursive: true });
      const settPath = path.join(dbDir, 'settings.json');
      let currentSettings: Record<string, unknown> = {};
      if (fs.existsSync(settPath)) {
        try {
          currentSettings = JSON.parse(fs.readFileSync(settPath, 'utf-8')) as Record<string, unknown>;
        } catch {
          currentSettings = {};
        }
      }
      if (map.MODE) {
        currentSettings.mode = map.MODE.toLowerCase() === 'private' ? '--self' : '--public';
      } else if (!currentSettings.mode) {
        currentSettings.mode = '--public';
      }
      fs.writeFileSync(settPath, JSON.stringify(currentSettings, null, 2) + '\n', 'utf-8');

      let cfgText = fs.readFileSync(silentwolfConfigPath, 'utf-8');
      const pairNum = (map.PAIRING_NUMBER || map.OWNER_NUMBER || '').replace(/\D/g, '');
      if (pairNum) {
        cfgText = cfgText
          .replace(/"62xxxx@s\.whatsapp\.net"/g, JSON.stringify(`${pairNum}@s.whatsapp.net`))
          .replace(/"62xxxx"/g, JSON.stringify(pairNum));
      }
      if (map.BOT_NAME) {
        cfgText = cfgText.replace(/name:\s*"silentwolf"/g, `name: ${JSON.stringify(map.BOT_NAME)}`);
      }
      if (map.PREFIX) {
        cfgText = cfgText.replace(
          /prefix:\s*\[\s*"\."\s*,\s*"!"\s*\]/,
          `prefix: [${JSON.stringify(map.PREFIX)}]`
        );
      }
      fs.writeFileSync(silentwolfConfigPath, cfgText, 'utf-8');

      const sessionRaw = map.SESSION_ID || map.SESSION || '';
      const authCredsPath = path.join(dbDir, 'auth', 'creds.json');
      if (sessionRaw && !fs.existsSync(authCredsPath)) {
        const parsedCreds = tryDecodeBaileysCreds(sessionRaw);
        if (parsedCreds) {
          fs.mkdirSync(path.join(dbDir, 'auth'), { recursive: true });
          fs.writeFileSync(authCredsPath, JSON.stringify(parsedCreds, null, 2), 'utf-8');
        }
      }
    } catch {
      // ignore non-critical silentwolf sync error
    }
  }
}

