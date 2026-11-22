'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

/**
 * 1. Runtime FS guard for WhatsApp MD / Baileys bots that call rmdir/rmdirSync
 * on active non-empty session directories and crash with ENOTEMPTY.
 * Uses the original unpatched rmdir primitives during recursive cleanup
 * so Node's internal rimraf implementation can never recurse infinitely.
 */
function isNotEmptyError(err) {
  return Boolean(err && (err.code === 'ENOTEMPTY' || err.code === 'EEXIST'));
}

const origRmdirSync = fs.rmdirSync.bind(fs);
const origRmdir = fs.rmdir.bind(fs);
const origPromisesRmdir =
  fs.promises && typeof fs.promises.rmdir === 'function'
    ? fs.promises.rmdir.bind(fs.promises)
    : null;

function forceRemoveDirSync(targetPath) {
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      forceRemoveDirSync(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  }
  origRmdirSync(targetPath);
}

async function forceRemoveDirAsync(targetPath) {
  const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      await forceRemoveDirAsync(fullPath);
    } else {
      await fs.promises.unlink(fullPath);
    }
  }
  if (origPromisesRmdir) {
    await origPromisesRmdir(targetPath);
  } else {
    origRmdirSync(targetPath);
  }
}

fs.rmdirSync = function patchedRmdirSync(targetPath, options) {
  try {
    return origRmdirSync(targetPath, options);
  } catch (err) {
    if (isNotEmptyError(err)) {
      return forceRemoveDirSync(String(targetPath));
    }
    throw err;
  }
};

fs.rmdir = function patchedRmdir(targetPath, optionsOrCb, maybeCb) {
  const hasOptions = typeof optionsOrCb === 'object' && optionsOrCb !== null;
  const cb = hasOptions ? maybeCb : optionsOrCb;
  const wrappedCb = (err, ...rest) => {
    if (isNotEmptyError(err)) {
      forceRemoveDirAsync(String(targetPath))
        .then(() => {
          if (typeof cb === 'function') cb(null);
        })
        .catch((rmErr) => {
          if (typeof cb === 'function') cb(rmErr);
        });
      return;
    }
    if (typeof cb === 'function') cb(err, ...rest);
  };

  if (hasOptions) {
    return origRmdir(targetPath, optionsOrCb, wrappedCb);
  }
  return origRmdir(targetPath, wrappedCb);
};

if (origPromisesRmdir) {
  fs.promises.rmdir = async function patchedPromisesRmdir(targetPath, options) {
    try {
      return await origPromisesRmdir(targetPath, options);
    } catch (err) {
      if (isNotEmptyError(err)) {
        return forceRemoveDirAsync(String(targetPath));
      }
      throw err;
    }
  };
}

const origWriteFileSync = fs.writeFileSync.bind(fs);
fs.writeFileSync = function patchedWriteFileSync(file, data, options) {
  try {
    return origWriteFileSync(file, data, options);
  } catch (err) {
    if (err && err.code === 'ENOENT' && typeof file === 'string') {
      const dir = path.dirname(file);
      if (dir && dir !== '.') {
        fs.mkdirSync(dir, { recursive: true });
        return origWriteFileSync(file, data, options);
      }
    }
    throw err;
  }
};

/**
 * 2. Transient Baileys WebSocket & background interval rejection guard.
 */
function isTransientSocketError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = err.output && err.output.statusCode;
  if (code === 408 || code === 428 || code === 503) return true;
  const sysCode = err.code;
  if (
    sysCode === 'ETIMEDOUT' ||
    sysCode === 'ECONNRESET' ||
    sysCode === 'EPIPE' ||
    sysCode === 'EAI_AGAIN'
  ) {
    return true;
  }
  const msg = typeof err.message === 'string' ? err.message : '';
  return (
    /Timed Out|Connection Closed|Stream Errored|WebSocket is not open|socket hang up/i.test(msg) &&
    (err.isBoom === true || /baileys|socket|timeout|connection/i.test(String(err.stack || msg)))
  );
}

let lastTransientLogAt = 0;
function logTransientNotice(err) {
  const now = Date.now();
  if (now - lastTransientLogAt < 30000) return;
  lastTransientLogAt = now;
  const code = (err && err.output && err.output.statusCode) || '';
  const msg = (err && err.message) || 'Socket unavailable';
  console.warn(`[runtime] Suppressed transient WhatsApp socket retry (${code ? `${code} ` : ''}${msg}).`);
}

let cachedWaVersion = [2, 3000, 1055798384];
let versionRefreshStarted = false;
let swRefreshTimerStarted = false;
let loggedVersionUpgrade = false;
let activeRefreshPromise = null;
let lastVersionFetchAt = 0;

function compareWaVersions(a, b) {
  const va = Array.isArray(a) ? a.map((n) => Number(n) || 0) : [0, 0, 0];
  const vb = Array.isArray(b) ? b.map((n) => Number(n) || 0) : [0, 0, 0];
  const len = Math.max(va.length, vb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = va[i] || 0;
    const db = vb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function updateCachedWaVersion(candidate) {
  if (!Array.isArray(candidate) || candidate.length < 3) return;
  const normalized = [Number(candidate[0]) || 0, Number(candidate[1]) || 0, Number(candidate[2]) || 0];
  if (normalized[0] >= 2 && normalized[2] > 0 && compareWaVersions(normalized, cachedWaVersion) > 0) {
    cachedWaVersion = normalized;
  }
}

function fetchHttpsText(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const https = require('node:https');
      const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.on('data', (chunk) => {
          if (body.length < 300000) body += chunk.toString('utf8');
        });
        res.on('end', () => resolve(body));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {}
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

function refreshWaVersionFromWhatsAppWeb(force = false) {
  const now = Date.now();
  if (!force && activeRefreshPromise) return activeRefreshPromise;
  if (!force && now - lastVersionFetchAt < 60000) {
    return Promise.resolve(cachedWaVersion);
  }
  lastVersionFetchAt = now;

  activeRefreshPromise = (async () => {
    try {
      const swBody = await fetchHttpsText(
        'https://web.whatsapp.com/sw.js',
        {
          'sec-fetch-site': 'none',
          'sec-fetch-mode': 'no-cors',
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        4000
      );
      if (swBody) {
        const match =
          swBody.match(/client_revision\\?":(\d{8,12})/) ||
          swBody.match(/"client_revision":(\d{8,12})/);
        if (match) {
          const rev = Number.parseInt(match[1], 10);
          if (Number.isFinite(rev) && rev > 0) {
            updateCachedWaVersion([2, 3000, rev]);
            return cachedWaVersion;
          }
        }
      }

      // Secondary fallback from wppconnect-team/wa-version metadata
      const waJson = await fetchHttpsText(
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json',
        { 'User-Agent': 'Node.js' },
        4000
      );
      if (waJson) {
        const parsed = JSON.parse(waJson);
        const versions = Array.isArray(parsed && parsed.versions) ? parsed.versions : [];
        for (let i = versions.length - 1; i >= 0; i--) {
          const entry = versions[i];
          const verStr = entry && typeof entry.version === 'string' ? entry.version : '';
          const parts = verStr.split('.').map((n) => Number.parseInt(n, 10));
          if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
            updateCachedWaVersion(parts.slice(0, 3));
            break;
          }
        }
      }
    } catch {
      // ignore background fetch error
    } finally {
      activeRefreshPromise = null;
    }
    return cachedWaVersion;
  })();

  return activeRefreshPromise;
}

function ensureFreshWaVersion(maxWaitMs = 2500) {
  const p = refreshWaVersionFromWhatsAppWeb(false);
  return withFastTimeout(p, maxWaitMs).then(() => cachedWaVersion);
}

refreshWaVersionFromWhatsAppWeb(true);
if (!swRefreshTimerStarted) {
  swRefreshTimerStarted = true;
  const swRefreshTimer = setInterval(() => refreshWaVersionFromWhatsAppWeb(true), 6 * 60 * 60 * 1000);
  if (typeof swRefreshTimer.unref === 'function') swRefreshTimer.unref();
}

function wrapVersionFetcher(origFn) {
  if (typeof origFn !== 'function' || origFn.__lyrihostVersionWrapped) return origFn;
  const wrapped = async function lyrihostWrappedVersionFetcher(...args) {
    const [freshRes, origRes] = await Promise.all([
      ensureFreshWaVersion(2500).catch(() => cachedWaVersion),
      Promise.resolve()
        .then(() => origFn.apply(this, args))
        .catch(() => null),
    ]);
    if (origRes && Array.isArray(origRes.version) && origRes.version.length >= 3) {
      updateCachedWaVersion(origRes.version);
    }
    const best =
      Array.isArray(freshRes) && compareWaVersions(freshRes, cachedWaVersion) > 0
        ? freshRes
        : cachedWaVersion;
    return {
      ...(origRes && typeof origRes === 'object' ? origRes : {}),
      version: [...best],
      isLatest: true,
    };
  };
  wrapped.__lyrihostVersionWrapped = true;
  return wrapped;
}

function refreshWaVersionFromModule(loaded) {
  if (versionRefreshStarted || !loaded || typeof loaded !== 'object') return;
  versionRefreshStarted = true;
  if (typeof loaded.fetchLatestWaWebVersion === 'function') {
    Promise.resolve(loaded.fetchLatestWaWebVersion({}))
      .then((res) => {
        if (res && Array.isArray(res.version)) updateCachedWaVersion(res.version);
      })
      .catch(() => {});
  }
  if (typeof loaded.fetchLatestBaileysVersion === 'function') {
    Promise.resolve(loaded.fetchLatestBaileysVersion())
      .then((res) => {
        if (res && Array.isArray(res.version)) updateCachedWaVersion(res.version);
      })
      .catch(() => {});
  }
}

function isStaleWaVersion(v) {
  if (!Array.isArray(v) || v.length < 3) return true;
  return compareWaVersions(v, cachedWaVersion) < 0;
}

function toBareJid(jid) {
  if (typeof jid !== 'string') return jid;
  const match = jid.match(/^([^:@]+)(?::\d+)?@(.+)$/);
  return match ? `${match[1]}@${match[2]}` : jid;
}

function unwrapBaileysMessageContent(content) {
  let curr = content;
  for (let i = 0; i < 6 && curr && typeof curr === 'object'; i++) {
    if (curr.ephemeralMessage && curr.ephemeralMessage.message) {
      curr = curr.ephemeralMessage.message;
      continue;
    }
    if (curr.deviceSentMessage && curr.deviceSentMessage.message) {
      curr = curr.deviceSentMessage.message;
      continue;
    }
    if (curr.viewOnceMessage && curr.viewOnceMessage.message) {
      curr = curr.viewOnceMessage.message;
      continue;
    }
    if (curr.viewOnceMessageV2 && curr.viewOnceMessageV2.message) {
      curr = curr.viewOnceMessageV2.message;
      continue;
    }
    if (curr.viewOnceMessageV2Extension && curr.viewOnceMessageV2Extension.message) {
      curr = curr.viewOnceMessageV2Extension.message;
      continue;
    }
    if (curr.documentWithCaptionMessage && curr.documentWithCaptionMessage.message) {
      curr = curr.documentWithCaptionMessage.message;
      continue;
    }
    if (
      curr.editedMessage &&
      curr.editedMessage.message &&
      curr.editedMessage.message.protocolMessage &&
      curr.editedMessage.message.protocolMessage.editedMessage
    ) {
      curr = curr.editedMessage.message.protocolMessage.editedMessage;
      continue;
    }
    break;
  }
  return curr;
}

function extractReadableText(msgContent) {
  if (!msgContent || typeof msgContent !== 'object') return '';
  return (
    msgContent.conversation ||
    (msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
    (msgContent.imageMessage && msgContent.imageMessage.caption) ||
    (msgContent.videoMessage && msgContent.videoMessage.caption) ||
    (msgContent.documentMessage && msgContent.documentMessage.caption) ||
    ''
  );
}

function syncSocketUserJid(sock) {
  if (sock && sock.user && typeof sock.user.id === 'string' && !sock.user.jid) {
    sock.user.jid = toBareJid(sock.user.id);
  }
}

const normalizedMessageSet = new WeakSet();
const loggedIncomingKeys = new Set();

function recordIncomingLogOnce(keyId) {
  if (!keyId) return true;
  if (loggedIncomingKeys.has(keyId)) return false;
  loggedIncomingKeys.add(keyId);
  if (loggedIncomingKeys.size > 500) {
    const oldest = loggedIncomingKeys.values().next().value;
    if (oldest !== undefined) loggedIncomingKeys.delete(oldest);
  }
  return true;
}

function normalizeIncomingChatUpdate(sock, chatUpdate) {
  if (!chatUpdate || !Array.isArray(chatUpdate.messages)) return [chatUpdate];
  syncSocketUserJid(sock);

  const ownBarePhoneJid = sock && sock.user && sock.user.id ? toBareJid(sock.user.id) : null;
  const ownBareLid = sock && sock.user && sock.user.lid ? toBareJid(sock.user.lid) : null;
  // Baileys v7+ exposes signalRepository.lidMapping and requires msg.key.remoteJid to keep @lid addressing intact
  const supportsNativeLid = Boolean(
    sock && sock.signalRepository && sock.signalRepository.lidMapping
  );

  const normalizedMessages = [];
  for (const rawMsg of chatUpdate.messages) {
    if (!rawMsg || typeof rawMsg !== 'object') continue;
    const msg = rawMsg;

    if (!normalizedMessageSet.has(msg)) {
      normalizedMessageSet.add(msg);

      if (msg.message) {
        msg.message = unwrapBaileysMessageContent(msg.message);
      }

      // Only rewrite own @lid JIDs on legacy Baileys v6 sockets lacking lidMapping support
      if (msg.key && !supportsNativeLid) {
        if (ownBareLid && ownBarePhoneJid) {
          if (toBareJid(msg.key.remoteJid) === ownBareLid) {
            msg.key.remoteJid = ownBarePhoneJid;
          }
          if (toBareJid(msg.key.participant) === ownBareLid) {
            msg.key.participant = ownBarePhoneJid;
          }
        }
        if (
          msg.key.fromMe &&
          ownBarePhoneJid &&
          typeof msg.key.remoteJid === 'string' &&
          msg.key.remoteJid.endsWith('@lid') &&
          typeof msg.key.remoteJidAlt === 'string' &&
          toBareJid(msg.key.remoteJidAlt) === ownBarePhoneJid
        ) {
          msg.key.remoteJid = ownBarePhoneJid;
        }
        if (
          msg.key.fromMe &&
          ownBarePhoneJid &&
          typeof msg.key.participant === 'string' &&
          msg.key.participant.endsWith('@lid') &&
          typeof msg.key.participantAlt === 'string' &&
          toBareJid(msg.key.participantAlt) === ownBarePhoneJid
        ) {
          msg.key.participant = ownBarePhoneJid;
        }
      }
    }

    if (!msg.message) continue;
    const keys = Object.keys(msg.message).filter(
      (k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage'
    );
    if (keys.length === 0) continue;

    normalizedMessages.push(msg);
  }

  if (normalizedMessages.length === 0) return [];

  // Many Baileys bots read only chatUpdate.messages[0]; split batches so commands are never dropped
  return normalizedMessages.map((msg) => {
    const preview = extractReadableText(msg.message).trim();
    if (preview && chatUpdate.type === 'notify') {
      const chatLabel =
        (msg.key && (msg.key.remoteJidAlt || msg.key.remoteJid)) || 'unknown';
      const dedupeKey =
        (msg.key && msg.key.id) ||
        `${chatLabel}:${msg.messageTimestamp || ''}:${preview.slice(0, 24)}`;
      if (recordIncomingLogOnce(dedupeKey)) {
        console.log(
          `[runtime] WhatsApp message from ${chatLabel}: ${preview.slice(0, 48)}${preview.length > 48 ? '...' : ''}`
        );
      }
    }
    return {
      ...chatUpdate,
      messages: [msg],
    };
  });
}

function withFastTimeout(promise, ms) {
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__LYRIHOST_TIMEOUT__'), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function wrapSocketFactory(fn) {
  if (typeof fn !== 'function' || fn.__lyrihostWrapped) return fn;
  const wrapped = function lyrihostWrappedMakeWASocket(...args) {
    const nextArgs = [...args];
    if (nextArgs[0] && typeof nextArgs[0] === 'object') {
      const cfg = { ...nextArgs[0] };
      if (isStaleWaVersion(cfg.version)) {
        if (!loggedVersionUpgrade) {
          loggedVersionUpgrade = true;
          console.log(
            `[runtime] Using latest WhatsApp Web client version [${cachedWaVersion.join(', ')}] (preventing 405 rejection).`
          );
        }
        cfg.version = cachedWaVersion;
      }
      // Some bots pass boolean true instead of predicate functions required by Baileys 6.7+
      if (typeof cfg.shouldSyncHistoryMessage === 'boolean') {
        const allowHistory = cfg.shouldSyncHistoryMessage;
        cfg.shouldSyncHistoryMessage = () => allowHistory;
      }
      if (typeof cfg.shouldIgnoreJid === 'boolean') {
        const ignoreVal = cfg.shouldIgnoreJid;
        cfg.shouldIgnoreJid = () => ignoreVal;
      }
      // Low-latency & anti-sleep Baileys socket tuning without breaking USync/session queries
      if (!cfg.connectTimeoutMs || cfg.connectTimeoutMs < 20000 || cfg.connectTimeoutMs > 45000) {
        cfg.connectTimeoutMs = 25000;
      }
      if (cfg.defaultQueryTimeoutMs === undefined || cfg.defaultQueryTimeoutMs > 45000) {
        cfg.defaultQueryTimeoutMs = 35000;
      }
      if (!cfg.keepAliveIntervalMs || cfg.keepAliveIntervalMs > 15000) {
        cfg.keepAliveIntervalMs = 15000;
      }
      if (cfg.retryRequestDelayMs === undefined || cfg.retryRequestDelayMs > 350) {
        cfg.retryRequestDelayMs = 250;
      }
      if (cfg.maxMsgRetryCount === undefined || cfg.maxMsgRetryCount > 5) {
        cfg.maxMsgRetryCount = 4;
      }
      if (cfg.syncFullHistory === undefined) {
        cfg.syncFullHistory = false;
      }
      if (typeof cfg.markOnlineOnConnect !== 'boolean') {
        cfg.markOnlineOnConnect = false;
      }
      nextArgs[0] = cfg;
    }

    const sock = fn.apply(this, nextArgs);
    if (sock && typeof sock === 'object') {
      syncSocketUserJid(sock);

      const isSocketOpen = () => {
        if (!sock.user) return false;
        const ws = sock.ws;
        if (!ws) return true;
        if (typeof ws.isOpen === 'boolean') return ws.isOpen;
        if (typeof ws.readyState === 'number') return ws.readyState === 1;
        return true;
      };

      // Cache groupMetadata for 20s to eliminate 1-4s per-command WhatsApp IQ lag
      const groupMetaCache = new Map();
      const groupMetaInFlight = new Map();
      const invalidateGroupCache = (jid) => {
        if (typeof jid === 'string' && jid) {
          groupMetaCache.delete(jid);
        }
      };

      if (typeof sock.groupMetadata === 'function' && !sock.groupMetadata.__lyrihostCached) {
        const origGroupMetadata = sock.groupMetadata.bind(sock);
        const cachedGroupMetadata = async (jid) => {
          if (typeof jid !== 'string' || !jid) {
            return origGroupMetadata(jid);
          }
          const now = Date.now();
          const cached = groupMetaCache.get(jid);
          if (cached && cached.expiresAt > now) {
            return cached.data;
          }
          if (groupMetaInFlight.has(jid)) {
            return groupMetaInFlight.get(jid);
          }
          const fetchPromise = (async () => {
            try {
              const result = await withFastTimeout(origGroupMetadata(jid), 8000);
              if (result === '__LYRIHOST_TIMEOUT__') {
                if (cached) return cached.data;
                throw new Error(`groupMetadata timed out for ${jid}`);
              }
              if (result && typeof result === 'object') {
                groupMetaCache.set(jid, { data: result, expiresAt: Date.now() + 20000 });
              }
              return result;
            } catch (err) {
              if (cached && isTransientSocketError(err)) {
                return cached.data;
              }
              throw err;
            } finally {
              groupMetaInFlight.delete(jid);
            }
          })();
          groupMetaInFlight.set(jid, fetchPromise);
          return fetchPromise;
        };
        cachedGroupMetadata.__lyrihostCached = true;
        sock.groupMetadata = cachedGroupMetadata;
      }

      // Guard non-critical ack/presence calls with fast 3s timeout so slow WA ACKs never stall bot replies
      for (const method of ['updateProfileStatus', 'sendPresenceUpdate', 'readMessages']) {
        if (typeof sock[method] === 'function' && !sock[method].__lyrihostGuarded) {
          const origMethod = sock[method].bind(sock);
          const guardedMethod = async (...mArgs) => {
            if (!isSocketOpen()) return undefined;
            try {
              const res = await withFastTimeout(origMethod(...mArgs), 3000);
              return res === '__LYRIHOST_TIMEOUT__' ? undefined : res;
            } catch (err) {
              if (isTransientSocketError(err)) {
                logTransientNotice(err);
                return undefined;
              }
              throw err;
            }
          };
          guardedMethod.__lyrihostGuarded = true;
          sock[method] = guardedMethod;
        }
      }

      // Guard sendMessage with a generous 45s timeout, startup-banner cooldown, and dispatch error reporting
      const startupStateFile = path.join(process.cwd(), '.lyrihost_startup_state.json');
      const startupCooldownMs = (() => {
        const raw = Number.parseInt(process.env.LYRIHOST_STARTUP_COOLDOWN_MS || '', 10);
        return Number.isFinite(raw) && raw >= 0 ? raw : 6 * 60 * 60 * 1000;
      })();

      let lastSocketOpenAt = 0;
      let lastIncomingCommandAt = 0;
      let lastSocketActivityAt = Date.now();

      const readStartupState = () => {
        try {
          if (fs.existsSync(startupStateFile)) {
            const parsed = JSON.parse(fs.readFileSync(startupStateFile, 'utf8'));
            if (parsed && typeof parsed === 'object') return parsed;
          }
        } catch {
          // ignore corrupted startup cache
        }
        return { sentAt: 0, textSample: '' };
      };

      const writeStartupState = (sentAt, textSample) => {
        try {
          origWriteFileSync(
            startupStateFile,
            JSON.stringify({ sentAt, textSample: String(textSample || '').slice(0, 120) }),
            'utf8'
          );
        } catch {
          // ignore non-writable cwd
        }
      };

      const extractOutgoingText = (content) => {
        if (!content || typeof content !== 'object') return '';
        if (typeof content.text === 'string') return content.text;
        if (typeof content.caption === 'string') return content.caption;
        return '';
      };

      const shouldSuppressStartupGreeting = (targetJid, content, options) => {
        if (!startupCooldownMs || typeof targetJid !== 'string') return false;
        if (options && typeof options === 'object' && options.quoted) return false;
        if (content && typeof content === 'object' && content.react) return false;

        const ownBarePhone = sock.user && sock.user.id ? toBareJid(sock.user.id) : null;
        const ownBareLid = sock.user && sock.user.lid ? toBareJid(sock.user.lid) : null;
        const bareTarget = toBareJid(targetJid);
        const isSelfChat =
          (ownBarePhone && bareTarget === ownBarePhone) ||
          (ownBareLid && bareTarget === ownBareLid);
        if (!isSelfChat) return false;

        const now = Date.now();
        // Only treat as a startup greeting if emitted shortly after socket open with no recent user command
        if (now - lastSocketOpenAt > 20000) return false;
        if (now - lastIncomingCommandAt < 5000) return false;

        const text = extractOutgoingText(content).trim();
        const sample = text.slice(0, 120);
        const looksLikeStartupBanner =
          /connected|online|mode\s*[: ]|prefix|hosting\.|started|deploy|alive|keith-md|elite-pro|cypherx|toxic|sila-md|turbofex|vanguard|dave-x|ultra-guru|bwm-xmd/i.test(
            text
          );

        const prev = readStartupState();
        const sameBannerAsBefore = Boolean(sample && prev.textSample && prev.textSample === sample);
        if (!looksLikeStartupBanner && !sameBannerAsBefore) return false;

        if (prev.sentAt && now - Number(prev.sentAt) < startupCooldownMs) {
          return true;
        }
        writeStartupState(now, sample);
        return false;
      };

      if (typeof sock.sendMessage === 'function' && !sock.sendMessage.__lyrihostGuarded) {
        const origSendMessage = sock.sendMessage.bind(sock);
        let lastSendErrLogAt = 0;
        let lastCooldownLogAt = 0;
        const guardedSendMessage = async (jid, content, options, ...restArgs) => {
          if (shouldSuppressStartupGreeting(jid, content, options)) {
            const now = Date.now();
            if (now - lastCooldownLogAt > 60000) {
              lastCooldownLogAt = now;
              console.log('[runtime] Startup greeting cooldown active (6h); skipped duplicate self-chat startup banner.');
            }
            return {
              key: { remoteJid: jid, fromMe: true, id: `lyrihost-cooldown-${now}` },
              status: 1,
            };
          }
          try {
            const res = await withFastTimeout(
              origSendMessage(jid, content, options, ...restArgs),
              45000
            );
            if (res === '__LYRIHOST_TIMEOUT__') {
              throw new Error('WhatsApp sendMessage timed out after 45s');
            }
            return res;
          } catch (err) {
            const now = Date.now();
            if (now - lastSendErrLogAt > 5000) {
              lastSendErrLogAt = now;
              const rawMsg = err && err.message ? String(err.message) : String(err || 'Unknown error');
              console.warn(`[runtime] WhatsApp reply dispatch warning: ${rawMsg.slice(0, 140)}`);
            }
            throw err;
          }
        };
        guardedSendMessage.__lyrihostGuarded = true;
        sock.sendMessage = guardedSendMessage;
      }

      if (typeof globalThis.__lyrihostClearSocketKeepalive === 'function') {
        try {
          globalThis.__lyrihostClearSocketKeepalive();
        } catch {
          // ignore
        }
      }

      let lastLoggedConnState = '';
      let hasEverOpened = false;
      let closedSince = 0;
      let loggedOutPermanently = false;
      let hasSeenPong = false;
      let hasNoisePingSucceeded = false;
      let missedPongs = 0;
      let missedNoisePings = 0;
      let noisePingInFlight = false;
      let noisePingSeq = 0;
      let bufferingCycles = 0;
      const pongBoundSockets = new WeakSet();

      const getRawWs = () => {
        const ws = sock.ws;
        if (!ws) return null;
        return ws.socket && typeof ws.socket === 'object' ? ws.socket : ws;
      };

      const markSocketActive = () => {
        lastSocketActivityAt = Date.now();
        missedPongs = 0;
        missedNoisePings = 0;
      };

      const bindPongListener = () => {
        const ws = sock.ws;
        const rawWs = getRawWs();
        for (const candidate of [rawWs, ws]) {
          if (candidate && typeof candidate.on === 'function' && !pongBoundSockets.has(candidate)) {
            pongBoundSockets.add(candidate);
            candidate.on('pong', () => {
              hasSeenPong = true;
              markSocketActive();
            });
            candidate.on('message', () => {
              markSocketActive();
            });
          }
        }
      };

      const recycleZombieSocket = (reason) => {
        missedPongs = 0;
        missedNoisePings = 0;
        console.warn(`[runtime] ${reason}; recycling WhatsApp socket cleanly...`);
        const ws = sock.ws;
        const rawWs = getRawWs();
        try {
          if (rawWs && typeof rawWs.terminate === 'function') {
            rawWs.terminate();
          } else if (ws && typeof ws.close === 'function') {
            ws.close();
          } else if (typeof sock.end === 'function') {
            sock.end(new Error(reason));
          }
        } catch {
          // ignore socket termination failure
        }
      };

      // Active 15s WebSocket + WhatsApp Noise IQ keepalive (stops 10-min NAT & WhatsApp edge silence)
      const keepaliveTimer = setInterval(() => {
        if (loggedOutPermanently) {
          clearInterval(keepaliveTimer);
          return;
        }
        // Only flush event buffer if it remains stuck buffering across multiple 15s cycles
        try {
          if (sock.ev && typeof sock.ev.isBuffering === 'function' && sock.ev.isBuffering()) {
            bufferingCycles += 1;
            if (bufferingCycles >= 2 && typeof sock.ev.flush === 'function') {
              bufferingCycles = 0;
              sock.ev.flush();
              console.warn('[runtime] Flushed stalled WhatsApp event buffer.');
            }
          } else {
            bufferingCycles = 0;
          }
        } catch {
          // ignore flush guard error
        }

        const ws = sock.ws;
        const rawWs = getRawWs();
        const wsOpen = Boolean(
          (rawWs && rawWs.readyState === 1) || (ws && (ws.isOpen === true || ws.readyState === 1))
        );

        if (wsOpen && hasEverOpened) {
          closedSince = 0;
          bindPongListener();

          // If real WhatsApp frames/messages/pongs arrived recently, socket is 100% healthy
          const idleMs = Date.now() - lastSocketActivityAt;
          if (idleMs < 35000) {
            missedPongs = 0;
            missedNoisePings = 0;
          }

          if (rawWs && typeof rawWs.ping === 'function') {
            if (hasSeenPong && missedPongs >= 4 && idleMs > 45000) {
              recycleZombieSocket('WhatsApp raw WebSocket stopped responding to RFC-6455 pings');
              return;
            }
            if (hasSeenPong) missedPongs += 1;
            try {
              rawWs.ping();
            } catch {
              if (hasSeenPong) missedPongs += 1;
            }
          }

          // Encrypted WhatsApp Noise IQ ping using canonical '@s.whatsapp.net' JID
          if (sock.user && typeof sock.query === 'function' && !noisePingInFlight) {
            noisePingInFlight = true;
            const pingId =
              typeof sock.generateMessageTag === 'function'
                ? sock.generateMessageTag()
                : `lyri-ping-${++noisePingSeq}`;
            withFastTimeout(
              sock.query({
                tag: 'iq',
                attrs: { id: pingId, to: '@s.whatsapp.net', type: 'get', xmlns: 'w:p' },
                content: [{ tag: 'ping', attrs: {} }],
              }),
              9000
            )
              .then((res) => {
                if (res === '__LYRIHOST_TIMEOUT__') {
                  if (hasNoisePingSucceeded) missedNoisePings += 1;
                  if (hasNoisePingSucceeded && missedNoisePings >= 4 && Date.now() - lastSocketActivityAt > 45000) {
                    recycleZombieSocket('WhatsApp Noise IQ ping timed out repeatedly (silent zombie session)');
                  }
                } else {
                  hasNoisePingSucceeded = true;
                  markSocketActive();
                }
              })
              .catch(() => {
                if (hasNoisePingSucceeded) missedNoisePings += 1;
                if (hasNoisePingSucceeded && missedNoisePings >= 4 && Date.now() - lastSocketActivityAt > 45000) {
                  recycleZombieSocket('WhatsApp Noise IQ ping failed repeatedly');
                }
              })
              .finally(() => {
                noisePingInFlight = false;
              });
          }
        } else if (!wsOpen && hasEverOpened) {
          if (closedSince === 0) closedSince = Date.now();
          if (Date.now() - closedSince > 120000) {
            closedSince = Date.now();
            console.warn('[runtime] WhatsApp socket stalled offline for 120s; exiting for clean supervisor recovery...');
            clearInterval(keepaliveTimer);
            process.exit(1);
          }
        }
      }, 15000);
      if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();

      globalThis.__lyrihostClearSocketKeepalive = () => clearInterval(keepaliveTimer);

      const logConnUpdate = (update) => {
        if (!update || typeof update !== 'object') return;
        const conn = update.connection;
        if (conn === 'open') {
          hasEverOpened = true;
          lastSocketOpenAt = Date.now();
          closedSince = 0;
          bufferingCycles = 0;
          markSocketActive();
          bindPongListener();
          if (lastLoggedConnState !== 'open') {
            lastLoggedConnState = 'open';
            const jid = (sock.user && (sock.user.jid || sock.user.id)) || 'linked device';
            console.log(`[runtime] WhatsApp socket connected as ${jid}.`);
          }
        } else if (update.qr && lastLoggedConnState !== 'qr') {
          lastLoggedConnState = 'qr';
          closedSince = 0;
          console.log('[runtime] QR code generated — scan via WhatsApp > Linked Devices or set a valid SESSION_ID.');
        } else if (conn === 'close') {
          lastLoggedConnState = 'close';
          const lastErr = update.lastDisconnect && update.lastDisconnect.error;
          const statusCode =
            lastErr && lastErr.output && lastErr.output.statusCode;
          const errMsg = lastErr && lastErr.message ? String(lastErr.message) : '';
          if (statusCode === 401 || statusCode === 403) {
            loggedOutPermanently = true;
            closedSince = 0;
            clearInterval(keepaliveTimer);
            console.warn(`[runtime] WhatsApp rejected session (code ${statusCode}). Regenerate SESSION_ID from the pairing site and redeploy.`);
          } else if (statusCode === 440) {
            if (closedSince === 0) closedSince = Date.now();
            console.warn('[runtime] WhatsApp session conflict (code 440) — this SESSION_ID is active on another bot/session. Stop duplicate instances or generate a new SESSION_ID.');
          } else {
            if (closedSince === 0) closedSince = Date.now();
            if (statusCode === 405) {
              loggedVersionUpgrade = false;
              refreshWaVersionFromWhatsAppWeb(true);
              console.warn('[runtime] WhatsApp rejected client version (code 405); refreshed latest WA Web revision and reconnecting...');
            } else if (statusCode) {
              console.warn(`[runtime] WhatsApp connection closed (code ${statusCode}${errMsg ? `: ${errMsg.slice(0, 80)}` : ''}); reconnecting...`);
            } else if (errMsg) {
              console.warn(`[runtime] WhatsApp connection closed (${errMsg.slice(0, 100)}); reconnecting...`);
            }
          }
        }
      };

      const invalidateFromGroupEvents = (event, payload) => {
        if (event === 'groups.update' && Array.isArray(payload)) {
          for (const g of payload) {
            if (g && g.id) invalidateGroupCache(g.id);
          }
        } else if (event === 'group-participants.update' && payload && payload.id) {
          invalidateGroupCache(payload.id);
        }
      };

      // Guard messages.upsert handlers & ensure sock.user.jid is always populated (both ev.on and ev.process)
      if (sock.ev && !sock.ev.__lyrihostWrapped) {
        if (typeof sock.ev.on === 'function') {
          const origEvOn = sock.ev.on.bind(sock.ev);
          sock.ev.on = function patchedEvOn(event, listener) {
            if (event === 'connection.update' && typeof listener === 'function') {
              return origEvOn(event, (update) => {
                syncSocketUserJid(sock);
                logConnUpdate(update);
                return listener(update);
              });
            }
            if ((event === 'groups.update' || event === 'group-participants.update') && typeof listener === 'function') {
              return origEvOn(event, (payload) => {
                invalidateFromGroupEvents(event, payload);
                return listener(payload);
              });
            }
            if (event === 'messages.upsert' && typeof listener === 'function') {
              return origEvOn(event, async (chatUpdate) => {
                markSocketActive();
                syncSocketUserJid(sock);
                const singleUpdates = normalizeIncomingChatUpdate(sock, chatUpdate);
                if (singleUpdates.length > 0 && (!chatUpdate || chatUpdate.type === 'notify')) {
                  lastIncomingCommandAt = Date.now();
                }
                for (const singleUpdate of singleUpdates) {
                  try {
                    const res = await withFastTimeout(listener(singleUpdate), 60000);
                    if (res === '__LYRIHOST_TIMEOUT__') {
                      console.warn('[runtime] Message handler exceeded 60s timeout; continuing event loop.');
                    }
                  } catch (err) {
                    console.error('[runtime] Guarded message handler error:', err && err.message ? err.message : err);
                  }
                }
              });
            }
            return origEvOn(event, listener);
          };
        }

        if (typeof sock.ev.process === 'function') {
          const origEvProcess = sock.ev.process.bind(sock.ev);
          sock.ev.process = function patchedEvProcess(handler) {
            if (typeof handler !== 'function') {
              return origEvProcess(handler);
            }
            return origEvProcess(async (events) => {
              markSocketActive();
              syncSocketUserJid(sock);
              if (events) {
                if (events['groups.update']) invalidateFromGroupEvents('groups.update', events['groups.update']);
                if (events['group-participants.update']) invalidateFromGroupEvents('group-participants.update', events['group-participants.update']);
                if (events['connection.update']) logConnUpdate(events['connection.update']);
              }
              if (events && events['messages.upsert']) {
                const singleUpdates = normalizeIncomingChatUpdate(sock, events['messages.upsert']);
                if (singleUpdates.length > 0 && events['messages.upsert'].type === 'notify') {
                  lastIncomingCommandAt = Date.now();
                }
                if (singleUpdates.length === 0) {
                  const rest = { ...events };
                  delete rest['messages.upsert'];
                  if (Object.keys(rest).length === 0) return;
                  return handler(rest);
                }
                for (let i = 0; i < singleUpdates.length; i++) {
                  const evSlice =
                    i === 0
                      ? { ...events, 'messages.upsert': singleUpdates[i] }
                      : { 'messages.upsert': singleUpdates[i] };
                  try {
                    const res = await withFastTimeout(handler(evSlice), 60000);
                    if (res === '__LYRIHOST_TIMEOUT__') {
                      console.warn('[runtime] ev.process message handler exceeded 60s timeout; continuing.');
                    }
                  } catch (err) {
                    console.error('[runtime] Guarded ev.process handler error:', err && err.message ? err.message : err);
                  }
                }
                return;
              }
              return handler(events);
            });
          };
        }

        sock.ev.__lyrihostWrapped = true;
      }
    }
    return sock;
  };
  wrapped.__lyrihostWrapped = true;
  return wrapped;
}

globalThis.__lyrihostWrapSocket = wrapSocketFactory;
globalThis.__lyrihostWrapVersionFetcher = wrapVersionFetcher;

const BAILEYS_PKG_RE = /baileys|whiskeysockets|adiwajshing/i;

if (typeof Module.registerHooks === 'function') {
  try {
    Module.registerHooks({
      load(url, context, nextLoad) {
        const res = nextLoad(url, context);
        if (
          res &&
          res.format === 'module' &&
          typeof url === 'string' &&
          BAILEYS_PKG_RE.test(url) &&
          res.source
        ) {
          let code =
            typeof res.source === 'string'
              ? res.source
              : Buffer.from(res.source).toString('utf8');

          if (/\/(?:lib|dist|src)\/Socket\/index\.m?js$/i.test(url) && !code.includes('__lyrihostWrapSocket')) {
            const patched = code.replace(
              /export\s+default\s+([A-Za-z0-9_$]+)\s*;?/m,
              'const __lyrihostOrigSock = $1;\nexport default (globalThis.__lyrihostWrapSocket ? globalThis.__lyrihostWrapSocket(__lyrihostOrigSock) : __lyrihostOrigSock);'
            );
            if (patched !== code) {
              return { ...res, source: patched };
            }
          }

          if (/\/(?:lib|dist|src)\/Utils\/generics\.m?js$/i.test(url) && !code.includes('__lyrihostWrapVersionFetcher')) {
            let patched = code;
            patched = patched.replace(
              /export\s+(?:async\s+)?function\s+fetchLatestBaileysVersion\b/,
              'async function __lyrihostOrigFetchLatestBaileysVersion'
            );
            patched = patched.replace(
              /export\s+(?:async\s+)?function\s+fetchLatestWaWebVersion\b/,
              'async function __lyrihostOrigFetchLatestWaWebVersion'
            );
            if (patched !== code) {
              if (patched.includes('__lyrihostOrigFetchLatestBaileysVersion')) {
                patched += '\nexport const fetchLatestBaileysVersion = globalThis.__lyrihostWrapVersionFetcher ? globalThis.__lyrihostWrapVersionFetcher(__lyrihostOrigFetchLatestBaileysVersion) : __lyrihostOrigFetchLatestBaileysVersion;';
              }
              if (patched.includes('__lyrihostOrigFetchLatestWaWebVersion')) {
                patched += '\nexport const fetchLatestWaWebVersion = globalThis.__lyrihostWrapVersionFetcher ? globalThis.__lyrihostWrapVersionFetcher(__lyrihostOrigFetchLatestWaWebVersion) : __lyrihostOrigFetchLatestWaWebVersion;';
              }
              return { ...res, source: patched };
            }
          }
        }
        return res;
      },
    });
  } catch {
    // Ignore if registerHooks unavailable
  }
}

const origModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const loaded = origModuleLoad.apply(this, arguments);
  if (
    typeof request === 'string' &&
    BAILEYS_PKG_RE.test(request) &&
    loaded &&
    typeof loaded === 'object'
  ) {
    refreshWaVersionFromModule(loaded);
    if (typeof loaded.fetchLatestWaWebVersion === 'function') {
      loaded.fetchLatestWaWebVersion = wrapVersionFetcher(loaded.fetchLatestWaWebVersion);
    }
    if (typeof loaded.fetchLatestBaileysVersion === 'function') {
      loaded.fetchLatestBaileysVersion = wrapVersionFetcher(loaded.fetchLatestBaileysVersion);
    }
    if (typeof loaded.default === 'function') {
      loaded.default = wrapSocketFactory(loaded.default);
    }
    if (typeof loaded.makeWASocket === 'function') {
      loaded.makeWASocket = wrapSocketFactory(loaded.makeWASocket);
    }
  }
  return loaded;
};

const origProcessOn = process.on.bind(process);
const origProcessAddListener = process.addListener.bind(process);

function wrapUnhandledRejectionListener(listener) {
  if (typeof listener !== 'function') return listener;
  return function guardedRejectionListener(reason, promise) {
    if (isTransientSocketError(reason)) {
      logTransientNotice(reason);
      return;
    }
    return listener.call(this, reason, promise);
  };
}

process.on = function patchedProcessOn(event, listener) {
  if (event === 'unhandledRejection' || event === 'uncaughtException') {
    return origProcessOn(event, wrapUnhandledRejectionListener(listener));
  }
  return origProcessOn(event, listener);
};

process.addListener = function patchedProcessAddListener(event, listener) {
  if (event === 'unhandledRejection' || event === 'uncaughtException') {
    return origProcessAddListener(event, wrapUnhandledRejectionListener(listener));
  }
  return origProcessAddListener(event, listener);
};

origProcessOn('unhandledRejection', (reason) => {
  if (isTransientSocketError(reason)) {
    logTransientNotice(reason);
    return;
  }
  if (process.listenerCount('unhandledRejection') <= 1) {
    console.error('[runtime] Unhandled Rejection:', reason);
  }
});

origProcessOn('uncaughtException', (err) => {
  if (isTransientSocketError(err)) {
    logTransientNotice(err);
    return;
  }
  if (process.listenerCount('uncaughtException') <= 1) {
    console.error('[runtime] Uncaught Exception:', err);
  }
});

/**
 * 3. Prevent bot web servers from crashing with EADDRINUSE when hardcoding the host platform port (e.g. 3000) or colliding ports.
 */
try {
  const net = require('node:net');
  const hostPort = Number.parseInt(process.env.LYRIHOST_HOST_PORT || '', 10);
  const assignedPort = Number.parseInt(process.env.PORT || '', 10);
  const reservedPorts = new Set(
    [hostPort, 3000, 8000].filter((p) => Number.isInteger(p) && p > 0 && p !== assignedPort)
  );
  if (typeof net.Server.prototype.listen === 'function') {
    const origListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function patchedListen(...args) {
      if (Number.isInteger(assignedPort) && assignedPort > 0) {
        if (typeof args[0] === 'number' && reservedPorts.has(args[0])) {
          args[0] = assignedPort;
        } else if (
          args[0] &&
          typeof args[0] === 'object' &&
          reservedPorts.has(Number(args[0].port))
        ) {
          args[0] = { ...args[0], port: assignedPort };
        }
      }

      if (!this.__lyrihostPortGuardAttached) {
        this.__lyrihostPortGuardAttached = true;
        const server = this;
        const onListenError = (err) => {
          if (err && err.code === 'EADDRINUSE' && !server.__lyrihostRetriedPort) {
            server.__lyrihostRetriedPort = true;
            const fallbackPort = Number.isInteger(assignedPort) && assignedPort > 0 ? assignedPort : 0;
            console.warn(`[runtime] Port already in use; shifting bot HTTP listener to isolated port ${fallbackPort}.`);
            try {
              origListen.call(server, fallbackPort);
            } catch {
              origListen.call(server, 0);
            }
          }
        };
        server.prependOnceListener('error', onListenError);
      }

      return origListen.apply(this, args);
    };
  }

  if (typeof net.Socket.prototype.connect === 'function') {
    const origConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function patchedConnect(...args) {
      try {
        if (typeof this.setNoDelay === 'function') this.setNoDelay(true);
        if (typeof this.setKeepAlive === 'function') this.setKeepAlive(true, 15000);
      } catch {
        // ignore socket option failures before connect
      }
      return origConnect.apply(this, args);
    };
  }
} catch {
  // ignore net patch failure
}

