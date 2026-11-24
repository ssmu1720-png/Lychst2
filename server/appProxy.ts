import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Request, Response } from 'express';
import { getAssignedBotPort } from './processManager.ts';
import type {
  BotDeployment,
  DeploymentNetworkingInfo,
  RuntimeEnvironment,
} from '../src/types/lyrihost.ts';

const NODE_HOSTED_RUNTIMES = new Set<RuntimeEnvironment>(['node-20', 'node-22', 'bun-1']);

export function isNodeHostedRuntime(runtime?: RuntimeEnvironment | string | null): boolean {
  return Boolean(runtime && NODE_HOSTED_RUNTIMES.has(runtime as RuntimeEnvironment));
}

export function supportsPublicEndpoints(dep: Pick<BotDeployment, 'settings'>): boolean {
  return isNodeHostedRuntime(dep.settings?.runtime);
}

export function normalizeHostname(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .split(':')[0]
    .replace(/\.+$/, '');

  if (!cleaned || cleaned.length > 253) return null;
  if (
    cleaned === 'localhost' ||
    cleaned.endsWith('.localhost') ||
    cleaned.endsWith('.local') ||
    cleaned.endsWith('.internal') ||
    net.isIP(cleaned) !== 0
  ) {
    return null;
  }
  if (!cleaned.includes('.')) return null;

  const labels = cleaned.split('.');
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    )
  ) {
    return null;
  }
  return cleaned;
}

export function normalizeAppSlug(raw: string): string | null {
  let candidate = raw.trim().toLowerCase();
  if (!candidate) return null;

  if (/^https?:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).pathname;
    } catch {
      return null;
    }
  }

  const appPrefixMatch = candidate.match(/\/app\/([^/?#]+)/i);
  if (appPrefixMatch) {
    candidate = appPrefixMatch[1];
  } else {
    candidate = candidate.replace(/^\/+|\/+$/g, '').split('/')[0] || '';
  }

  const cleaned = candidate
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  if (cleaned.length < 2 || !/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export function extractRequestHost(rawHostHeader?: string | string[]): string {
  const first = Array.isArray(rawHostHeader) ? rawHostHeader[0] : rawHostHeader || '';
  return first.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
}

const COLLIDING_PROXY_PORTS = new Set(['', '3000', '5000', '8000', '8080']);

export function resolveDeploymentInternalPort(dep: BotDeployment): number {
  const hostPort = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
  const portEntry = dep.settings.envVars.find((v) => v.key === 'PORT' || v.key === 'WEB_PORT');
  const rawVal = portEntry?.value.trim() || '';
  if (rawVal && !COLLIDING_PROXY_PORTS.has(rawVal)) {
    const parsed = Number.parseInt(rawVal, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 && parsed !== hostPort) {
      return parsed;
    }
  }
  return getAssignedBotPort(dep.numericId);
}

export interface ProxyResolution {
  dep: BotDeployment;
  mode: 'custom-domain' | 'wildcard-subdomain' | 'path-prefix';
  stripPrefix?: string;
}

const LYRIHOST_RESERVED_PREFIX_RE =
  /^\/(?:app\/|up\/|api\/(?:auth|wallet|support|admin|bots|deployments|preferences|health|healthz|system)\b|ws\/bots\/)/i;

export function resolveDeploymentByProxyRequest(
  reqUrl: string,
  hostHeader: string | string[] | undefined,
  deployments: BotDeployment[],
  platformWildcardDomain?: string,
  refererHeader?: string | string[]
): ProxyResolution | null {
  const reqHost = extractRequestHost(hostHeader);
  const wildcardBase = platformWildcardDomain ? normalizeHostname(platformWildcardDomain) : null;

  // 1. Check custom domain or platform wildcard subdomain first
  if (reqHost) {
    for (const dep of deployments) {
      if (!supportsPublicEndpoints(dep) || dep.publicAppEnabled === false) continue;
      if (dep.customDomain && dep.customDomain.toLowerCase() === reqHost) {
        return { dep, mode: 'custom-domain' };
      }
      if (wildcardBase && dep.appSlug && reqHost === `${dep.appSlug}.${wildcardBase}`) {
        return { dep, mode: 'wildcard-subdomain' };
      }
    }
  }

  // 2. Check /app/<slug> path-based proxy (works with zero custom domain on Railway *.up.railway.app)
  const pathname = reqUrl.split('?')[0] || '/';
  const match = pathname.match(/^\/app\/([a-z0-9][a-z0-9-]{1,60})(\/.*)?$/i);
  if (match) {
    const slug = match[1].toLowerCase();
    const dep = deployments.find(
      (d) =>
        supportsPublicEndpoints(d) &&
        d.publicAppEnabled !== false &&
        d.appSlug?.toLowerCase() === slug
    );
    if (dep) {
      return {
        dep,
        mode: 'path-prefix',
        stripPrefix: `/app/${match[1]}`,
      };
    }
  }

  // 3. Referer-based fallback for root-relative web app assets (/assets/*, /_next/*, /static/*, etc.) loaded from /app/<slug>/
  if (refererHeader && !LYRIHOST_RESERVED_PREFIX_RE.test(pathname)) {
    const rawReferer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
    if (rawReferer) {
      try {
        const refPath = new URL(rawReferer).pathname;
        const refMatch = refPath.match(/^\/app\/([a-z0-9][a-z0-9-]{1,60})(?:\/|$)/i);
        if (refMatch) {
          const slug = refMatch[1].toLowerCase();
          const dep = deployments.find(
            (d) =>
              supportsPublicEndpoints(d) &&
              d.publicAppEnabled !== false &&
              d.appSlug?.toLowerCase() === slug
          );
          if (dep) {
            return {
              dep,
              mode: 'path-prefix',
            };
          }
        }
      } catch {
        // ignore invalid referer URL
      }
    }
  }

  return null;
}

function sendProxyUnavailable(
  req: Request,
  res: Response,
  dep: BotDeployment,
  statusCode: 502 | 503,
  reason: string
): void {
  if (res.headersSent) return;
  const acceptsJson = (req.headers.accept || '').includes('application/json');
  if (acceptsJson) {
    res.status(statusCode).json({
      error: reason,
      deploymentId: dep.id,
      name: dep.name,
      status: dep.status,
    });
    return;
  }

  const safeName = dep.name.replace(/[<>&"']/g, '');
  const safeReason = reason.replace(/[<>&"']/g, '');
  res.status(statusCode).setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeName} · Service Unavailable</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080305;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;padding:24px;}
    .card{max-width:460px;width:100%;border:1px solid rgba(239,68,68,0.35);background:#12070a;border-radius:12px;padding:24px;}
    h1{margin:0 0 8px;font-size:18px;color:#fff;}
    p{margin:0 0 14px;font-size:14px;line-height:1.5;color:#94a3b8;}
    code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:#fda4af;background:#080305;padding:2px 6px;border-radius:4px;}
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeName} is currently unreachable</h1>
    <p>${safeReason}</p>
    <p>Current state: <code>${dep.status}</code></p>
  </div>
</body>
</html>`);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUptimeShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${rem}s`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

const COMMON_BOT_ROUTES = [
  '/health',
  '/status',
  '/ping',
  '/pair',
  '/qr',
  '/api',
  '/api/health',
  '/docs',
  '/dashboard',
];

async function probeLiveBotRoutes(
  targetPort: number
): Promise<Array<{ path: string; status: number }>> {
  const results = await Promise.all(
    COMMON_BOT_ROUTES.map(async (route) => {
      try {
        const resp = await fetch(`http://127.0.0.1:${targetPort}${route}`, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(400),
        });
        if (resp.status !== 404 && resp.status < 500) {
          return { path: route, status: resp.status };
        }
      } catch {
        // ignore probe error/timeout
      }
      return null;
    })
  );
  return results.filter((r): r is { path: string; status: number } => r !== null);
}

function sendRootBotGatewayPage(
  res: Response,
  dep: BotDeployment,
  targetPort: number,
  stripPrefix: string | undefined,
  discoveredRoutes: Array<{ path: string; status: number }>
): void {
  if (res.headersSent) return;
  const safeName = escapeHtml(dep.name);
  const safeId = escapeHtml(dep.id);
  const safeRuntime = escapeHtml(dep.settings.runtime);
  const basePrefix = stripPrefix || '';
  const uptimeText = formatUptimeShort(dep.uptimeSeconds || 0);
  const cpuText = `${(dep.cpuPercent ?? 0).toFixed(1)}%`;
  const ramText = `${Math.round(dep.memoryMb ?? 0)} / ${dep.memoryLimitMb} MB`;

  const routeLinksHtml =
    discoveredRoutes.length > 0
      ? discoveredRoutes
          .map((r) => {
            const href = escapeHtml(`${basePrefix}${r.path}`);
            return `<a class="route-pill" href="${href}"><span>${escapeHtml(r.path)}</span><span class="badge">HTTP ${r.status}</span></a>`;
          })
          .join('')
      : `<p class="muted">No common HTTP sub-routes (<code>/health</code>, <code>/pair</code>, <code>/qr</code>, <code>/status</code>) responded yet — this bot appears to run purely as a background service with an internal keepalive listener.</p>`;

  const quickSuggs = ['/health', '/status', '/pair', '/qr', '/api']
    .map((p) => `<a class="quick-link" href="${escapeHtml(`${basePrefix}${p}`)}">${escapeHtml(p)}</a>`)
    .join('');

  res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeName} · Running on Lyrihost</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080305;color:#e2e8f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:20px;}
    .card{max-width:560px;width:100%;border:1px solid rgba(52,211,153,0.3);background:#10080b;border-radius:14px;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,0.55);}
    .top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
    .status{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#34d399;background:rgba(16,185,129,0.12);border:1px solid rgba(52,211,153,0.3);padding:4px 10px;border-radius:6px;}
    .dot{width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399;}
    .id{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:#fda4af;background:#190c11;border:1px solid rgba(255,255,255,0.08);padding:4px 8px;border-radius:6px;}
    h1{margin:0 0 8px;font-size:22px;color:#fff;}
    p{margin:0 0 14px;font-size:14px;line-height:1.55;color:#cbd5e1;}
    .muted{color:#94a3b8;font-size:13px;}
    code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:#fda4af;background:#080305;padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.08);}
    .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0;}
    @media (max-width:520px){.metrics{grid-template-columns:repeat(2,1fr);}}
    .metric{background:#0b0507;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;}
    .metric .label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:4px;}
    .metric .val{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;font-weight:700;color:#fff;}
    .section-title{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin:18px 0 8px;font-weight:700;}
    .routes{display:flex;flex-wrap:wrap;gap:8px;}
    .route-pill{display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:#f8fafc;background:#170c11;border:1px solid rgba(52,211,153,0.35);padding:7px 11px;border-radius:8px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;}
    .route-pill:hover{border-color:#34d399;background:#1b1116;}
    .badge{font-size:10px;color:#34d399;background:rgba(16,185,129,0.12);padding:2px 6px;border-radius:4px;}
    .form{display:flex;gap:8px;margin-top:10px;}
    .input{flex:1;background:#080305;border:1px solid rgba(255,255,255,0.14);color:#fff;padding:9px 11px;border-radius:8px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;}
    .btn{background:#dc2626;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;}
    .btn:hover{background:#ef4444;}
    .quick-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
    .quick-link{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:#cbd5e1;text-decoration:none;border:1px solid rgba(255,255,255,0.1);padding:4px 8px;border-radius:6px;background:#0b0507;}
    .quick-link:hover{border-color:rgba(255,255,255,0.28);color:#fff;}
    .footer{margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;font-size:12px;color:#94a3b8;}
    .footer a{color:#f87171;text-decoration:none;font-weight:600;}
  </style>
</head>
<body>
  <div class="card">
    <div class="top">
      <span class="status"><span class="dot"></span>Online &amp; Running</span>
      <span class="id">${safeId}</span>
    </div>
    <h1>${safeName}</h1>
    <p>
      Your <code>${safeRuntime}</code> service is running on internal port <code>${targetPort}</code>.
      The app responded with <code>Cannot GET /</code> because this repository does not define a root <code>GET /</code> webpage
      (normal for WhatsApp, Telegram, Discord bots, and API-only servers).
    </p>
    <div class="metrics">
      <div class="metric"><div class="label">CPU</div><div class="val">${escapeHtml(cpuText)}</div></div>
      <div class="metric"><div class="label">RAM</div><div class="val">${escapeHtml(ramText)}</div></div>
      <div class="metric"><div class="label">Uptime</div><div class="val">${escapeHtml(uptimeText)}</div></div>
      <div class="metric"><div class="label">Port</div><div class="val">${targetPort}</div></div>
    </div>

    <div class="section-title">Detected Active Endpoints</div>
    <div class="routes">${routeLinksHtml}</div>

    <div class="section-title">Open a Specific App Route</div>
    <form class="form" onsubmit="event.preventDefault();var p=document.getElementById('rp').value.trim();if(!p)return;if(!p.startsWith('/'))p='/'+p;window.location.href=${JSON.stringify(basePrefix)}+p;">
      <input id="rp" class="input" type="text" placeholder="/pair, /qr, /health, /api" value="/health" />
      <button class="btn" type="submit">Open Route</button>
    </form>
    <div class="quick-row">${quickSuggs}</div>

    <div class="footer">
      <span>Add <code>app.get('/', ...)</code> in your repo to serve a custom homepage.</span>
      <a href="/">← Lyrihost Dashboard</a>
    </div>
  </div>
</body>
</html>`);
}

const preferredLoopbackHost = new Map<number, '127.0.0.1' | '::1'>();

function rewriteHtmlForSubpathProxy(html: string, stripPrefix: string): string {
  const escapedPrefix = stripPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rootAttrRe = new RegExp(
    `(\\b(?:href|src|action|poster|data-src)\\s*=\\s*["'])(/(?!/)(?!${escapedPrefix}(?:/|$)))`,
    'gi'
  );
  let rewritten = html.replace(rootAttrRe, `$1${stripPrefix}$2`);

  const hasBaseTag = /<base\b/i.test(rewritten);
  const baseTag = hasBaseTag ? '' : `<base href="${escapeHtml(stripPrefix)}/">`;
  const runtimeShim = `<script data-lyrihost-proxy>(function(){var P=${JSON.stringify(stripPrefix)};function r(u){if(typeof u!=='string')return u;if(u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.indexOf(P+'/')!==0&&u!==P)return P+u;return u;}var f=window.fetch;if(f){window.fetch=function(i,o){if(typeof i==='string')i=r(i);else if(i&&typeof Request!=='undefined'&&i instanceof Request){try{var u=new URL(i.url,location.href);if(u.origin===location.origin&&u.pathname.indexOf(P+'/')!==0&&u.pathname!==P){i=new Request(r(u.pathname+u.search+u.hash),i);}}catch(e){}}return f.call(this,i,o);};}if(window.XMLHttpRequest){var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);if(typeof u==='string')a[1]=r(u);return xo.apply(this,a);};}if(window.EventSource){var ES=window.EventSource;window.EventSource=function(u,c){return new ES(r(u),c);};window.EventSource.prototype=ES.prototype;}if(window.WebSocket){var WS=window.WebSocket;window.WebSocket=function(u,p){if(typeof u==='string'){try{var pu=new URL(u,location.href);if(pu.host===location.host&&pu.pathname.indexOf(P+'/')!==0){pu.pathname=r(pu.pathname);u=pu.toString();}}catch(e){}}return p!==undefined?new WS(u,p):new WS(u);};window.WebSocket.prototype=WS.prototype;}})();</script>`;
  const injection = `${baseTag}${runtimeShim}`;

  if (/<head\b[^>]*>/i.test(rewritten)) {
    rewritten = rewritten.replace(/<head\b[^>]*>/i, (m) => `${m}${injection}`);
  } else if (/<html\b[^>]*>/i.test(rewritten)) {
    rewritten = rewritten.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${injection}</head>`);
  } else {
    rewritten = `${injection}${rewritten}`;
  }
  return rewritten;
}

export function proxyHttpRequest(
  req: Request,
  res: Response,
  resolution: ProxyResolution
): void {
  const { dep, stripPrefix } = resolution;

  if (dep.expiresAt && Date.parse(dep.expiresAt) <= Date.now()) {
    sendProxyUnavailable(req, res, dep, 503, 'This deployment plan has expired.');
    return;
  }

  if (dep.status !== 'online') {
    sendProxyUnavailable(
      req,
      res,
      dep,
      503,
      dep.status === 'building'
        ? 'The application is currently building or restarting. Refresh in a few seconds.'
        : 'The application process is currently stopped or offline.'
    );
    return;
  }

  // Ensure /app/<slug> redirects to /app/<slug>/ on GET so relative asset paths work
  const [rawPath, rawQuery] = (req.originalUrl || req.url || '/').split('?');
  if (stripPrefix && rawPath === stripPrefix && req.method === 'GET') {
    const querySuffix = rawQuery ? `?${rawQuery}` : '';
    res.redirect(302, `${stripPrefix}/${querySuffix}`);
    return;
  }

  let upstreamPath = rawPath;
  if (stripPrefix && upstreamPath.startsWith(stripPrefix)) {
    upstreamPath = upstreamPath.slice(stripPrefix.length) || '/';
    if (!upstreamPath.startsWith('/')) upstreamPath = `/${upstreamPath}`;
  }
  const fullTargetPath = rawQuery ? `${upstreamPath}?${rawQuery}` : upstreamPath;

  const targetPort = resolveDeploymentInternalPort(dep);
  const outgoingHeaders: http.OutgoingHttpHeaders = { ...req.headers };
  delete outgoingHeaders['content-length'];
  if (stripPrefix) {
    // Request uncompressed HTML over loopback so subpath HTML rewriting is fast and lossless
    outgoingHeaders['accept-encoding'] = 'identity';
  }
  outgoingHeaders.host = `127.0.0.1:${targetPort}`;
  outgoingHeaders['x-forwarded-host'] =
    (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  outgoingHeaders['x-forwarded-proto'] =
    (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  if (req.socket.remoteAddress) {
    outgoingHeaders['x-forwarded-for'] = outgoingHeaders['x-forwarded-for']
      ? `${outgoingHeaders['x-forwarded-for']}, ${req.socket.remoteAddress}`
      : req.socket.remoteAddress;
  }
  if (stripPrefix) {
    outgoingHeaders['x-forwarded-prefix'] = stripPrefix;
  }
  if (req.headers['content-length'] !== undefined) {
    outgoingHeaders['content-length'] = req.headers['content-length'];
  }

  const shouldCheckBareRoot404 =
    req.method === 'GET' &&
    upstreamPath === '/' &&
    (req.headers.accept || '').includes('text/html');

  const initialHost = preferredLoopbackHost.get(targetPort) || '127.0.0.1';
  const canRetryBodyless = req.method === 'GET' || req.method === 'HEAD';

  const attemptProxy = (targetHost: '127.0.0.1' | '::1', hasRetried: boolean): void => {
    const reqHeaders = { ...outgoingHeaders };
    reqHeaders.host =
      targetHost === '::1' ? `[::1]:${targetPort}` : `127.0.0.1:${targetPort}`;

    const proxyReq = http.request(
      {
        hostname: targetHost,
        port: targetPort,
        path: fullTargetPath,
        method: req.method,
        headers: reqHeaders,
        timeout: 30000,
      },
      (proxyRes) => {
        preferredLoopbackHost.set(targetPort, targetHost);
        const respHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };
        if (stripPrefix && typeof respHeaders.location === 'string' && respHeaders.location.startsWith('/')) {
          if (!respHeaders.location.startsWith(stripPrefix)) {
            respHeaders.location = `${stripPrefix}${respHeaders.location}`;
          }
        }

        if (shouldCheckBareRoot404 && proxyRes.statusCode === 404 && !proxyRes.headers['content-encoding']) {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          let bypassed = false;

          proxyRes.on('data', (chunk: Buffer) => {
            if (bypassed) return;
            totalBytes += chunk.length;
            if (totalBytes > 4096) {
              bypassed = true;
              res.writeHead(404, respHeaders);
              for (const c of chunks) res.write(c);
              res.write(chunk);
              proxyRes.pipe(res);
              return;
            }
            chunks.push(chunk);
          });

          proxyRes.on('end', () => {
            if (bypassed || res.headersSent) return;
            const bodyBuf = Buffer.concat(chunks);
            const bodyText = bodyBuf.toString('utf-8');
            const isBareRoot404 =
              /cannot\s+get\s+\//i.test(bodyText) ||
              /^\s*(?:not found|404(?:\s+not found)?)\s*$/i.test(bodyText);

            if (!isBareRoot404) {
              res.writeHead(404, respHeaders);
              res.end(bodyBuf);
              return;
            }

            void probeLiveBotRoutes(targetPort)
              .then((routes) => {
                sendRootBotGatewayPage(res, dep, targetPort, stripPrefix, routes);
              })
              .catch(() => {
                sendRootBotGatewayPage(res, dep, targetPort, stripPrefix, []);
              });
          });
          return;
        }

        const contentType = String(proxyRes.headers['content-type'] || '').toLowerCase();
        if (
          stripPrefix &&
          req.method === 'GET' &&
          contentType.includes('text/html') &&
          !proxyRes.headers['content-encoding']
        ) {
          const htmlChunks: Buffer[] = [];
          let htmlBytes = 0;
          let streamed = false;

          proxyRes.on('data', (chunk: Buffer) => {
            if (streamed) return;
            htmlBytes += chunk.length;
            if (htmlBytes > 1024 * 1024) {
              streamed = true;
              res.writeHead(proxyRes.statusCode || 200, respHeaders);
              for (const c of htmlChunks) res.write(c);
              res.write(chunk);
              proxyRes.pipe(res);
              return;
            }
            htmlChunks.push(chunk);
          });

          proxyRes.on('end', () => {
            if (streamed || res.headersSent) return;
            const rawHtml = Buffer.concat(htmlChunks).toString('utf-8');
            const modifiedHtml = rewriteHtmlForSubpathProxy(rawHtml, stripPrefix);
            const finalHeaders = { ...respHeaders };
            delete finalHeaders['content-length'];
            res.writeHead(proxyRes.statusCode || 200, finalHeaders);
            res.end(modifiedHtml, 'utf-8');
          });
          return;
        }

        res.writeHead(proxyRes.statusCode || 502, respHeaders);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error('Upstream request timed out.'));
    });

    proxyReq.on('error', (err: NodeJS.ErrnoException) => {
      if (!hasRetried && canRetryBodyless && err.code === 'ECONNREFUSED') {
        const altHost: '127.0.0.1' | '::1' = targetHost === '127.0.0.1' ? '::1' : '127.0.0.1';
        attemptProxy(altHost, true);
        return;
      }
      sendProxyUnavailable(
        req,
        res,
        dep,
        502,
        `Process is running, but no HTTP web server is listening on assigned port ${targetPort}. (Background bots without an HTTP server can still be monitored via their UptimeRobot link.)`
      );
    });

    if (canRetryBodyless) {
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
  };

  attemptProxy(initialHost, false);
}

export function proxyWebSocketUpgrade(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  resolution: ProxyResolution
): void {
  const { dep, stripPrefix } = resolution;
  if (dep.status !== 'online' || (dep.expiresAt && Date.parse(dep.expiresAt) <= Date.now())) {
    socket.destroy();
    return;
  }

  const targetPort = resolveDeploymentInternalPort(dep);
  const rawUrl = request.url || '/';
  const [rawPath, rawQuery] = rawUrl.split('?');
  let targetPath = rawPath;
  if (stripPrefix && targetPath.startsWith(stripPrefix)) {
    targetPath = targetPath.slice(stripPrefix.length) || '/';
    if (!targetPath.startsWith('/')) targetPath = `/${targetPath}`;
  }
  const fullTargetPath = rawQuery ? `${targetPath}?${rawQuery}` : targetPath;

  const initialHost = preferredLoopbackHost.get(targetPort) || '127.0.0.1';
  const connectUpstream = (targetHost: '127.0.0.1' | '::1', hasRetried: boolean): void => {
    let connected = false;
    const upstream = net.connect(targetPort, targetHost, () => {
      connected = true;
      preferredLoopbackHost.set(targetPort, targetHost);
      const headerLines = [`${request.method || 'GET'} ${fullTargetPath} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const k = request.rawHeaders[i];
        const v = request.rawHeaders[i + 1] ?? '';
        if (k.toLowerCase() === 'host') {
          headerLines.push(`Host: ${targetHost === '::1' ? '[::1]' : '127.0.0.1'}:${targetPort}`);
        } else {
          headerLines.push(`${k}: ${v}`);
        }
      }
      headerLines.push('', '');
      upstream.write(headerLines.join('\r\n'));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (!connected && !hasRetried && err.code === 'ECONNREFUSED') {
        connectUpstream(targetHost === '127.0.0.1' ? '::1' : '127.0.0.1', true);
        return;
      }
      socket.destroy();
    });
    socket.on('error', () => {
      upstream.destroy();
    });
  };

  connectUpstream(initialHost, false);
}

export async function verifyCustomDomainDns(
  domain: string,
  serverHost: string
): Promise<{
  verified: boolean;
  cnames: string[];
  domainIps: string[];
  serverIps: string[];
  message: string;
}> {
  const normalizedDomain = normalizeHostname(domain);
  const cleanServerHost = serverHost.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
  if (!normalizedDomain) {
    return {
      verified: false,
      cnames: [],
      domainIps: [],
      serverIps: [],
      message: 'Invalid hostname.',
    };
  }

  let cnames: string[] = [];
  let domainIps: string[] = [];
  let serverIps: string[] = [];

  try {
    cnames = (await dns.resolveCname(normalizedDomain)).map((c) => c.toLowerCase().replace(/\.+$/, ''));
  } catch {
    cnames = [];
  }

  try {
    domainIps = await dns.resolve4(normalizedDomain);
  } catch {
    domainIps = [];
  }

  if (cleanServerHost && net.isIP(cleanServerHost) === 0 && cleanServerHost !== 'localhost') {
    try {
      serverIps = await dns.resolve4(cleanServerHost);
    } catch {
      serverIps = [];
    }
  }

  const cnameMatch = Boolean(cleanServerHost && cnames.some((c) => c === cleanServerHost));
  const ipMatch =
    domainIps.length > 0 && serverIps.length > 0 && domainIps.some((ip) => serverIps.includes(ip));
  const isRailwaySubdomain = normalizedDomain.endsWith('.up.railway.app') && domainIps.length > 0;

  const verified = cnameMatch || ipMatch || isRailwaySubdomain;
  const message = verified
    ? cnameMatch
      ? `Verified: CNAME points cleanly to ${cleanServerHost}.`
      : isRailwaySubdomain && !ipMatch
        ? `Verified: Railway domain resolves (${domainIps[0]}). Ensure ${normalizedDomain} is added under Railway Service → Settings → Networking.`
        : `Verified: Domain IP (${domainIps[0]}) matches your server IP.`
    : cnames.length > 0
      ? `DNS resolves to ${cnames[0]} instead of ${cleanServerHost || 'your server host'}. Update your CNAME target and retry.`
      : domainIps.length > 0 && serverIps.length > 0
        ? `DNS A record points to ${domainIps[0]}, expected ${serverIps[0]} (or CNAME ${cleanServerHost}).`
        : `No matching CNAME/A record found yet for ${normalizedDomain}. Add CNAME → ${cleanServerHost || 'your server host'} and allow DNS propagation.`;

  return {
    verified,
    cnames,
    domainIps,
    serverIps,
    message,
  };
}

export function buildDeploymentNetworkingInfo(params: {
  dep: BotDeployment;
  origin: string;
  serverHost: string;
  railwayDomain?: string;
  railwayDomainSource?: 'preference' | 'env' | 'detected' | 'none';
  platformWildcardDomain?: string;
}): DeploymentNetworkingInfo {
  const {
    dep,
    origin,
    serverHost,
    railwayDomain,
    railwayDomainSource = 'none',
    platformWildcardDomain,
  } = params;
  const supported = supportsPublicEndpoints(dep);
  const cleanRailwayDomain = railwayDomain ? normalizeHostname(railwayDomain) || '' : '';
  const cleanOrigin = (cleanRailwayDomain ? `https://${cleanRailwayDomain}` : origin).replace(/\/+$/, '');
  const effectiveServerHost = cleanRailwayDomain || serverHost;
  const slug = dep.appSlug || dep.id;
  const token = dep.monitorToken || '';
  const wildcard = platformWildcardDomain ? normalizeHostname(platformWildcardDomain) : null;
  const enabled = supported && dep.publicAppEnabled !== false;

  const pathAppUrl = enabled && cleanOrigin ? `${cleanOrigin}/app/${slug}/` : null;
  const subdomainAppUrl = enabled && wildcard ? `https://${slug}.${wildcard}/` : null;
  const customDomainUrl =
    enabled && dep.customDomain ? `https://${dep.customDomain}/` : null;
  const uptimeMonitorUrl =
    enabled && cleanOrigin && token ? `${cleanOrigin}/up/${dep.id}/${token}` : null;

  return {
    supported,
    publicAppEnabled: enabled,
    appSlug: slug,
    monitorToken: token,
    internalPort: resolveDeploymentInternalPort(dep),
    pathAppUrl,
    subdomainAppUrl,
    customDomain: dep.customDomain ?? null,
    customDomainVerified: Boolean(dep.customDomainVerified),
    customDomainUrl,
    uptimeMonitorUrl,
    serverHost: effectiveServerHost,
    railwayDomain: cleanRailwayDomain,
    railwayDomainSource: cleanRailwayDomain ? railwayDomainSource : 'none',
    platformWildcardDomain: wildcard || '',
  };
}
