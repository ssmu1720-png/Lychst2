import crypto from 'node:crypto';
import type {
  BotDeployment,
  LogEntry,
  PlatformPreferences,
  TelemetryPoint,
} from '../src/types/lyrihost.ts';
import {
  deleteMeta,
  getDefaultPreferences,
  getMeta,
  loadDeploymentsFromDb,
  makeId,
  nowIso,
  setMeta,
  syncDeploymentsToDb,
} from './db.ts';

export { makeId, nowIso };

export interface PersistedState {
  nextNumericId: number;
  deployments: BotDeployment[];
  preferences: PlatformPreferences;
  githubToken?: string;
}

export function buildEmptyTelemetryHistory(): TelemetryPoint[] {
  const points: TelemetryPoint[] = [];
  const now = Date.now();
  for (let i = 23; i >= 0; i--) {
    const ts = new Date(now - i * 1500).toISOString();
    points.push({ ts, cpuPercent: 0, memoryMb: 0, latencyMs: 0, eventsPerMin: 0 });
  }
  return points;
}

export function createInitialState(): PersistedState {
  return {
    nextNumericId: 1,
    preferences: getDefaultPreferences(),
    deployments: [],
  };
}

export function normalizeState(loaded: PersistedState): PersistedState {
  if (!Array.isArray(loaded.deployments)) {
    loaded.deployments = [];
  }
  if (!loaded.preferences) {
    loaded.preferences = getDefaultPreferences();
  }
  if (!loaded.preferences.webhookSecret) {
    loaded.preferences.webhookSecret = `lh_wh_${crypto.randomBytes(12).toString('hex')}`;
  }

  let maxId =
    typeof loaded.nextNumericId === 'number' && loaded.nextNumericId > 0
      ? loaded.nextNumericId
      : 1;

  for (const dep of loaded.deployments) {
    if (typeof dep.numericId !== 'number') {
      dep.numericId = maxId++;
    } else if (dep.numericId >= maxId) {
      maxId = dep.numericId + 1;
    }
    if (typeof dep.gatewayLatencyMs !== 'number') dep.gatewayLatencyMs = 0;
    if (typeof dep.eventsPerMin !== 'number') dep.eventsPerMin = 0;
    if (typeof dep.networkKbps !== 'number') dep.networkKbps = 0;
    if (typeof dep.onlineChecks !== 'number') dep.onlineChecks = 0;
    if (typeof dep.totalChecks !== 'number') dep.totalChecks = 0;
    if (typeof dep.uptimePercentage !== 'number') {
      dep.uptimePercentage =
        dep.totalChecks > 0 ? Math.round((dep.onlineChecks / dep.totalChecks) * 1000) / 10 : 0;
    }
    if (typeof dep.healthScore !== 'number') dep.healthScore = 0;
    if (!Array.isArray(dep.telemetryHistory) || dep.telemetryHistory.length === 0) {
      dep.telemetryHistory = buildEmptyTelemetryHistory();
    }
  }
  loaded.nextNumericId = maxId;
  return loaded;
}

export function loadState(): PersistedState {
  try {
    const deployments = loadDeploymentsFromDb();
    const rawNextId = getMeta('next_numeric_id');
    const rawPrefs = getMeta('platform_preferences');
    const githubToken = getMeta('github_token') || undefined;

    let preferences = getDefaultPreferences();
    if (rawPrefs) {
      try {
        preferences = {
          ...preferences,
          ...(JSON.parse(rawPrefs) as Partial<PlatformPreferences>),
        };
      } catch {
        // use defaults
      }
    }

    const nextNumericId = rawNextId ? Math.max(1, Number.parseInt(rawNextId, 10) || 1) : 1;

    return normalizeState({
      nextNumericId,
      preferences,
      deployments,
      githubToken,
    });
  } catch (err) {
    console.error('Failed to load state from SQLite:', err);
    return createInitialState();
  }
}

export function saveStateToDisk(state: PersistedState): void {
  try {
    setMeta('next_numeric_id', String(state.nextNumericId));
    setMeta('platform_preferences', JSON.stringify(state.preferences));
    if (state.githubToken) {
      setMeta('github_token', state.githubToken);
    } else {
      deleteMeta('github_token');
    }
    syncDeploymentsToDb(state.deployments);
  } catch (err) {
    console.error('Failed to persist Lyrihost state to SQLite:', err);
  }
}

export function pushDeploymentLog(
  dep: BotDeployment,
  level: LogEntry['level'],
  stage: string,
  message: string
): void {
  dep.logs.push({
    id: makeId('log'),
    timestamp: nowIso(),
    level,
    stage,
    message,
  });
  if (dep.logs.length > 200) {
    dep.logs = dep.logs.slice(-200);
  }
  dep.updatedAt = nowIso();
}
