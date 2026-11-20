import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EnvVarEntry } from '../src/types/lyrihost.ts';
import { safeRemoveDir } from './processManager.ts';

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
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  const normalized = /^github\.com\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  try {
    const u = new URL(normalized);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
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
        timeout: 120000,
        signal,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_ASKPASS: '',
        },
      },
      (err, stdout, stderr) => {
        const combined = redactSecret(`${stdout || ''}${stderr || ''}`.trim(), token);
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
  const args = ['clone', '--depth', '1'];
  if (branch) {
    args.push('--branch', branch);
  }
  args.push(cloneUrl, targetDir);

  let res = await runGitClone(args, options.signal, options.gitToken);

  // Retry once automatically on transient network/TLS hiccups
  if (
    !res.ok &&
    !options.signal?.aborted &&
    /timed out|RPC failed|Could not resolve host|Connection reset|HTTP 5\d\d|TLS/i.test(res.output)
  ) {
    if (fs.existsSync(targetDir)) {
      safeRemoveDir(targetDir);
    }
    await new Promise((r) => setTimeout(r, 1500));
    res = await runGitClone(args, options.signal, options.gitToken);
  }

  // If specified branch wasn't found, fall back to the repository's default branch
  if (
    !res.ok &&
    branch &&
    /Remote branch .+ not found|did not match any file\(s\) known to git/i.test(res.output)
  ) {
    if (fs.existsSync(targetDir)) {
      safeRemoveDir(targetDir);
    }
    res = await runGitClone(['clone', '--depth', '1', cloneUrl, targetDir], options.signal, options.gitToken);
  }

  if (!res.ok) {
    if (/could not read Username|Authentication failed|Repository not found/i.test(res.output)) {
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
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_ASKPASS: '',
        },
      },
      (err, stdout, stderr) => {
        const output = redactSecret(`${stdout || ''}${stderr || ''}`.trim(), gitToken) || 'Already up to date.';
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
        npm_config_yes: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        PUPPETEER_SKIP_DOWNLOAD: 'true',
        SHARP_IGNORE_GLOBAL_LIBVIPS: '1',
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
  if (map.SESSION_ID && !map.SESSION) {
    map.SESSION = map.SESSION_ID;
  } else if (map.SESSION && !map.SESSION_ID) {
    map.SESSION_ID = map.SESSION;
  }
  return map;
}

export function writeDotEnvFile(botDir: string, envVars: EnvVarEntry[]): void {
  const map = buildEnvMap(envVars);
  const lines = Object.entries(map).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  if (lines.length === 0) return;
  fs.writeFileSync(path.join(botDir, '.env'), lines.join('\n') + '\n', 'utf-8');
}
