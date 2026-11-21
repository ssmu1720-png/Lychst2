import net from 'node:net';
import tls from 'node:tls';

const RESEND_DEFAULT_FROM = 'Lyrihost <onboarding@resend.dev>';

const SHARED_PAAS_DOMAINS = [
  'up.railway.app',
  'railway.app',
  'onrender.com',
  'vercel.app',
  'herokuapp.com',
  'run.app',
  'hf.space',
  'fly.dev',
  'pages.dev',
  'netlify.app',
  'localhost',
];

let cachedResendDomains: { domains: string[]; expiresAt: number } | null = null;

function getResendApiKey(): string {
  return process.env.RESEND_API_KEY?.trim() || '';
}

function getBrevoApiKey(): string {
  return process.env.BREVO_API_KEY?.trim() || '';
}

function getSmtpConfig(): {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
} | null {
  const user = process.env.SMTP_USER?.trim() || '';
  const pass = process.env.SMTP_PASS?.trim() || '';
  let host = process.env.SMTP_HOST?.trim() || '';

  if (!host && user) {
    const lower = user.toLowerCase();
    if (lower.endsWith('@gmail.com') || lower.endsWith('@googlemail.com')) {
      host = 'smtp.gmail.com';
    } else if (lower.endsWith('@outlook.com') || lower.endsWith('@hotmail.com')) {
      host = 'smtp-mail.outlook.com';
    } else if (lower.endsWith('@zoho.com')) {
      host = 'smtp.zoho.com';
    }
  }

  if (!host || !user || !pass) {
    return null;
  }

  const parsedPort = Number.parseInt(process.env.SMTP_PORT?.trim() || '', 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : host === 'smtp.gmail.com' ? 465 : 587;
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE.trim().toLowerCase() === 'true'
    : port === 465;
  const from =
    process.env.SMTP_FROM?.trim() ||
    process.env.MAIL_FROM_EMAIL?.trim() ||
    `Lyrihost <${user}>`;

  return { host, port, secure, user, pass, from };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseFromHeader(rawFrom: string): { name: string; email: string } {
  const trimmed = rawFrom.trim();
  const angleMatch = trimmed.match(/^(.*?)<([^>]+)>$/);
  if (angleMatch) {
    return {
      name: angleMatch[1].trim().replace(/^"|"$/g, '') || 'Lyrihost',
      email: angleMatch[2].trim(),
    };
  }
  return { name: 'Lyrihost', email: trimmed };
}

export function extractEmailDomain(addressOrHeader: string): string {
  const { email } = parseFromHeader(addressOrHeader);
  const atIdx = email.lastIndexOf('@');
  if (atIdx === -1) return '';
  return email.slice(atIdx + 1).trim().toLowerCase();
}

export function isSharedPaasDomain(domain: string): boolean {
  const clean = domain.trim().toLowerCase();
  if (!clean) return false;
  return SHARED_PAAS_DOMAINS.some(
    (suffix) => clean === suffix || clean.endsWith(`.${suffix}`)
  );
}

async function fetchVerifiedResendDomains(apiKey: string): Promise<string[]> {
  const now = Date.now();
  if (cachedResendDomains && cachedResendDomains.expiresAt > now) {
    return cachedResendDomains.domains;
  }

  const verified: string[] = [];
  try {
    const resp = await fetch('https://api.resend.com/domains', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const payload = (await resp.json()) as {
        data?: Array<{ name?: string; status?: string }>;
      };
      for (const d of payload.data ?? []) {
        if (d.status === 'verified' && typeof d.name === 'string' && d.name.trim()) {
          verified.push(d.name.trim().toLowerCase());
        }
      }
    }
  } catch {
    // Ignore domain list lookup network failures
  }

  cachedResendDomains = {
    domains: verified,
    expiresAt: now + 60 * 1000,
  };
  return verified;
}

export async function resolveResendFromAddress(): Promise<{
  fromAddress: string;
  verifiedDomains: string[];
  ignoredUnverifiedFrom: string | null;
}> {
  const apiKey = getResendApiKey();
  const configuredFrom =
    process.env.RESEND_FROM_EMAIL?.trim() || process.env.MAIL_FROM_EMAIL?.trim() || '';

  const verifiedDomains = apiKey ? await fetchVerifiedResendDomains(apiKey) : [];

  if (configuredFrom) {
    const configuredDomain = extractEmailDomain(configuredFrom);
    if (
      configuredDomain &&
      (configuredDomain === 'resend.dev' || verifiedDomains.includes(configuredDomain))
    ) {
      return {
        fromAddress: configuredFrom,
        verifiedDomains,
        ignoredUnverifiedFrom: null,
      };
    }

    // Never send an unverified shared PaaS domain (e.g. *.up.railway.app) to Resend
    if (isSharedPaasDomain(configuredDomain) || (verifiedDomains.length === 0 && configuredDomain !== 'resend.dev')) {
      const fallback =
        verifiedDomains.length > 0
          ? `Lyrihost <noreply@${verifiedDomains[0]}>`
          : RESEND_DEFAULT_FROM;
      return {
        fromAddress: fallback,
        verifiedDomains,
        ignoredUnverifiedFrom: configuredFrom,
      };
    }

    return {
      fromAddress: configuredFrom,
      verifiedDomains,
      ignoredUnverifiedFrom: null,
    };
  }

  if (verifiedDomains.length > 0) {
    return {
      fromAddress: `Lyrihost <noreply@${verifiedDomains[0]}>`,
      verifiedDomains,
      ignoredUnverifiedFrom: null,
    };
  }

  return {
    fromAddress: RESEND_DEFAULT_FROM,
    verifiedDomains,
    ignoredUnverifiedFrom: null,
  };
}

export interface EmailTransportStatus {
  configured: boolean;
  activeProvider: 'resend-verified' | 'brevo' | 'smtp' | 'resend-sandbox' | 'none';
  resendConfigured: boolean;
  resendVerifiedDomains: string[];
  resendSandboxOnly: boolean;
  resendFromIgnoredWarning: string | null;
  brevoConfigured: boolean;
  smtpConfigured: boolean;
  smtpHost: string | null;
  railwayDomainDetected: string | null;
  guidance: string;
}

export async function getEmailTransportStatus(): Promise<EmailTransportStatus> {
  const resendKey = getResendApiKey();
  const brevoKey = getBrevoApiKey();
  const smtp = getSmtpConfig();
  const railwayDomain =
    process.env.RAILWAY_PUBLIC_DOMAIN?.trim() ||
    process.env.RAILWAY_STATIC_URL?.trim() ||
    null;

  let verifiedDomains: string[] = [];
  let ignoredWarning: string | null = null;

  if (resendKey) {
    const resolved = await resolveResendFromAddress();
    verifiedDomains = resolved.verifiedDomains;
    if (resolved.ignoredUnverifiedFrom) {
      ignoredWarning = `Ignored unverified sender "${resolved.ignoredUnverifiedFrom}" (shared PaaS/Railway domains cannot be DNS-verified on Resend).`;
    }
  }

  const resendSandboxOnly = Boolean(resendKey) && verifiedDomains.length === 0;
  const activeProvider: EmailTransportStatus['activeProvider'] =
    resendKey && verifiedDomains.length > 0
      ? 'resend-verified'
      : brevoKey
        ? 'brevo'
        : smtp
          ? 'smtp'
          : resendKey
            ? 'resend-sandbox'
            : 'none';

  let guidance = '';
  if (activeProvider === 'resend-verified') {
    guidance = `Verified Resend domain active (${verifiedDomains[0]}). Ready for all recipients.`;
  } else if (activeProvider === 'brevo') {
    guidance =
      'Brevo HTTPS API active. Works on Railway over port 443 without owning a custom domain.';
  } else if (activeProvider === 'smtp') {
    guidance = `SMTP transport configured (${smtp?.host}:${smtp?.port}). Note: if Railway trial blocks outbound SMTP ports, use BREVO_API_KEY instead.`;
  } else if (activeProvider === 'resend-sandbox') {
    guidance =
      'Resend is in Sandbox mode (onboarding@resend.dev), which only delivers to your own Resend account email. Railway *.up.railway.app domains cannot be verified on Resend — either add BREVO_API_KEY + BREVO_FROM_EMAIL (no domain needed, works over HTTPS on Railway), configure Gmail SMTP (SMTP_USER + SMTP_PASS App Password), or verify a custom domain at resend.com/domains.';
  } else {
    guidance =
      'No email provider configured. Set RESEND_API_KEY (with verified custom domain), BREVO_API_KEY + BREVO_FROM_EMAIL (domain-free HTTPS API for Railway), or SMTP_USER + SMTP_PASS.';
  }

  return {
    configured: activeProvider !== 'none',
    activeProvider,
    resendConfigured: Boolean(resendKey),
    resendVerifiedDomains: verifiedDomains,
    resendSandboxOnly,
    resendFromIgnoredWarning: ignoredWarning,
    brevoConfigured: Boolean(brevoKey),
    smtpConfigured: Boolean(smtp),
    smtpHost: smtp?.host ?? null,
    railwayDomainDetected: railwayDomain,
    guidance,
  };
}

function isResendDomainOrSandboxError(status: number, message: string): boolean {
  const lower = message.toLowerCase();
  return (
    status === 403 ||
    status === 422 ||
    lower.includes('only send testing emails') ||
    lower.includes('verify a domain') ||
    lower.includes('domain is not verified') ||
    lower.includes('not verified')
  );
}

async function sendViaResendApi(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ id: string }> {
  const apiKey = getResendApiKey();
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is not configured.');
  }

  const { fromAddress, verifiedDomains } = await resolveResendFromAddress();

  const postEmail = async (sender: string) => {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: sender,
        to: [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
      signal: AbortSignal.timeout(12000),
    });

    let payload: { id?: string; message?: string; error?: string } | null = null;
    try {
      payload = (await resp.json()) as {
        id?: string;
        message?: string;
        error?: string;
      };
    } catch {
      // ignore non-json body
    }

    const errDetail =
      payload?.message || payload?.error || `Resend API error (${resp.status})`;
    return { ok: resp.ok && Boolean(payload?.id), status: resp.status, id: payload?.id, errDetail };
  };

  let attempt = await postEmail(fromAddress);

  // If the configured sender failed because its domain is not verified on Resend,
  // clear cache and retry cleanly using onboarding@resend.dev or an actually verified domain.
  if (
    !attempt.ok &&
    fromAddress !== RESEND_DEFAULT_FROM &&
    attempt.errDetail.toLowerCase().includes('not verified')
  ) {
    cachedResendDomains = null;
    const retrySender =
      verifiedDomains.length > 0
        ? `Lyrihost <noreply@${verifiedDomains[0]}>`
        : RESEND_DEFAULT_FROM;
    attempt = await postEmail(retrySender);
  }

  if (!attempt.ok || !attempt.id) {
    const err = new Error(attempt.errDetail) as Error & { statusCode?: number; isSandboxOrDomain?: boolean };
    err.statusCode = attempt.status;
    err.isSandboxOrDomain = isResendDomainOrSandboxError(attempt.status, attempt.errDetail);
    throw err;
  }

  return { id: attempt.id };
}

async function sendViaBrevoApi(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ id: string }> {
  const apiKey = getBrevoApiKey();
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured.');
  }

  const rawFrom =
    process.env.BREVO_FROM_EMAIL?.trim() ||
    process.env.MAIL_FROM_EMAIL?.trim() ||
    process.env.SMTP_USER?.trim() ||
    '';

  if (!rawFrom) {
    throw new Error(
      'BREVO_FROM_EMAIL (e.g. "Lyrihost <your-verified-gmail@gmail.com>") is required when using BREVO_API_KEY.'
    );
  }

  const sender = parseFromHeader(rawFrom);
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: sender.name, email: sender.email },
      to: [{ email: params.to }],
      subject: params.subject,
      htmlContent: params.html,
      textContent: params.text,
    }),
    signal: AbortSignal.timeout(12000),
  });

  let payload: { messageId?: string; message?: string; code?: string } | null = null;
  try {
    payload = (await resp.json()) as { messageId?: string; message?: string; code?: string };
  } catch {
    // ignore non-json
  }

  if (!resp.ok || !payload?.messageId) {
    throw new Error(payload?.message || `Brevo API error (${resp.status})`);
  }

  return { id: payload.messageId };
}

function sendViaSmtp(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ id: string }> {
  const cfg = getSmtpConfig();
  if (!cfg) {
    return Promise.reject(new Error('SMTP credentials are not configured.'));
  }

  const sender = parseFromHeader(cfg.from);
  const boundary = `lyrihost_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2, 10)}@${extractEmailDomain(cfg.from) || 'lyrihost.local'}>`;

  const cleanSubject = params.subject.replace(/[\r\n]+/g, ' ').trim();
  const dotStuff = (raw: string) =>
    raw
      .replace(/\r?\n/g, '\r\n')
      .split('\r\n')
      .map((line) => (line.startsWith('.') ? '.' + line : line))
      .join('\r\n');

  const mimeBody = [
    `From: "${sender.name.replace(/"/g, '')}" <${sender.email}>`,
    `To: <${params.to}>`,
    `Subject: ${cleanSubject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(params.text, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(params.html, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${boundary}--`,
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    const rawSocket: net.Socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, timeout: 12000 })
      : net.connect({ host: cfg.host, port: cfg.port, timeout: 12000 });

    let socket: net.Socket | tls.TLSSocket = rawSocket;
    let buffer = '';
    const lineQueue: Array<{ resolve: (res: { code: number; lines: string[] }) => void; reject: (err: Error) => void }> = [];
    let currentLines: string[] = [];

    const attachSocketListeners = (sock: net.Socket | tls.TLSSocket) => {
      sock.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        while (true) {
          const idx = buffer.indexOf('\r\n');
          if (idx === -1) break;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          currentLines.push(line);
          if (/^\d{3} /.test(line)) {
            const code = Number.parseInt(line.slice(0, 3), 10);
            const lines = currentLines;
            currentLines = [];
            const waiter = lineQueue.shift();
            if (waiter) waiter.resolve({ code, lines });
          }
        }
      });
      sock.on('error', (err) => finishErr(err));
      sock.on('timeout', () => finishErr(new Error(`SMTP connection to ${cfg.host}:${cfg.port} timed out.`)));
    };

    attachSocketListeners(socket);

    const readResponse = (): Promise<{ code: number; lines: string[] }> =>
      new Promise((res, rej) => {
        lineQueue.push({ resolve: res, reject: rej });
      });

    const sendCmd = async (cmd: string, expectedCodes: number[]) => {
      socket.write(cmd + '\r\n');
      const reply = await readResponse();
      if (!expectedCodes.includes(reply.code)) {
        throw new Error(`SMTP error (${reply.code}): ${reply.lines.join(' | ')}`);
      }
      return reply;
    };

    (async () => {
      const greeting = await readResponse();
      if (greeting.code !== 220) {
        throw new Error(`Unexpected SMTP greeting (${greeting.code})`);
      }

      let ehlo = await sendCmd('EHLO lyrihost.local', [250]);

      if (!cfg.secure && ehlo.lines.some((l) => l.toUpperCase().includes('STARTTLS'))) {
        await sendCmd('STARTTLS', [220]);
        socket = tls.connect({
          socket: rawSocket,
          servername: cfg.host,
          timeout: 12000,
        });
        await new Promise<void>((res, rej) => {
          socket.once('secureConnect', () => res());
          socket.once('error', rej);
        });
        attachSocketListeners(socket);
        ehlo = await sendCmd('EHLO lyrihost.local', [250]);
      }

      const authLine = ehlo.lines.find((l) => /AUTH/i.test(l)) || '';
      if (/PLAIN/i.test(authLine)) {
        const plainToken = Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass}`, 'utf-8').toString('base64');
        await sendCmd(`AUTH PLAIN ${plainToken}`, [235]);
      } else {
        await sendCmd('AUTH LOGIN', [334]);
        await sendCmd(Buffer.from(cfg.user, 'utf-8').toString('base64'), [334]);
        await sendCmd(Buffer.from(cfg.pass, 'utf-8').toString('base64'), [235]);
      }

      await sendCmd(`MAIL FROM:<${sender.email}>`, [250]);
      await sendCmd(`RCPT TO:<${params.to}>`, [250, 251]);
      await sendCmd('DATA', [354]);
      await sendCmd(`${dotStuff(mimeBody)}\r\n.`, [250]);
      try {
        await sendCmd('QUIT', [221, 250]);
      } catch {
        // ignore QUIT failure after 250 OK
      }

      if (!settled) {
        settled = true;
        socket.end();
        resolve({ id: messageId });
      }
    })().catch((err) => {
      finishErr(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export async function sendRawResendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ id: string; provider?: string }> {
  const resendKey = getResendApiKey();
  const brevoKey = getBrevoApiKey();
  const smtp = getSmtpConfig();

  if (!resendKey && !brevoKey && !smtp) {
    throw new Error(
      'No email transport is configured. Set RESEND_API_KEY (with a verified custom domain), BREVO_API_KEY + BREVO_FROM_EMAIL (free HTTPS API for Railway with no domain required), or SMTP_USER + SMTP_PASS.'
    );
  }

  let resendErr: (Error & { isSandboxOrDomain?: boolean }) | null = null;

  // Prefer verified custom-domain Resend first, or Brevo/SMTP when Resend is unverified/sandbox
  const verifiedResendDomains = resendKey ? await fetchVerifiedResendDomains(resendKey) : [];
  const preferFallbackOverResend =
    Boolean(resendKey) && verifiedResendDomains.length === 0 && (Boolean(brevoKey) || Boolean(smtp));

  if (resendKey && !preferFallbackOverResend) {
    try {
      const res = await sendViaResendApi(params);
      return { id: res.id, provider: 'resend' };
    } catch (err) {
      resendErr = err as Error & { isSandboxOrDomain?: boolean };
      if (!brevoKey && !smtp) {
        if (resendErr.isSandboxOrDomain) {
          throw new Error(
            `${resendErr.message} (Tip for Railway: *.up.railway.app domains cannot be verified in Resend. Fix by setting BREVO_API_KEY + BREVO_FROM_EMAIL, or Gmail SMTP_USER + SMTP_PASS App Password, or verifying your own domain at resend.com/domains.)`
          );
        }
        throw resendErr;
      }
    }
  }

  if (brevoKey) {
    try {
      const res = await sendViaBrevoApi(params);
      return { id: res.id, provider: 'brevo' };
    } catch (brevoErr) {
      if (!smtp && !resendKey) throw brevoErr;
      if (!smtp && resendKey && preferFallbackOverResend) {
        // Fall through to Resend attempt if Brevo failed and SMTP isn't configured
      } else if (!smtp) {
        throw brevoErr;
      }
    }
  }

  if (smtp) {
    try {
      const res = await sendViaSmtp(params);
      return { id: res.id, provider: 'smtp' };
    } catch (smtpErr) {
      if (!resendKey || !preferFallbackOverResend) {
        throw smtpErr;
      }
    }
  }

  // Last resort: try Resend if it was skipped earlier in favor of Brevo/SMTP that failed
  if (resendKey && preferFallbackOverResend) {
    try {
      const res = await sendViaResendApi(params);
      return { id: res.id, provider: 'resend' };
    } catch (err) {
      const e = err as Error & { isSandboxOrDomain?: boolean };
      if (e.isSandboxOrDomain) {
        throw new Error(
          `${e.message} (Tip for Railway: *.up.railway.app domains cannot be verified in Resend. Set BREVO_API_KEY + BREVO_FROM_EMAIL or verify a custom domain at resend.com/domains.)`
        );
      }
      throw e;
    }
  }

  throw resendErr || new Error('Failed to send email via all configured transports.');
}

export async function sendOtpEmail(toEmail: string, otpCode: string): Promise<string> {
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#080305; color:#e2e8f0; padding:32px 24px; border:1px solid #450a0a; border-radius:10px; max-width:480px; margin:0 auto;">
      <div style="font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#f87171; font-weight:700; margin-bottom:12px;">
        LYRIHOST VERIFICATION
      </div>
      <h1 style="font-size:22px; color:#f8fafc; margin:0 0 10px 0;">Confirm your email address</h1>
      <p style="font-size:14px; color:#cbd5e1; line-height:1.55; margin:0 0 24px 0;">
        Enter the one-time verification code below to finish creating your Lyrihost account. This code expires in <strong>10 minutes</strong>.
      </p>
      <div style="background:#14060a; border:1px solid #dc2626; border-radius:8px; padding:18px 20px; text-align:center; margin-bottom:24px;">
        <span style="font-family:'IBM Plex Mono', monospace; font-size:32px; font-weight:700; letter-spacing:8px; color:#fecdd3;">${otpCode}</span>
      </div>
      <p style="font-size:12px; color:#94a3b8; margin:0;">
        If you did not request this verification code, you can safely ignore this message.
      </p>
    </div>
  `.trim();

  try {
    const result = await sendRawResendEmail({
      to: toEmail,
      subject: `Your Lyrihost verification code: ${otpCode}`,
      html,
      text: `Your Lyrihost verification code is ${otpCode}. It expires in 10 minutes.`,
    });
    return result.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to send OTP';
    throw new Error(`Failed to send verification email: ${msg}`);
  }
}

export async function sendLoginOtpEmail(toEmail: string, otpCode: string): Promise<string> {
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#080305; color:#e2e8f0; padding:32px 24px; border:1px solid #450a0a; border-radius:10px; max-width:480px; margin:0 auto;">
      <div style="font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#f87171; font-weight:700; margin-bottom:12px;">
        LYRIHOST LOGIN SECURITY OTP
      </div>
      <h1 style="font-size:22px; color:#f8fafc; margin:0 0 10px 0;">Confirm your sign-in</h1>
      <p style="font-size:14px; color:#cbd5e1; line-height:1.55; margin:0 0 24px 0;">
        Someone entered your password to log in to Lyrihost. Enter the one-time security code below within <strong>10 minutes</strong> to unlock your session.
      </p>
      <div style="background:#14060a; border:1px solid #dc2626; border-radius:8px; padding:18px 20px; text-align:center; margin-bottom:24px;">
        <span style="font-family:'IBM Plex Mono', monospace; font-size:32px; font-weight:700; letter-spacing:8px; color:#fecdd3;">${otpCode}</span>
      </div>
      <p style="font-size:12px; color:#94a3b8; margin:0;">
        If you did not attempt to sign in, change your password immediately and contact admin support.
      </p>
    </div>
  `.trim();

  try {
    const result = await sendRawResendEmail({
      to: toEmail,
      subject: `Lyrihost Login Security Code: ${otpCode}`,
      html,
      text: `Your Lyrihost Login Security OTP is ${otpCode}. It expires in 10 minutes.`,
    });
    return result.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to send login OTP';
    throw new Error(`Failed to send login security OTP email: ${msg}`);
  }
}

export async function sendBrandedNotificationEmail(params: {
  toEmail: string;
  badge: string;
  subject: string;
  heading: string;
  bodyText: string;
  highlightBox?: { label: string; value: string };
  footerNote?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const safeParagraphs = params.bodyText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="font-size:14px; color:#cbd5e1; line-height:1.6; margin:0 0 14px 0;">${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`
    )
    .join('');

  const highlightHtml = params.highlightBox
    ? `<div style="background:#14060a; border:1px solid #dc2626; border-radius:8px; padding:14px 18px; margin:18px 0; text-align:center;">
         <div style="font-size:11px; color:#f87171; letter-spacing:1.2px; text-transform:uppercase; margin-bottom:6px;">${escapeHtml(params.highlightBox.label)}</div>
         <div style="font-family:'IBM Plex Mono', monospace; font-size:22px; font-weight:700; color:#fecdd3;">${escapeHtml(params.highlightBox.value)}</div>
       </div>`
    : '';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#080305; color:#e2e8f0; padding:32px 24px; border:1px solid #450a0a; border-radius:10px; max-width:540px; margin:0 auto;">
      <div style="font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#f87171; font-weight:700; margin-bottom:10px;">
        ${escapeHtml(params.badge)}
      </div>
      <h1 style="font-size:22px; color:#f8fafc; margin:0 0 14px 0;">${escapeHtml(params.heading)}</h1>
      ${safeParagraphs}
      ${highlightHtml}
      <hr style="border:none; border-top:1px solid #3f0d16; margin:22px 0 14px 0;" />
      <p style="font-size:12px; color:#94a3b8; margin:0;">
        ${escapeHtml(params.footerNote || 'Lyrihost Cloud Bot Hosting Platform · 1 Coin = 1 KSH')}
      </p>
    </div>
  `.trim();

  try {
    const res = await sendRawResendEmail({
      to: params.toEmail,
      subject: params.subject,
      html,
      text: `${params.heading}\n\n${params.bodyText}${
        params.highlightBox
          ? `\n\n${params.highlightBox.label}: ${params.highlightBox.value}`
          : ''
      }\n\n${params.footerNote || 'Lyrihost Bot Hosting Platform'}`,
    });
    return { ok: true, id: res.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Email delivery failed',
    };
  }
}
