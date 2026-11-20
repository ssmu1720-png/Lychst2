// Read Resend API key from environment variable so secrets are never committed to source control.
function getResendApiKey(): string {
  return process.env.RESEND_API_KEY?.trim() || '';
}
const RESEND_DEFAULT_FROM = 'Lyrihost <onboarding@resend.dev>';

let cachedResendFrom: { value: string; expiresAt: number } | null = null;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function resolveResendFromAddress(): Promise<string> {
  if (process.env.RESEND_FROM_EMAIL?.trim()) {
    return process.env.RESEND_FROM_EMAIL.trim();
  }
  const now = Date.now();
  if (cachedResendFrom && cachedResendFrom.expiresAt > now) {
    return cachedResendFrom.value;
  }

  let resolvedFrom = RESEND_DEFAULT_FROM;
  const apiKey = getResendApiKey();
  if (!apiKey) return resolvedFrom;
  try {
    const resp = await fetch('https://api.resend.com/domains', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (resp.ok) {
      const payload = (await resp.json()) as {
        data?: Array<{ name?: string; status?: string }>;
      };
      const verifiedDomain = (payload.data ?? []).find(
        (d) =>
          d.status === 'verified' &&
          typeof d.name === 'string' &&
          d.name.trim().length > 0
      );
      if (verifiedDomain?.name) {
        resolvedFrom = `Lyrihost <noreply@${verifiedDomain.name.trim()}>`;
      }
    }
  } catch {
    // Fall back to Resend default onboarding sender
  }

  cachedResendFrom = {
    value: resolvedFrom,
    expiresAt: now + 60 * 1000,
  };
  return resolvedFrom;
}

export async function sendRawResendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ id: string }> {
  const apiKey = getResendApiKey();
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is not configured.');
  }
  const fromAddress = await resolveResendFromAddress();
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      text: params.text,
    }),
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

  if (!resp.ok || !payload?.id) {
    const errDetail =
      payload?.message || payload?.error || `Resend API error (${resp.status})`;
    throw new Error(errDetail);
  }

  return { id: payload.id };
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
