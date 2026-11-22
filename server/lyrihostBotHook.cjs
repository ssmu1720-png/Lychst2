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

let cachedWaVersion = [2, 3000, 1055718978];
let versionRefreshStarted = false;
let swRefreshStarted = false;
let loggedVersionUpgrade = false;

function refreshWaVersionFromWhatsAppWeb() {
  if (swRefreshStarted) return;
  swRefreshStarted = true;
  try {
    const https = require('node:https');
    const req = https.get(
      'https://web.whatsapp.com/sw.js',
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        timeout: 4500,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return;
        }
        let body = '';
        res.on('data', (chunk) => {
          if (body.length < 250000) body += chunk.toString('utf8');
        });
        res.on('end', () => {
          const match =
            body.match(/client_revision\\?":(\d{8,12})/) ||
            body.match(/"client_revision":(\d{8,12})/);
          if (match) {
            const rev = Number.parseInt(match[1], 10);
            if (Number.isFinite(rev) && rev > cachedWaVersion[2]) {
              cachedWaVersion = [2, 3000, rev];
            }
          }
        });
      }
    );
    req.on('error', () => {});
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {}
    });
  } catch {
    // ignore background fetch error
  }
}

refreshWaVersionFromWhatsAppWeb();

function refreshWaVersionFromModule(loaded) {
  if (versionRefreshStarted || !loaded || typeof loaded !== 'object') return;
  versionRefreshStarted = true;
  if (typeof loaded.fetchLatestWaWebVersion === 'function') {
    Promise.resolve(loaded.fetchLatestWaWebVersion({}))
      .then((res) => {
        if (res && Array.isArray(res.version) && res.version.length === 3 && Number(res.version[2]) > cachedWaVersion[2]) {
          cachedWaVersion = res.version;
        }
      })
      .catch(() => {});
  } else if (typeof loaded.fetchLatestBaileysVersion === 'function') {
    Promise.resolve(loaded.fetchLatestBaileysVersion())
      .then((res) => {
        if (res && Array.isArray(res.version) && res.version.length === 3 && Number(res.version[2]) > cachedWaVersion[2]) {
          cachedWaVersion = res.version;
        }
      })
      .catch(() => {});
  }
}

function isStaleWaVersion(v) {
  if (!Array.isArray(v) || v.length < 3) return true;
  return v[0] === 2 && v[1] === 3000 && Number(v[2]) < cachedWaVersion[2];
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

function normalizeIncomingChatUpdate(sock, chatUpdate) {
  if (!chatUpdate || !Array.isArray(chatUpdate.messages)) return [chatUpdate];
  syncSocketUserJid(sock);

  const ownBarePhoneJid = sock && sock.user && sock.user.id ? toBareJid(sock.user.id) : null;
  const ownBareLid = sock && sock.user && sock.user.lid ? toBareJid(sock.user.lid) : null;

  const normalizedMessages = [];
  for (const rawMsg of chatUpdate.messages) {
    if (!rawMsg || typeof rawMsg !== 'object') continue;
    const msg = rawMsg;

    if (msg.message) {
      msg.message = unwrapBaileysMessageContent(msg.message);
    }

    // Map own @lid JIDs (self-chat / linked devices) and Baileys v7 *Alt PN JIDs so owner checks succeed
    if (msg.key) {
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
      const chatLabel = msg.key && msg.key.remoteJid ? msg.key.remoteJid : 'unknown';
      console.log(
        `[runtime] WhatsApp message from ${chatLabel}: ${preview.slice(0, 48)}${preview.length > 48 ? '...' : ''}`
      );
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
      // Low-latency & anti-sleep Baileys socket tuning
      if (!cfg.connectTimeoutMs || cfg.connectTimeoutMs < 20000 || cfg.connectTimeoutMs > 35000) {
        cfg.connectTimeoutMs = 25000;
      }
      if (!cfg.defaultQueryTimeoutMs || cfg.defaultQueryTimeoutMs > 15000) {
        cfg.defaultQueryTimeoutMs = 12000;
      }
      if (!cfg.keepAliveIntervalMs || cfg.keepAliveIntervalMs > 15000) {
        cfg.keepAliveIntervalMs = 15000;
      }
      if (cfg.retryRequestDelayMs === undefined || cfg.retryRequestDelayMs > 350) {
        cfg.retryRequestDelayMs = 250;
      }
      if (cfg.maxMsgRetryCount === undefined || cfg.maxMsgRetryCount > 4) {
        cfg.maxMsgRetryCount = 3;
      }
      if (cfg.syncFullHistory === undefined) {
        cfg.syncFullHistory = false;
      }
      cfg.markOnlineOnConnect = true;
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

      // Guard sendMessage with a 20s timeout so a stalled upload/usync never hangs message handlers
      if (typeof sock.sendMessage === 'function' && !sock.sendMessage.__lyrihostGuarded) {
        const origSendMessage = sock.sendMessage.bind(sock);
        const guardedSendMessage = async (...mArgs) => {
          const res = await withFastTimeout(origSendMessage(...mArgs), 20000);
          if (res === '__LYRIHOST_TIMEOUT__') {
            throw new Error('WhatsApp sendMessage timed out after 20s');
          }
          return res;
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
      let missedPongs = 0;
      let missedNoisePings = 0;
      let noisePingInFlight = false;
      let pongBoundWs = null;

      const getRawWs = () => {
        const ws = sock.ws;
        if (!ws) return null;
        return ws.socket && typeof ws.socket === 'object' ? ws.socket : ws;
      };

      const bindPongListener = (rawWs) => {
        if (!rawWs || pongBoundWs === rawWs || typeof rawWs.on !== 'function') return;
        pongBoundWs = rawWs;
        rawWs.on('pong', () => {
          missedPongs = 0;
        });
      };

      const recycleZombieSocket = (reason) => {
        missedPongs = 0;
        missedNoisePings = 0;
        console.warn(`[runtime] ${reason}; recycling WhatsApp socket immediately...`);
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
        // Ensure event buffer never gets stuck paused after reconnect
        try {
          if (sock.ev && typeof sock.ev.isBuffering === 'function' && sock.ev.isBuffering() && typeof sock.ev.flush === 'function') {
            sock.ev.flush();
          }
        } catch {
          // ignore flush guard error
        }

        const ws = sock.ws;
        const rawWs = getRawWs();
        const wsOpen = Boolean(
          (rawWs && rawWs.readyState === 1) || (ws && (ws.isOpen === true || ws.readyState === 1))
        );

        if (wsOpen) {
          if (rawWs && typeof rawWs.ping === 'function') {
            bindPongListener(rawWs);
            if (missedPongs >= 2) {
              recycleZombieSocket('WhatsApp raw WebSocket stopped responding to RFC-6455 pings');
              return;
            }
            missedPongs += 1;
            try {
              rawWs.ping();
            } catch {
              missedPongs = 2;
            }
          }

          // Encrypted WhatsApp Noise IQ ping keeps session alive on WA relays & detects silent zombie drops
          if (sock.user && typeof sock.query === 'function' && !noisePingInFlight) {
            noisePingInFlight = true;
            withFastTimeout(
              sock.query({
                tag: 'iq',
                attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:p' },
                content: [{ tag: 'ping', attrs: {} }],
              }),
              8000
            )
              .then((res) => {
                if (res === '__LYRIHOST_TIMEOUT__') {
                  missedNoisePings += 1;
                  if (missedNoisePings >= 2) {
                    recycleZombieSocket('WhatsApp Noise IQ ping timed out twice (silent zombie session)');
                  }
                } else {
                  missedNoisePings = 0;
                }
              })
              .catch(() => {
                missedNoisePings += 1;
                if (missedNoisePings >= 2) {
                  recycleZombieSocket('WhatsApp Noise IQ ping failed twice');
                }
              })
              .finally(() => {
                noisePingInFlight = false;
              });
          }
        } else if (hasEverOpened && closedSince > 0 && Date.now() - closedSince > 40000) {
          closedSince = Date.now();
          console.warn('[runtime] WhatsApp socket stalled offline for 40s; exiting for instant 1s supervisor recovery...');
          clearInterval(keepaliveTimer);
          process.exit(1);
        }
      }, 15000);

      globalThis.__lyrihostClearSocketKeepalive = () => clearInterval(keepaliveTimer);

      const logConnUpdate = (update) => {
        if (!update || typeof update !== 'object') return;
        const conn = update.connection;
        if (conn === 'open') {
          hasEverOpened = true;
          closedSince = 0;
          missedPongs = 0;
          missedNoisePings = 0;
          bindPongListener(getRawWs());
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
          const statusCode =
            update.lastDisconnect &&
            update.lastDisconnect.error &&
            update.lastDisconnect.error.output &&
            update.lastDisconnect.error.output.statusCode;
          if (statusCode === 401 || statusCode === 403) {
            loggedOutPermanently = true;
            closedSince = 0;
            clearInterval(keepaliveTimer);
            console.warn(`[runtime] WhatsApp rejected session (code ${statusCode}). Regenerate SESSION_ID from the pairing site and redeploy.`);
          } else {
            if (closedSince === 0) closedSince = Date.now();
            if (statusCode) {
              console.warn(`[runtime] WhatsApp connection closed (code ${statusCode}); reconnecting...`);
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
                syncSocketUserJid(sock);
                const singleUpdates = normalizeIncomingChatUpdate(sock, chatUpdate);
                for (const singleUpdate of singleUpdates) {
                  try {
                    await withFastTimeout(listener(singleUpdate), 25000);
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
              syncSocketUserJid(sock);
              if (events) {
                if (events['groups.update']) invalidateFromGroupEvents('groups.update', events['groups.update']);
                if (events['group-participants.update']) invalidateFromGroupEvents('group-participants.update', events['group-participants.update']);
                if (events['connection.update']) logConnUpdate(events['connection.update']);
              }
              if (events && events['messages.upsert']) {
                const singleUpdates = normalizeIncomingChatUpdate(sock, events['messages.upsert']);
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
                    await withFastTimeout(handler(evSlice), 25000);
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

if (typeof Module.registerHooks === 'function') {
  try {
    Module.registerHooks({
      load(url, context, nextLoad) {
        const res = nextLoad(url, context);
        if (
          res &&
          res.format === 'module' &&
          typeof url === 'string' &&
          /baileys/i.test(url) &&
          /\/lib\/Socket\/index\.m?js$/i.test(url) &&
          res.source
        ) {
          let code =
            typeof res.source === 'string'
              ? res.source
              : Buffer.from(res.source).toString('utf8');
          if (!code.includes('__lyrihostWrapSocket')) {
            const patched = code.replace(
              /export\s+default\s+([A-Za-z0-9_$]+)\s*;?/m,
              'const __lyrihostOrigSock = $1;\nexport default (globalThis.__lyrihostWrapSocket ? globalThis.__lyrihostWrapSocket(__lyrihostOrigSock) : __lyrihostOrigSock);'
            );
            if (patched !== code) {
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
    /baileys/i.test(request) &&
    loaded &&
    typeof loaded === 'object'
  ) {
    refreshWaVersionFromModule(loaded);
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

