import { type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import type { TemplateBotSpec } from '../catalog/templateBots';
import {
  ADMIN_EMAIL,
  type AuthUser,
  type BotDeployment,
  type BotPlatform,
  type DeploymentPlanId,
  type DeploymentStatus,
  type PlatformPreferences,
  type RestartPolicy,
  type RuntimeEnvironment,
  type SupportTicket,
  type SupportTicketCategory,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from '../types/lyrihost';
import { db, handleFirestoreError, OperationType } from './firebase';

export interface CloudUserProfileDoc {
  uid: string;
  email: string;
  role: 'user' | 'admin';
  coinBalance: number;
  unlimitedCoins: boolean;
  maxDeployments: number;
  referralCode: string;
  acceptedTerms: boolean;
  defaultRegion?: string;
  defaultRestartPolicy?: RestartPolicy;
  defaultRuntime?: RuntimeEnvironment;
  promoEmailsOptIn?: boolean;
  createdAt?: Timestamp | string;
  updatedAt?: Timestamp | string;
}

export interface CloudDeploymentSpec {
  id: string;
  ownerUid: string;
  ownerEmail: string;
  name: string;
  repoUrl: string;
  repoFullName: string;
  platform: BotPlatform;
  framework: string;
  status: DeploymentStatus;
  planId: DeploymentPlanId;
  memoryLimitMb: number;
  branch: string;
  region: string;
  runtime: RuntimeEnvironment;
  installCommand?: string;
  buildCommand?: string;
  startCommand: string;
  restartPolicy: RestartPolicy;
  createdAtIso?: string;
  updatedAtIso?: string;
}

function sanitizeId(raw: string, fallbackPrefix = 'doc'): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 120);
  if (cleaned.length >= 2) return cleaned;
  return `${fallbackPrefix}_${Date.now()}`;
}

function clampStr(val: string | undefined | null, fallback: string, minLen: number, maxLen: number): string {
  const s = String(val ?? '').trim();
  const base = s.length >= minLen ? s : fallback;
  return base.slice(0, maxLen);
}

function normalizeRuntime(val: string | undefined): RuntimeEnvironment {
  if (val === 'node-20' || val === 'node-22' || val === 'python-3.12' || val === 'docker' || val === 'bun-1') {
    return val;
  }
  return 'node-20';
}

function normalizeRestartPolicy(val: string | undefined): RestartPolicy {
  if (val === 'always' || val === 'on-failure' || val === 'never') {
    return val;
  }
  return 'always';
}

function normalizePlatform(val: string | undefined): BotPlatform {
  if (val === 'discord' || val === 'telegram' || val === 'whatsapp' || val === 'slack' || val === 'custom') {
    return val;
  }
  return 'custom';
}

function normalizeStatus(val: string | undefined): DeploymentStatus {
  if (val === 'online' || val === 'building' || val === 'scanning' || val === 'stopped' || val === 'failed') {
    return val;
  }
  return 'stopped';
}

function normalizePlanId(val: string | undefined): DeploymentPlanId {
  if (val === 'plan_15d' || val === 'plan_30d' || val === 'plan_unlimited') {
    return val;
  }
  return 'plan_15d';
}

function formatTimestampIso(val: unknown): string | undefined {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string') return val;
  return undefined;
}

export async function syncUserProfileToFirestore(
  firebaseUser: User,
  appUser: AuthUser,
  prefs: PlatformPreferences
): Promise<CloudUserProfileDoc | null> {
  if (!firebaseUser.email || !firebaseUser.emailVerified) return null;
  const uid = sanitizeId(firebaseUser.uid, 'usr');
  const path = `users/${uid}`;
  const ref = doc(db, 'users', uid);

  const defaultRegion = clampStr(prefs.defaultRegion, 'us-east', 2, 32);
  const defaultRestartPolicy = normalizeRestartPolicy(prefs.defaultRestartPolicy);
  const defaultRuntime = normalizeRuntime(prefs.defaultRuntime);
  const promoEmailsOptIn = Boolean(prefs.promoEmailsOptIn ?? appUser.promoEmailsOptIn);

  let existingSnap;
  try {
    existingSnap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (!existingSnap.exists()) {
    const isRootAdmin = firebaseUser.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
    const referralCode = sanitizeId(appUser.referralCode || `LYRI${uid.slice(0, 6)}`, 'LYRI').slice(0, 32);

    const createPayload = {
      uid,
      email: clampStr(firebaseUser.email, appUser.email, 5, 200),
      role: isRootAdmin ? ('admin' as const) : ('user' as const),
      coinBalance: isRootAdmin ? Math.max(0, Math.floor(appUser.coinBalance || 0)) : 0,
      unlimitedCoins: isRootAdmin,
      maxDeployments: isRootAdmin ? Math.min(10000, Math.max(5, Math.floor(appUser.maxDeployments || 100))) : 5,
      referralCode,
      acceptedTerms: true,
      defaultRegion,
      defaultRestartPolicy,
      defaultRuntime,
      promoEmailsOptIn,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    try {
      await setDoc(ref, createPayload);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }

    return {
      ...createPayload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    await updateDoc(ref, {
      defaultRegion,
      defaultRestartPolicy,
      defaultRuntime,
      promoEmailsOptIn,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }

  const data = existingSnap.data() as CloudUserProfileDoc;
  return {
    ...data,
    defaultRegion,
    defaultRestartPolicy,
    defaultRuntime,
    promoEmailsOptIn,
  };
}

export async function syncDeploymentToFirestore(
  firebaseUser: User,
  dep: BotDeployment
): Promise<void> {
  if (!firebaseUser.email || !firebaseUser.emailVerified) return;
  const depId = sanitizeId(dep.id, 'bot');
  const path = `deployments/${depId}`;
  const ref = doc(db, 'deployments', depId);

  let alreadyExists = false;
  try {
    const checkSnap = await getDocs(
      query(
        collection(db, 'deployments'),
        where('ownerUid', '==', firebaseUser.uid),
        where('id', '==', depId)
      )
    );
    alreadyExists = !checkSnap.empty;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'deployments');
  }

  const name = clampStr(dep.name, 'Lyrihost Bot', 1, 120);
  const branch = clampStr(dep.settings?.branch, 'main', 1, 100);
  const region = clampStr(dep.settings?.region, 'us-east', 2, 32);
  const runtime = normalizeRuntime(dep.settings?.runtime);
  const installCommand = clampStr(dep.settings?.installCommand ?? '', '', 0, 300);
  const buildCommand = clampStr(dep.settings?.buildCommand ?? '', '', 0, 300);
  const startCommand = clampStr(dep.settings?.startCommand, 'npm start', 1, 300);
  const restartPolicy = normalizeRestartPolicy(dep.settings?.restartPolicy);
  const status = normalizeStatus(dep.status);

  if (alreadyExists) {
    try {
      await updateDoc(ref, {
        name,
        branch,
        region,
        runtime,
        installCommand,
        buildCommand,
        startCommand,
        restartPolicy,
        status,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
    return;
  }

  const planId = normalizePlanId(dep.planId || dep.settings?.planId);
  const memoryLimitMb = Math.min(4096, Math.max(256, Math.round(dep.memoryLimitMb || 512)));
  const ownerEmail = clampStr(firebaseUser.email, dep.ownerEmail || 'operator@lyrihost.local', 5, 200);
  const repoUrl = clampStr(dep.repoUrl, 'https://github.com/lyrihost/bot', 10, 500);
  const repoFullName = clampStr(dep.repoFullName, 'lyrihost/bot', 3, 200);
  const platform = normalizePlatform(dep.platform);
  const framework = clampStr(dep.framework, 'Custom Bot', 1, 80);

  const createPayload = {
    id: depId,
    ownerUid: sanitizeId(firebaseUser.uid, 'usr'),
    ownerEmail,
    name,
    repoUrl,
    repoFullName,
    platform,
    framework,
    status,
    planId,
    memoryLimitMb,
    branch,
    region,
    runtime,
    installCommand,
    buildCommand,
    startCommand,
    restartPolicy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(ref, createPayload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function loadUserDeploymentsFromFirestore(
  firebaseUser: User,
  isRootAdmin = false
): Promise<CloudDeploymentSpec[]> {
  if (!firebaseUser.emailVerified) return [];
  const colRef = collection(db, 'deployments');
  const q = isRootAdmin && firebaseUser.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()
    ? query(colRef)
    : query(colRef, where('ownerUid', '==', firebaseUser.uid));

  try {
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const raw = d.data();
      return {
        id: String(raw.id || d.id),
        ownerUid: String(raw.ownerUid || ''),
        ownerEmail: String(raw.ownerEmail || ''),
        name: String(raw.name || ''),
        repoUrl: String(raw.repoUrl || ''),
        repoFullName: String(raw.repoFullName || ''),
        platform: normalizePlatform(raw.platform),
        framework: String(raw.framework || 'Custom Bot'),
        status: normalizeStatus(raw.status),
        planId: normalizePlanId(raw.planId),
        memoryLimitMb: Number(raw.memoryLimitMb || 512),
        branch: String(raw.branch || 'main'),
        region: String(raw.region || 'us-east'),
        runtime: normalizeRuntime(raw.runtime),
        installCommand: typeof raw.installCommand === 'string' ? raw.installCommand : '',
        buildCommand: typeof raw.buildCommand === 'string' ? raw.buildCommand : '',
        startCommand: String(raw.startCommand || 'npm start'),
        restartPolicy: normalizeRestartPolicy(raw.restartPolicy),
        createdAtIso: formatTimestampIso(raw.createdAt),
        updatedAtIso: formatTimestampIso(raw.updatedAt),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'deployments');
  }
}

export async function deleteDeploymentFromFirestore(depId: string): Promise<void> {
  const cleanId = sanitizeId(depId, 'bot');
  const path = `deployments/${cleanId}`;
  try {
    await deleteDoc(doc(db, 'deployments', cleanId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function syncTemplateToFirestore(
  firebaseUser: User,
  tpl: TemplateBotSpec
): Promise<void> {
  if (!firebaseUser.emailVerified) return;
  const tplId = sanitizeId(tpl.id, 'tpl');
  const path = `templates/${tplId}`;
  const ref = doc(db, 'templates', tplId);

  let existingSnap;
  try {
    existingSnap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  const mutableFields = {
    name: clampStr(tpl.name, 'Bot Template', 1, 120),
    repoFullName: clampStr(tpl.repoFullName, 'owner/repo', 3, 200),
    repoUrl: clampStr(tpl.repoUrl, 'https://github.com/owner/repo', 10, 500),
    description: clampStr(tpl.description, 'Verified Lyrihost bot template.', 3, 1000),
    platform: normalizePlatform(tpl.platform),
    framework: clampStr(tpl.framework, 'Baileys MD', 1, 80),
    runtime: normalizeRuntime(tpl.runtime),
    defaultBranch: clampStr(tpl.defaultBranch, 'main', 1, 100),
    installCommand: clampStr(tpl.installCommand ?? '', '', 0, 300),
    buildCommand: clampStr(tpl.buildCommand ?? '', '', 0, 300),
    startCommand: clampStr(tpl.startCommand, 'npm start', 1, 300),
    sessionPairUrl: clampStr(tpl.sessionPairUrl ?? '', '', 0, 500),
    imageUrl: clampStr(tpl.imageUrl ?? '', '', 0, 500),
    updatedAt: serverTimestamp(),
  };

  if (existingSnap.exists()) {
    try {
      await updateDoc(ref, mutableFields);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
    return;
  }

  try {
    await setDoc(ref, {
      id: tplId,
      ...mutableFields,
      createdByUid: sanitizeId(firebaseUser.uid, 'adm'),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function loadTemplatesFromFirestore(): Promise<TemplateBotSpec[]> {
  try {
    const snap = await getDocs(collection(db, 'templates'));
    return snap.docs.map((d) => {
      const raw = d.data();
      const pairUrl = typeof raw.sessionPairUrl === 'string' ? raw.sessionPairUrl : '';
      let pairHost = '';
      if (pairUrl) {
        try {
          pairHost = new URL(pairUrl).hostname;
        } catch {
          pairHost = '';
        }
      }
      const name = String(raw.name || 'Bot Template');
      return {
        id: String(raw.id || d.id),
        name,
        repoFullName: String(raw.repoFullName || ''),
        repoUrl: String(raw.repoUrl || ''),
        sessionPairUrl: pairUrl,
        sessionPairHost: pairHost,
        description: String(raw.description || ''),
        imageUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : '',
        imageAlt: `${name} bot template banner`,
        platform: normalizePlatform(raw.platform),
        framework: String(raw.framework || 'Baileys MD'),
        runtime: normalizeRuntime(raw.runtime),
        defaultBranch: String(raw.defaultBranch || 'main'),
        installCommand: String(raw.installCommand || ''),
        buildCommand: String(raw.buildCommand || ''),
        startCommand: String(raw.startCommand || 'npm start'),
        defaultEnvVars: [],
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'templates');
  }
}

export async function syncTicketToFirestore(
  firebaseUser: User,
  ticket: SupportTicket
): Promise<void> {
  if (!firebaseUser.email || !firebaseUser.emailVerified) return;
  const ticketId = sanitizeId(ticket.id, 'tkt');
  const path = `tickets/${ticketId}`;
  const ref = doc(db, 'tickets', ticketId);

  let alreadyExists = false;
  let existingStatus: SupportTicketStatus = 'open';
  try {
    const checkSnap = await getDocs(
      query(
        collection(db, 'tickets'),
        where('ownerUid', '==', firebaseUser.uid),
        where('id', '==', ticketId)
      )
    );
    if (!checkSnap.empty) {
      alreadyExists = true;
      existingStatus = (checkSnap.docs[0].data().status || 'open') as SupportTicketStatus;
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'tickets');
  }

  const validCategory: SupportTicketCategory =
    ticket.category === 'complaint' ||
    ticket.category === 'billing' ||
    ticket.category === 'bug' ||
    ticket.category === 'feature' ||
    ticket.category === 'other'
      ? ticket.category
      : 'complaint';

  const validPriority: SupportTicketPriority =
    ticket.priority === 'normal' || ticket.priority === 'high' || ticket.priority === 'urgent'
      ? ticket.priority
      : 'normal';

  const subject = clampStr(ticket.subject, 'Support Inquiry', 2, 200);
  const message = clampStr(ticket.message, 'Support inquiry submitted.', 3, 4000);

  if (alreadyExists) {
    if (existingStatus === 'resolved') return;
    try {
      await updateDoc(ref, {
        subject,
        message,
        priority: validPriority,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
    return;
  }

  try {
    await setDoc(ref, {
      id: ticketId,
      ownerUid: sanitizeId(firebaseUser.uid, 'usr'),
      userEmail: clampStr(firebaseUser.email, ticket.userEmail, 5, 200),
      category: validCategory,
      priority: validPriority,
      subject,
      message,
      status: 'open',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function loadTicketsFromFirestore(
  firebaseUser: User,
  isRootAdmin = false
): Promise<SupportTicket[]> {
  if (!firebaseUser.emailVerified) return [];
  const colRef = collection(db, 'tickets');
  const q = isRootAdmin && firebaseUser.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()
    ? query(colRef)
    : query(colRef, where('ownerUid', '==', firebaseUser.uid));

  try {
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const raw = d.data();
      const createdAt = formatTimestampIso(raw.createdAt) || new Date().toISOString();
      const updatedAt = formatTimestampIso(raw.updatedAt) || createdAt;
      return {
        id: String(raw.id || d.id),
        userId: String(raw.ownerUid || ''),
        userEmail: String(raw.userEmail || ''),
        category: (raw.category || 'complaint') as SupportTicketCategory,
        priority: (raw.priority || 'normal') as SupportTicketPriority,
        subject: String(raw.subject || ''),
        message: String(raw.message || ''),
        status: (raw.status || 'open') as SupportTicketStatus,
        adminReply: typeof raw.adminReply === 'string' ? raw.adminReply : null,
        repliedAt: null,
        createdAt,
        updatedAt,
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'tickets');
  }
}
