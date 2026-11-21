import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { Coins, Flame, LogOut, Menu, Plus, X } from 'lucide-react';
import { AdminView } from './components/AdminView';
import { AuthView } from './components/AuthView';
import { BotInspectorView } from './components/BotInspectorView';
import { CoinsView } from './components/CoinsView';
import { CustomRepoDeployView } from './components/CustomRepoDeployView';
import { DashboardView } from './components/DashboardView';
import { LyrihostLogo } from './components/LyrihostLogo';
import { MatrixRainCanvas } from './components/MatrixRainCanvas';
import { PlatformSettingsView } from './components/PlatformSettingsView';
import { SecurityAuditsView } from './components/SecurityAuditsView';
import { SupportView } from './components/SupportView';
import { TemplatesView } from './components/TemplatesView';
import { firebaseAuth, googleAuthProvider } from './lib/firebase';
import {
  deleteDeploymentFromFirestore,
  loadUserDeploymentsFromFirestore,
  syncDeploymentToFirestore,
  syncUserProfileToFirestore,
  type CloudDeploymentSpec,
} from './lib/firestoreStore';
import {
  ADMIN_EMAIL,
  type AuthUser,
  type BotDeployment,
  type DailyStreakReward,
  type DeploymentPlanId,
  type PlatformPreferences,
} from './types/lyrihost';

const AUTH_STORAGE_KEY = 'lyrihost_auth_token';

type ActiveRoute =
  | 'dashboard'
  | 'templates'
  | 'custom'
  | 'coins'
  | 'support'
  | 'security'
  | 'settings'
  | 'admin'
  | 'inspector';

const DEFAULT_PREFERENCES: PlatformPreferences = {
  defaultRegion: 'us-east',
  defaultRestartPolicy: 'always',
  defaultRuntime: 'node-20',
  telemetryCadenceSec: 2,
  compactFleetCards: false,
  deployAlertEmails: true,
  autoClearStoppedLogs: false,
  matrixIntensity: 'full',
  githubTokenConfigured: false,
  webhookSecret: '',
  promoEmailsOptIn: true,
  lowCoinAlertThreshold: 10,
};

export default function App() {
  const [route, setRoute] = useState<ActiveRoute>('dashboard');
  const [preferredPlanId, setPreferredPlanId] = useState<DeploymentPlanId>('plan_15d');
  const [deployments, setDeployments] = useState<BotDeployment[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<PlatformPreferences>(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [streamConnected, setStreamConnected] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState('');

  const [authChecking, setAuthChecking] = useState(true);
  const [authToken, setAuthToken] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(AUTH_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [streakBanner, setStreakBanner] = useState<DailyStreakReward | null>(null);

  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [cloudDeployments, setCloudDeployments] = useState<CloudDeploymentSpec[]>([]);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [cloudNotice, setCloudNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  useEffect(() => {
    const unsub = onAuthStateChanged(firebaseAuth, (user) => {
      setFirebaseUser(user);
      if (!user) {
        setCloudDeployments([]);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    let active = true;
    const verifySession = async () => {
      if (!authToken) {
        if (active) {
          setCurrentUser(null);
          setAuthChecking(false);
        }
        return;
      }
      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) {
          throw new Error('Session invalid');
        }
        const data = (await res.json()) as {
          user?: AuthUser;
          streakReward?: DailyStreakReward | null;
        };
        if (active) {
          setCurrentUser(data.user ?? null);
          if (data.streakReward?.claimedNow) {
            setStreakBanner(data.streakReward);
          }
        }
      } catch {
        try {
          window.localStorage.removeItem(AUTH_STORAGE_KEY);
        } catch {
          // ignore
        }
        if (active) {
          setAuthToken(null);
          setCurrentUser(null);
        }
      } finally {
        if (active) {
          setAuthChecking(false);
        }
      }
    };
    void verifySession();
    return () => {
      active = false;
    };
  }, [authToken]);

  const refreshUser = useCallback(async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { user?: AuthUser };
      if (data.user) {
        setCurrentUser(data.user);
      }
    } catch {
      // ignore transient refresh failure
    }
  }, [authToken]);

  const handleAuthenticated = (
    token: string,
    user: AuthUser,
    streakReward?: DailyStreakReward | null
  ) => {
    try {
      window.localStorage.setItem(AUTH_STORAGE_KEY, token);
    } catch {
      // ignore storage failure
    }
    setAuthToken(token);
    setCurrentUser(user);
    setAuthChecking(false);
    setRoute('dashboard');
    if (streakReward?.claimedNow) {
      setStreakBanner(streakReward);
    }
  };

  const handleLogout = async () => {
    const tokenToRevoke = authToken;
    try {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      // ignore
    }
    setAuthToken(null);
    setCurrentUser(null);
    setStreakBanner(null);
    setDeployments([]);
    setMobileNavOpen(false);
    setRoute('dashboard');
    if (tokenToRevoke) {
      void fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenToRevoke}` },
      }).catch(() => {});
    }
  };

  const fetchAll = useCallback(async () => {
    if (!currentUser || !authToken) return;
    try {
      const headers = { Authorization: `Bearer ${authToken}` };
      const [depRes, prefRes] = await Promise.all([
        fetch('/api/deployments', { headers }),
        fetch('/api/preferences', { headers }),
      ]);
      if (depRes.ok) {
        const list = (await depRes.json()) as BotDeployment[];
        setDeployments(list);
        setLastSyncTime(new Date().toISOString());
      }
      if (prefRes.ok) {
        const prefs = (await prefRes.json()) as PlatformPreferences;
        setPreferences(prefs);
      }
    } catch {
      // silent retry on next poll
    } finally {
      setLoading(false);
    }
  }, [currentUser, authToken]);

  useEffect(() => {
    if (currentUser && authToken) {
      void fetchAll();
    }
  }, [currentUser, authToken, fetchAll]);

  // Real-time Server-Sent Events stream with automatic reconnect
  useEffect(() => {
    if (!currentUser || !authToken) return;
    let source: EventSource | null = null;
    let fallbackTimer: number | null = null;

    const connect = () => {
      source = new EventSource(`/api/stream?token=${encodeURIComponent(authToken)}`);
      source.onopen = () => {
        setStreamConnected(true);
      };
      source.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as {
            deployments: BotDeployment[];
            serverTime: string;
          };
          if (Array.isArray(parsed.deployments)) {
            setDeployments(parsed.deployments);
            setLastSyncTime(parsed.serverTime || new Date().toISOString());
            setLoading(false);
          }
        } catch {
          // ignore malformed event frames
        }
      };
      source.onerror = () => {
        setStreamConnected(false);
      };
    };

    if (typeof EventSource !== 'undefined') {
      connect();
    } else {
      fallbackTimer = window.setInterval(async () => {
        try {
          const res = await fetch('/api/deployments', {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (res.ok) {
            setDeployments((await res.json()) as BotDeployment[]);
            setLastSyncTime(new Date().toISOString());
          }
        } catch {
          // ignore
        }
      }, 2000);
    }

    return () => {
      source?.close();
      if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
    };
  }, [currentUser, authToken]);

  const syncWorkspaceToCloud = useCallback(
    async (
      fbUser: User | null,
      targetPrefs?: PlatformPreferences,
      targetDeps?: BotDeployment[]
    ) => {
      if (!fbUser || !fbUser.emailVerified || !currentUser) return;
      setCloudSyncing(true);
      try {
        await syncUserProfileToFirestore(fbUser, currentUser, targetPrefs ?? preferences);
        const listToSync = targetDeps ?? deployments;
        for (const dep of listToSync) {
          await syncDeploymentToFirestore(fbUser, dep);
        }
        const isRootAdmin =
          Boolean(currentUser.isAdmin) &&
          fbUser.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
        const cloudList = await loadUserDeploymentsFromFirestore(fbUser, isRootAdmin);
        setCloudDeployments(cloudList);
        setCloudNotice({
          type: 'success',
          text: `Synced profile & ${cloudList.length} deployment backup${cloudList.length === 1 ? '' : 's'} to Cloud Firestore.`,
        });
      } catch (err) {
        setCloudNotice({
          type: 'error',
          text: err instanceof Error ? err.message : 'Cloud sync encountered an error.',
        });
      } finally {
        setCloudSyncing(false);
      }
    },
    [currentUser, preferences, deployments]
  );

  useEffect(() => {
    if (firebaseUser?.emailVerified && currentUser && !loading) {
      void syncWorkspaceToCloud(firebaseUser);
    }
    // Sync on auth/load boundary rather than every 2s SSE tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseUser?.uid, currentUser?.id, loading]);

  const handleConnectGoogleCloud = async () => {
    setCloudNotice(null);
    setCloudSyncing(true);
    try {
      const cred = await signInWithPopup(firebaseAuth, googleAuthProvider);
      if (!cred.user.emailVerified) {
        throw new Error('Your Google account email must be verified to sync with Firestore.');
      }
      await syncWorkspaceToCloud(cred.user);
    } catch (err) {
      setCloudNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Google Cloud Sync sign-in failed.',
      });
    } finally {
      setCloudSyncing(false);
    }
  };

  const handleDisconnectGoogleCloud = async () => {
    setCloudNotice(null);
    await signOut(firebaseAuth);
    setCloudDeployments([]);
    setCloudNotice({ type: 'success', text: 'Disconnected Google Cloud Sync.' });
  };

  const handleSyncCloudNow = async () => {
    if (!firebaseUser) return;
    await syncWorkspaceToCloud(firebaseUser);
  };

  const handleRestoreCloudDeployment = async (spec: CloudDeploymentSpec) => {
    if (!authToken) return;
    setCloudNotice(null);
    try {
      const resp = await fetch('/api/deployments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          repoUrl: spec.repoUrl,
          repoFullName: spec.repoFullName,
          platform: spec.platform,
          framework: spec.framework,
          planId: spec.planId,
          settings: {
            name: spec.name,
            branch: spec.branch,
            region: spec.region,
            runtime: spec.runtime,
            installCommand: spec.installCommand || '',
            buildCommand: spec.buildCommand || '',
            startCommand: spec.startCommand,
            computeTier:
              spec.planId === 'plan_unlimited'
                ? 'cluster'
                : spec.planId === 'plan_30d'
                  ? 'pro'
                  : 'standard',
            planId: spec.planId,
            restartPolicy: spec.restartPolicy,
            autoDeploy: true,
            healthCheckPath: '/health',
            envVars: [],
          },
        }),
      });
      const data = (await resp.json()) as BotDeployment & { error?: string };
      if (!resp.ok || !data.id) {
        throw new Error(data.error || 'Could not re-deploy cloud backup spec.');
      }
      setDeployments((prev) => [data, ...prev]);
      setSelectedBotId(data.id);
      setRoute('inspector');
      void refreshUser();
    } catch (err) {
      setCloudNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Re-deploy from cloud failed.',
      });
    }
  };

  const handleBotAction = async (botId: string, action: 'start' | 'stop' | 'restart') => {
    if (!authToken) return;
    const resp = await fetch(`/api/deployments/${botId}/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ action }),
    });
    if (resp.ok) {
      const updated = (await resp.json()) as BotDeployment;
      setDeployments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    }
  };

  const handleClaimDailyStreak = async () => {
    if (!authToken) return;
    const resp = await fetch('/api/wallet/streak/claim', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as {
      user?: AuthUser;
      reward?: DailyStreakReward;
    };
    if (data.user) setCurrentUser(data.user);
    if (data.reward?.claimedNow) {
      setStreakBanner(data.reward);
    }
  };

  const handleRenewBotPlan = async (botId: string, planId: DeploymentPlanId) => {
    if (!authToken) return;
    const resp = await fetch(`/api/deployments/${botId}/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ planId }),
    });
    const data = (await resp.json()) as {
      deployment?: BotDeployment;
      user?: AuthUser;
      error?: string;
    };
    if (!resp.ok || !data.deployment) {
      throw new Error(data.error || 'Failed to renew plan.');
    }
    setDeployments((prev) =>
      prev.map((d) => (d.id === data.deployment!.id ? data.deployment! : d))
    );
    if (data.user) {
      setCurrentUser(data.user);
    } else {
      await refreshUser();
    }
  };

  const selectedBot = deployments.find((d) => d.id === selectedBotId) ?? null;

  const hasCriticalAlert = deployments.some(
    (d) =>
      d.status === 'failed' ||
      (d.scanReport?.securityFindings.some((f) => f.severity === 'critical') ?? false)
  );

  const navigate = (next: ActiveRoute) => {
    setRoute(next);
    setMobileNavOpen(false);
  };

  if (authChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#080305] text-xs text-slate-400">
        Verifying operator session...
      </div>
    );
  }

  if (!currentUser || !authToken) {
    return <AuthView onAuthenticated={handleAuthenticated} />;
  }

  const isAdmin =
    Boolean(currentUser.isAdmin) && currentUser.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  const navItems: Array<{
    id: Exclude<ActiveRoute, 'inspector' | 'custom' | 'security'>;
    label: string;
  }> = [
    { id: 'dashboard', label: 'Deployments' },
    { id: 'templates', label: 'Templates' },
    { id: 'coins', label: 'Coins' },
    { id: 'support', label: 'Support' },
    { id: 'settings', label: 'Settings' },
    ...(isAdmin ? [{ id: 'admin' as const, label: 'Admin' }] : []),
  ];

  return (
    <div className="relative flex min-h-screen flex-col bg-[#080305] text-slate-200">
      <MatrixRainCanvas intensity={preferences.matrixIntensity} hasAlert={hasCriticalAlert} />

      {/* Standard 3-Zone Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-red-500/20 bg-[#0b0407]/92 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
          {/* Zone 1: Brand Title */}
          <button
            type="button"
            onClick={() => navigate('dashboard')}
            className="focus-visible:outline-2 focus-visible:outline-red-400 whitespace-nowrap shrink-0"
          >
            <LyrihostLogo />
          </button>

          {/* Zone 2: Clean Single-Line Nav Links */}
          <nav className="hidden md:flex items-center gap-6">
            {navItems.map((item) => {
              const isActive =
                route === item.id ||
                (route === 'inspector' && item.id === 'dashboard') ||
                (route === 'custom' && item.id === 'templates');
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                  className={`relative py-1 text-xs font-medium tracking-wide transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'text-red-300'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {item.label}
                  {isActive && (
                    <span className="absolute inset-x-0 -bottom-1 h-px bg-gradient-to-r from-transparent via-red-400 to-transparent" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Coin Pill + Deploy CTA + Logout + Mobile Menu Trigger */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => navigate('coins')}
              title="Open Coins Wallet"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#0d0508] px-2.5 py-1.5 font-mono text-[11px] font-semibold text-rose-200 transition-colors hover:border-red-500/45 whitespace-nowrap shrink-0 tabular-nums"
            >
              <Coins className="h-3.5 w-3.5 text-red-400" />
              {currentUser.unlimitedCoins ? '∞' : `${currentUser.coinBalance}c`}
            </button>

            <button
              type="button"
              onClick={() => navigate('templates')}
              className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-red-600 to-red-700 px-3.5 py-1.5 text-xs font-semibold text-white shadow-[0_1px_10px_rgba(220,38,38,0.28)] transition-all hover:from-red-500 hover:to-red-600 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Deploy Bot
            </button>

            <button
              type="button"
              onClick={() => void handleLogout()}
              title="Log out"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-red-950/90 bg-[#0d0508] px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-red-500/40 hover:text-red-200 whitespace-nowrap shrink-0"
            >
              <LogOut className="h-3.5 w-3.5 text-red-400" />
              Log Out
            </button>

            <button
              type="button"
              onClick={() => setMobileNavOpen((v) => !v)}
              aria-label="Toggle navigation menu"
              className="rounded-md border border-red-950/80 p-1.5 text-slate-300 hover:border-red-500/40 md:hidden"
            >
              {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Mobile Dropdown Nav */}
        {mobileNavOpen && (
          <nav className="border-t border-red-950/70 bg-[#0d0508] px-4 py-3 md:hidden">
            <div className="flex flex-col space-y-1">
              {navItems.map((item) => {
                const isActive =
                  route === item.id || (route === 'inspector' && item.id === 'dashboard');
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className={`rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-red-500/15 text-red-300'
                        : 'text-slate-300 hover:bg-red-950/40'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => navigate('custom')}
                className="rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-300 hover:bg-red-950/40"
              >
                Custom Repo
              </button>
              <button
                type="button"
                onClick={() => navigate('security')}
                className="rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-300 hover:bg-red-950/40"
              >
                Audits
              </button>
              <div className="mt-2 flex items-center justify-between border-t border-red-950/70 pt-2.5">
                <span className="truncate font-mono text-xs text-slate-400">
                  {currentUser.email} ({currentUser.unlimitedCoins ? '∞' : `${currentUser.coinBalance}c`})
                </span>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-500/35 px-2.5 py-1 text-xs text-red-200"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Log Out
                </button>
              </div>
            </div>
          </nav>
        )}
      </header>

      {/* Daily Streak Login Reward Banner */}
      {streakBanner && streakBanner.claimedNow && (
        <div className="relative z-20 border-b border-amber-500/35 bg-amber-500/10 px-4 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 text-xs text-amber-200 sm:px-2 lg:px-4">
            <div className="flex items-center gap-2">
              <Flame className="h-4 w-4 shrink-0 text-amber-400" />
              <span>{streakBanner.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setStreakBanner(null)}
              className="rounded border border-amber-500/40 px-2 py-0.5 text-[11px] hover:bg-amber-500/20"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Centered Full-Width Content Workspace */}
      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {route === 'dashboard' && (
          <DashboardView
            deployments={deployments}
            currentUser={currentUser}
            loading={loading}
            streamConnected={streamConnected}
            lastSyncTime={lastSyncTime}
            onSelectBot={(id) => {
              setSelectedBotId(id);
              setRoute('inspector');
            }}
            onOpenCustomDeploy={() => navigate('custom')}
            onOpenTemplates={() => navigate('templates')}
            onOpenCoins={() => navigate('coins')}
            onOpenSupport={() => navigate('support')}
            onClaimStreak={handleClaimDailyStreak}
            onRenewBot={handleRenewBotPlan}
            onBotAction={handleBotAction}
          />
        )}

        {route === 'templates' && (
          <TemplatesView
            authToken={authToken}
            currentUser={currentUser}
            initialPlanId={preferredPlanId}
            preferences={preferences}
            onOpenCustomDeploy={() => navigate('custom')}
            onOpenCoins={() => navigate('coins')}
            onDeployed={(created) => {
              setDeployments((prev) => [created, ...prev]);
              setSelectedBotId(created.id);
              setRoute('inspector');
              void refreshUser();
              if (firebaseUser?.emailVerified) {
                void syncDeploymentToFirestore(firebaseUser, created).catch(() => {});
              }
            }}
          />
        )}

        {route === 'custom' && (
          <CustomRepoDeployView
            authToken={authToken}
            currentUser={currentUser}
            initialPlanId={preferredPlanId}
            preferences={preferences}
            onOpenTemplates={() => navigate('templates')}
            onOpenCoins={() => navigate('coins')}
            onDeployed={(created) => {
              setDeployments((prev) => [created, ...prev]);
              setSelectedBotId(created.id);
              setRoute('inspector');
              void refreshUser();
              if (firebaseUser?.emailVerified) {
                void syncDeploymentToFirestore(firebaseUser, created).catch(() => {});
              }
            }}
          />
        )}

        {route === 'coins' && (
          <CoinsView
            authToken={authToken}
            currentUser={currentUser}
            onUserUpdated={(updatedUser) => setCurrentUser(updatedUser)}
            onDeployWithPlan={(planId) => {
              setPreferredPlanId(planId);
              navigate('templates');
            }}
          />
        )}

        {route === 'support' && (
          <SupportView
            authToken={authToken}
            currentUser={currentUser}
            preferences={preferences}
            onPreferencesUpdated={(next) => {
              setPreferences(next);
              if (firebaseUser?.emailVerified) {
                void syncWorkspaceToCloud(firebaseUser, next);
              }
            }}
            onUserRefresh={refreshUser}
          />
        )}

        {route === 'security' && (
          <SecurityAuditsView
            deployments={deployments}
            onSelectBot={(id) => {
              setSelectedBotId(id);
              setRoute('inspector');
            }}
            onOpenTemplates={() => navigate('templates')}
          />
        )}

        {route === 'settings' && (
          <PlatformSettingsView
            authToken={authToken}
            currentUser={currentUser}
            preferences={preferences}
            firebaseUser={firebaseUser}
            cloudDeployments={cloudDeployments}
            cloudSyncing={cloudSyncing}
            cloudNotice={cloudNotice}
            onConnectCloudSync={handleConnectGoogleCloud}
            onDisconnectCloudSync={handleDisconnectGoogleCloud}
            onSyncCloudNow={handleSyncCloudNow}
            onRestoreCloudDeployment={handleRestoreCloudDeployment}
            onUpdated={(next) => {
              setPreferences(next);
              if (firebaseUser?.emailVerified) {
                void syncWorkspaceToCloud(firebaseUser, next);
              }
            }}
            onUserRefresh={refreshUser}
            onOpenSupport={() => navigate('support')}
            onLogout={() => void handleLogout()}
          />
        )}

        {route === 'admin' && isAdmin && (
          <AdminView
            authToken={authToken}
            onSelectBot={(id) => {
              setSelectedBotId(id);
              setRoute('inspector');
            }}
            onBotAction={handleBotAction}
          />
        )}

        {route === 'inspector' && selectedBot && (
          <BotInspectorView
            authToken={authToken}
            deployment={selectedBot}
            onBack={() => setRoute('dashboard')}
            onUpdated={(updated) => {
              setDeployments((prev) =>
                prev.map((d) => (d.id === updated.id ? updated : d))
              );
              if (firebaseUser?.emailVerified) {
                void syncDeploymentToFirestore(firebaseUser, updated).catch(() => {});
              }
            }}
            onDeleted={(deletedId) => {
              setDeployments((prev) => prev.filter((d) => d.id !== deletedId));
              setSelectedBotId(null);
              setRoute('dashboard');
              void refreshUser();
              if (firebaseUser?.emailVerified) {
                void deleteDeploymentFromFirestore(deletedId).catch(() => {});
              }
            }}
          />
        )}

        {route === 'inspector' && !selectedBot && (
          <div className="rounded-xl border border-red-950/80 bg-[#12070a]/95 p-8 text-center">
            <p className="text-sm text-slate-300">Selected bot deployment could not be found.</p>
            <button
              type="button"
              onClick={() => setRoute('dashboard')}
              className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500"
            >
              Return to Deployments
            </button>
          </div>
        )}
      </main>

      {/* Clean Minimal Footer */}
      <footer className="relative z-10 border-t border-red-950/60 bg-[#0a0406]/85">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-slate-500 sm:flex-row sm:px-6 lg:px-8">
          <span>Lyrihost · Bot Deployment, Coins &amp; GitHub Security Console</span>
          <div className="flex flex-wrap items-center gap-4">
            <button type="button" onClick={() => navigate('dashboard')} className="hover:text-slate-300">
              Deployments
            </button>
            <button type="button" onClick={() => navigate('templates')} className="hover:text-slate-300">
              Templates
            </button>
            <button type="button" onClick={() => navigate('custom')} className="hover:text-slate-300">
              Custom Repo
            </button>
            <button type="button" onClick={() => navigate('coins')} className="hover:text-slate-300">
              Coins
            </button>
            <button type="button" onClick={() => navigate('support')} className="hover:text-slate-300">
              Support
            </button>
            <button type="button" onClick={() => navigate('security')} className="hover:text-slate-300">
              Audits
            </button>
            <button type="button" onClick={() => navigate('settings')} className="hover:text-slate-300">
              Settings
            </button>
            {isAdmin && (
              <button type="button" onClick={() => navigate('admin')} className="text-red-400 hover:text-red-300">
                Admin
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
