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

let cachedWaVersion = [2, 3000, 1055376512];
let versionRefreshStarted = false;
let loggedVersionUpgrade = false;

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

    // Map own @lid JIDs (self-chat / linked devices) to bare @s.whatsapp.net so owner checks succeed
    if (msg.key && ownBareLid && ownBarePhoneJid) {
      if (toBareJid(msg.key.remoteJid) === ownBareLid) {
        msg.key.remoteJid = ownBarePhoneJid;
      }
      if (toBareJid(msg.key.participant) === ownBareLid) {
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
      if (!cfg.connectTimeoutMs || cfg.connectTimeoutMs < 45000) {
        cfg.connectTimeoutMs = 45000;
      }
      if (!cfg.defaultQueryTimeoutMs || cfg.defaultQueryTimeoutMs < 45000) {
        cfg.defaultQueryTimeoutMs = 45000;
      }
      if (!cfg.keepAliveIntervalMs) {
        cfg.keepAliveIntervalMs = 25000;
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

      for (const method of ['updateProfileStatus', 'sendPresenceUpdate']) {
        if (typeof sock[method] === 'function' && !sock[method].__lyrihostGuarded) {
          const origMethod = sock[method].bind(sock);
          const guardedMethod = async (...mArgs) => {
            if (!isSocketOpen()) return undefined;
            try {
              return await origMethod(...mArgs);
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

      // Guard messages.upsert handlers & ensure sock.user.jid is always populated
      if (sock.ev && typeof sock.ev.on === 'function' && !sock.ev.__lyrihostWrapped) {
        const origEvOn = sock.ev.on.bind(sock.ev);
        sock.ev.on = function patchedEvOn(event, listener) {
          if (event === 'connection.update' && typeof listener === 'function') {
            return origEvOn(event, (update) => {
              syncSocketUserJid(sock);
              return listener(update);
            });
          }
          if (event === 'messages.upsert' && typeof listener === 'function') {
            return origEvOn(event, async (chatUpdate) => {
              syncSocketUserJid(sock);
              const singleUpdates = normalizeIncomingChatUpdate(sock, chatUpdate);
              for (const singleUpdate of singleUpdates) {
                try {
                  await listener(singleUpdate);
                } catch (err) {
                  console.error('[runtime] Guarded message handler error:', err && err.message ? err.message : err);
                }
              }
            });
          }
          return origEvOn(event, listener);
        };
        sock.ev.__lyrihostWrapped = true;
      }
    }
    return sock;
  };
  wrapped.__lyrihostWrapped = true;
  return wrapped;
}

const origModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const loaded = origModuleLoad.apply(this, arguments);
  if (
    typeof request === 'string' &&
    /(^|\/)(@[^/]+\/)?baileys/i.test(request) &&
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
