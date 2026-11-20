import crypto from 'node:crypto';

// Default CourtneyTech M-Pesa API base URL + B2CCOURTNEY credentials saved directly server-side
export const DEFAULT_MPESA_GATEWAY_URL = 'https://courtneytech.xyz/api';

export const B2CCOURTNEY_API_SECRET =
  process.env.MPESA_API_SECRET ||
  process.env.B2CCOURTNEY_API_SECRET ||
  'courtneytech_secret_81fe1faf08434ac39ba36f75901c89e2e92ec60609576f24b05497c7a605bc79';

export const B2CCOURTNEY_API_KEY =
  process.env.MPESA_API_KEY ||
  process.env.B2CCOURTNEY_API_KEY ||
  'courtneytech_key_908077ef29a293668abc56ca290a15243d8659dbd57386ef';

export function getConfiguredMpesaGatewayUrl(): string {
  const raw = (
    process.env.MPESA_GATEWAY_URL ||
    process.env.B2CCOURTNEY_BASE_URL ||
    process.env.COURTNEY_MPESA_URL ||
    DEFAULT_MPESA_GATEWAY_URL
  ).trim();
  return raw.replace(/\/+$/, '');
}

export function getMpesaGatewayInfo(): {
  credentialsSaved: boolean;
  gatewayConfigured: boolean;
  gatewayUrlHint: string;
  keyPrefix: string;
} {
  const url = getConfiguredMpesaGatewayUrl();
  let hostHint = url;
  try {
    hostHint = new URL(url).host;
  } catch {
    hostHint = url;
  }
  return {
    credentialsSaved: Boolean(B2CCOURTNEY_API_KEY && B2CCOURTNEY_API_SECRET),
    gatewayConfigured: Boolean(url),
    gatewayUrlHint: hostHint,
    keyPrefix: `${B2CCOURTNEY_API_KEY.slice(0, 24)}...`,
  };
}

/**
 * Normalizes Kenyan Safaricom phone numbers into 2547XXXXXXXX or 2541XXXXXXXX format.
 */
export function normalizeKenyanPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (/^0[71]\d{8}$/.test(digits)) {
    return `254${digits.slice(1)}`;
  }
  if (/^[71]\d{8}$/.test(digits)) {
    return `254${digits}`;
  }
  if (/^254[71]\d{8}$/.test(digits)) {
    return digits;
  }
  throw new Error(
    'Enter a valid Kenyan M-Pesa phone number (e.g. 0712345678, 0112345678, or 254712345678).'
  );
}

export interface StkPushDispatchResult {
  dispatched: boolean;
  gatewayConfigured: boolean;
  checkoutRequestId: string | null;
  merchantRequestId: string | null;
  customerMessage: string;
}

let cachedPaymentAccountId: { value: number | string; expiresAt: number } | null = null;

async function resolveCourtneyPaymentAccountId(baseApiUrl: string): Promise<number | string> {
  const envAccountId = process.env.MPESA_PAYMENT_ACCOUNT_ID?.trim();
  if (envAccountId) {
    const asNum = Number(envAccountId);
    return Number.isFinite(asNum) && asNum > 0 ? asNum : envAccountId;
  }

  if (cachedPaymentAccountId && cachedPaymentAccountId.expiresAt > Date.now()) {
    return cachedPaymentAccountId.value;
  }

  const resp = await fetch(`${baseApiUrl}/v2/accounts`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-API-Key': B2CCOURTNEY_API_KEY,
      'X-API-Secret': B2CCOURTNEY_API_SECRET,
    },
    signal: AbortSignal.timeout(10000),
  });

  const text = await resp.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  if (!resp.ok) {
    const errMsg =
      (typeof parsed.message === 'string' && parsed.message) ||
      (typeof parsed.error === 'string' && parsed.error) ||
      `HTTP ${resp.status} while loading CourtneyTech payment accounts`;
    throw new Error(errMsg);
  }

  const listCandidate =
    (Array.isArray(parsed.accounts) && parsed.accounts) ||
    (Array.isArray(parsed.data) && parsed.data) ||
    (Array.isArray((parsed.data as Record<string, unknown> | undefined)?.accounts) &&
      ((parsed.data as Record<string, unknown>).accounts as unknown[])) ||
    [];

  for (const item of listCandidate) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const rawId = obj.payment_account_id ?? obj.account_id ?? obj.id;
    if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
      const numVal = Number(rawId);
      const resolved = Number.isFinite(numVal) && numVal > 0 ? numVal : String(rawId);
      cachedPaymentAccountId = { value: resolved, expiresAt: Date.now() + 5 * 60 * 1000 };
      return resolved;
    }
  }

  throw new Error(
    'Your CourtneyTech API keys authenticated, but no receiving M-Pesa account (Till/Paybill/Phone) is added yet in CourtneyTech (/v2/accounts returned []). Add a payment account in your courtneytech.xyz dashboard.'
  );
}

export async function initiateMpesaStkPush(params: {
  requestId: string;
  phoneNumber: string;
  amountKsh: number;
  coins: number;
  email: string;
  callbackUrl: string;
}): Promise<StkPushDispatchResult> {
  const baseApiUrl = getConfiguredMpesaGatewayUrl();
  if (!baseApiUrl) {
    return {
      dispatched: false,
      gatewayConfigured: false,
      checkoutRequestId: null,
      merchantRequestId: null,
      customerMessage:
        'STK Push queued as PENDING (0 Coins credited). Gateway URL missing — coins are NEVER allocated until payment is confirmed.',
    };
  }

  try {
    const paymentAccountId = await resolveCourtneyPaymentAccountId(baseApiUrl);
    const shortRef = params.requestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
    const shortDesc = `Lyrihost Coin`.slice(0, 13);

    const payload = {
      payment_account_id: paymentAccountId,
      phone: params.phoneNumber,
      amount: params.amountKsh,
      reference: shortRef,
      description: shortDesc,
      callback_url: params.callbackUrl,
    };

    const stkUrl = baseApiUrl.endsWith('/stkpush') ? baseApiUrl : `${baseApiUrl}/v2/stkpush`;
    const resp = await fetch(stkUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': B2CCOURTNEY_API_KEY,
        'X-API-Secret': B2CCOURTNEY_API_SECRET,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    const text = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    if (!resp.ok || parsed.success === false) {
      const errMsg =
        (typeof parsed.message === 'string' && parsed.message) ||
        (typeof parsed.error === 'string' && parsed.error) ||
        `CourtneyTech M-Pesa gateway returned HTTP ${resp.status}`;
      throw new Error(errMsg);
    }

    const nestedData =
      parsed.data && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>)
        : {};

    const checkoutId =
      (typeof parsed.checkout_request_id === 'string' && parsed.checkout_request_id) ||
      (typeof nestedData.checkout_request_id === 'string' && nestedData.checkout_request_id) ||
      (typeof parsed.CheckoutRequestID === 'string' && parsed.CheckoutRequestID) ||
      (typeof parsed.checkoutRequestId === 'string' && parsed.checkoutRequestId) ||
      (typeof parsed.transaction_id === 'string' && parsed.transaction_id) ||
      params.requestId;

    const merchantId =
      (typeof parsed.merchant_request_id === 'string' && parsed.merchant_request_id) ||
      (typeof nestedData.merchant_request_id === 'string' && nestedData.merchant_request_id) ||
      (typeof parsed.MerchantRequestID === 'string' && parsed.MerchantRequestID) ||
      (typeof parsed.merchantRequestId === 'string' && parsed.merchantRequestId) ||
      null;

    const msg =
      (typeof parsed.customer_message === 'string' && parsed.customer_message) ||
      (typeof parsed.CustomerMessage === 'string' && parsed.CustomerMessage) ||
      (typeof parsed.message === 'string' && parsed.message) ||
      `M-Pesa STK prompt sent to ${params.phoneNumber}. Enter your M-Pesa PIN to confirm ${params.amountKsh} KSH; coins will be credited upon confirmation.`;

    return {
      dispatched: true,
      gatewayConfigured: true,
      checkoutRequestId: checkoutId,
      merchantRequestId: merchantId,
      customerMessage: msg,
    };
  } catch (err) {
    const errText = err instanceof Error ? err.message : 'Unable to reach CourtneyTech M-Pesa API';
    return {
      dispatched: false,
      gatewayConfigured: true,
      checkoutRequestId: null,
      merchantRequestId: null,
      customerMessage: `M-Pesa STK dispatch failed (${errText}). Request marked FAILED — 0 Coins credited.`,
    };
  }
}

export async function queryRemoteMpesaStatus(checkoutRequestId: string): Promise<{
  checked: boolean;
  confirmed: boolean;
  failed: boolean;
  mpesaReceipt?: string;
  resultDesc?: string;
}> {
  const baseApiUrl = getConfiguredMpesaGatewayUrl();
  if (!baseApiUrl || !checkoutRequestId) {
    return { checked: false, confirmed: false, failed: false };
  }

  const statusUrl =
    process.env.MPESA_STATUS_URL?.trim() || `${baseApiUrl}/v2/status`;

  try {
    const resp = await fetch(statusUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': B2CCOURTNEY_API_KEY,
        'X-API-Secret': B2CCOURTNEY_API_SECRET,
      },
      body: JSON.stringify({
        checkout_request_id: checkoutRequestId,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      return { checked: false, confirmed: false, failed: false };
    }
    const raw = (await resp.json()) as Record<string, unknown>;
    const data =
      raw.data && typeof raw.data === 'object' ? { ...raw, ...(raw.data as Record<string, unknown>) } : raw;

    const statusRaw = String(data.status || data.state || '').toLowerCase();
    const resultCode = data.ResultCode ?? data.resultCode ?? data.result_code;
    const receipt =
      (typeof data.MpesaReceiptNumber === 'string' && data.MpesaReceiptNumber) ||
      (typeof data.mpesa_receipt_number === 'string' && data.mpesa_receipt_number) ||
      (typeof data.mpesaReceipt === 'string' && data.mpesaReceipt) ||
      (typeof data.transaction_code === 'string' && data.transaction_code) ||
      (typeof data.receipt === 'string' && data.receipt) ||
      undefined;
    const resultDesc =
      (typeof data.ResultDesc === 'string' && data.ResultDesc) ||
      (typeof data.result_desc === 'string' && data.result_desc) ||
      (typeof data.message === 'string' && data.message) ||
      undefined;

    if (
      (resultCode === 0 ||
        resultCode === '0' ||
        statusRaw === 'completed' ||
        statusRaw === 'paid' ||
        statusRaw === 'success' ||
        statusRaw === 'confirmed') &&
      Boolean(receipt)
    ) {
      return { checked: true, confirmed: true, failed: false, mpesaReceipt: receipt, resultDesc };
    }

    if (
      statusRaw === 'failed' ||
      statusRaw === 'cancelled' ||
      statusRaw === 'rejected' ||
      (resultCode !== undefined &&
        resultCode !== 0 &&
        resultCode !== '0' &&
        resultCode !== 1001 &&
        resultCode !== '1001')
    ) {
      return { checked: true, confirmed: false, failed: true, resultDesc };
    }

    return { checked: true, confirmed: false, failed: false, resultDesc };
  } catch {
    return { checked: false, confirmed: false, failed: false };
  }
}

function safeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies inbound webhook callbacks from B2CCOURTNEY / M-Pesa gateway.
 * Rejects unauthenticated callbacks so no attacker can forge paid webhooks for free coins.
 */
export function verifyMpesaCallbackSecret(
  headers: Record<string, string | string[] | undefined>,
  rawBodyObj: Record<string, unknown>
): boolean {
  const headerSecret =
    (typeof headers['x-api-secret'] === 'string' && headers['x-api-secret']) ||
    (typeof headers['x-courtney-secret'] === 'string' && headers['x-courtney-secret']) ||
    (typeof headers['x-webhook-secret'] === 'string' && headers['x-webhook-secret']) ||
    '';

  if (headerSecret && safeEqualString(headerSecret.trim(), B2CCOURTNEY_API_SECRET)) {
    return true;
  }

  const authHeader = typeof headers.authorization === 'string' ? headers.authorization : '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch && safeEqualString(bearerMatch[1].trim(), B2CCOURTNEY_API_SECRET)) {
    return true;
  }

  const bodySecret =
    (typeof rawBodyObj.apiSecret === 'string' && rawBodyObj.apiSecret) ||
    (typeof rawBodyObj.secret === 'string' && rawBodyObj.secret) ||
    '';
  if (bodySecret && safeEqualString(bodySecret.trim(), B2CCOURTNEY_API_SECRET)) {
    return true;
  }

  const signature =
    typeof headers['x-signature'] === 'string' ? headers['x-signature'].trim() : '';
  if (signature) {
    const expectedHmac = crypto
      .createHmac('sha256', B2CCOURTNEY_API_SECRET)
      .update(JSON.stringify(rawBodyObj))
      .digest('hex');
    if (safeEqualString(signature, expectedHmac)) {
      return true;
    }
  }

  return false;
}
