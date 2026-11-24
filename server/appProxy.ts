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

export function resolveDeploymentByProxyRequest(
  reqUrl: string,
  hostHeader: string | string[] | undefined,
  deployments: BotDeployment[],
  platformWildcardDomain?: string
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

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: fullTargetPath,
      method: req.method,
      headers: outgoingHeaders,
      timeout: 30000,
    },
    (proxyRes) => {
      const respHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };
      if (stripPrefix && typeof respHeaders.location === 'string' && respHeaders.location.startsWith('/')) {
        if (!respHeaders.location.startsWith(stripPrefix)) {
          respHeaders.location = `${stripPrefix}${respHeaders.location}`;
        }
      }
      res.writeHead(proxyRes.statusCode || 502, respHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error('Upstream request timed out.'));
  });

  proxyReq.on('error', () => {
    sendProxyUnavailable(
      req,
      res,
      dep,
      502,
      `Process is running, but no HTTP web server is listening on assigned port ${targetPort}. (Background bots without an HTTP server can still be monitored via their UptimeRobot link.)`
    );
  });

  req.pipe(proxyReq);
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

  const upstream = net.connect(targetPort, '127.0.0.1', () => {
    const headerLines = [`${request.method || 'GET'} ${fullTargetPath} HTTP/1.1`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const k = request.rawHeaders[i];
      const v = request.rawHeaders[i + 1] ?? '';
      if (k.toLowerCase() === 'host') {
        headerLines.push(`Host: 127.0.0.1:${targetPort}`);
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

  upstream.on('error', () => {
    socket.destroy();
  });
  socket.on('error', () => {
    upstream.destroy();
  });
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
