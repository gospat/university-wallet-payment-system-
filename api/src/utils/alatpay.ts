import * as crypto from 'crypto';
import { AppError } from './AppError';

export const ALATPAY_CURRENCY_ENUM_ORDINAL_NGN: 0 | 1 | 2 | 3 = (() => {
  const raw = process.env.ALATPAY_CURRENCY_ORDINAL_NGN;
  const n = raw !== undefined && raw !== null ? Number(String(raw).trim()) : NaN;
  if (Number.isInteger(n) && n >= 0 && n <= 3) return n as 0 | 1 | 2 | 3;
  return 2;
})();

export const ALATPAY_CHANNEL_CODES: Readonly<Record<string, string>> = {
  card: process.env.ALATPAY_CHANNEL_CARD ?? '1',
  bank: process.env.ALATPAY_CHANNEL_BANK ?? '2',
  bank_transfer: process.env.ALATPAY_CHANNEL_BANK_TRANSFER ?? '2',
  ussd: process.env.ALATPAY_CHANNEL_USSD ?? '5',
  bank_details: process.env.ALATPAY_CHANNEL_BANK_DETAILS ?? '3',
  static_account: process.env.ALATPAY_CHANNEL_STATIC ?? '8',
};

export function isAlatpayPassChargeEnabled(): boolean {
  const raw = process.env.ALATPAY_PASS_CHARGE_TO_CUSTOMER;
  return String(raw ?? 'false').trim().toLowerCase() === 'true';
}

export function getDefaultEmailDomain(): string {
  const raw = process.env.DEFAULT_EMAIL_FALLBACK_DOMAIN;
  return raw && String(raw).trim() ? String(raw).trim().replace(/^@/, '') : 'university.edu.ng';
}

function parseWebhookWhitelistIps(): Set<string> {
  const defaultIps = new Set<string>(['74.178.162.156']);
  const raw = process.env.ALATPAY_WEBHOOK_WHITELIST_IPS;
  if (!raw || !String(raw).trim()) return defaultIps;
  String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((ip) => defaultIps.add(ip));
  return defaultIps;
}

const ALAT_OFFICIAL_WEBHOOK_IPS = parseWebhookWhitelistIps();

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getActiveAlatpaySecretKey(): string {
  const mode = process.env.ALATPAY_MODE === 'prod' ? 'prod' : 'sandbox';
  const simpleKey = process.env.ALATPAY_SECRET_KEY;
  if (simpleKey && String(simpleKey).trim()) {
    return String(simpleKey).trim();
  }
  const key =
    mode === 'prod'
      ? process.env.ALATPAY_PROD_SECRET_KEY ?? process.env.ALATPAY_SANDBOX_SECRET_KEY
      : process.env.ALATPAY_SANDBOX_SECRET_KEY ?? process.env.ALATPAY_PROD_SECRET_KEY;
  if (!key || !String(key).trim()) {
    throw new AppError(
      `ALATPAY_SECRET_KEY missing for mode="${mode}". Set ALATPAY_SECRET_KEY (preferred, single-key production convention matching WEMA_ALATPAY_SECRET_KEY) OR ALATPAY_SANDBOX_SECRET_KEY / ALATPAY_PROD_SECRET_KEY in api/.env.`,
      500,
    );
  }
  return String(key).trim();
}

export function getAlatpayPublicKey(): string | null {
  const raw = process.env.ALATPAY_PUBLIC_KEY ?? process.env.WEMA_ALATPAY_PUBLIC_KEY;
  return raw && String(raw).trim() ? String(raw).trim() : null;
}

export function getAlatpayBusinessId(): string {
  const raw = process.env.ALATPAY_BUSINESS_ID ?? process.env.WEMA_ALATPAY_BUSINESS_ID;
  if (!raw || !String(raw).trim()) {
    throw new AppError(
      'ALATPAY_BUSINESS_ID env var missing. Get it from ALAT dashboard → Settings → Business → View.',
      500,
    );
  }
  return String(raw).trim();
}

export function getAlatpayMerchantId(): string | null {
  const raw = process.env.ALATPAY_MERCHANT_ID ?? process.env.WEMA_ALATPAY_MERCHANT_ID;
  return raw && String(raw).trim() ? String(raw).trim() : null;
}

export function getAlatpayBaseUrl(): string {
  const override = process.env.ALATPAY_BASE_URL ?? process.env.WEMA_ALATPAY_BASE_URL;
  if (override && String(override).trim().startsWith('http')) {
    return String(override).trim().replace(/\/$/, '');
  }
  const mode = process.env.ALATPAY_MODE === 'prod' ? 'prod' : 'sandbox';
  return mode === 'sandbox'
    ? 'https://apibox.alatpay.ng'
    : 'https://alatpay.ng';
}

export function getAlatpayWebhookSecret(): string {
  const raw = process.env.ALATPAY_WEBHOOK_SECRET ?? process.env.WEMA_ALATPAY_WEBHOOK_SECRET;
  if (!raw || !String(raw).trim()) {
    throw new AppError(
      'ALATPAY_WEBHOOK_SECRET env var missing. Find it in ALAT Dashboard → Settings → Business → Edit → Webhook Secret.',
      500,
    );
  }
  return String(raw).trim();
}

export function verifyAlatpayHmac(
  rawBody: Buffer | string,
  receivedSignatureHeader: string | undefined | null,
  webhookSecretOverride?: string,
): boolean {
  try {
    if (!rawBody) return false;
    const sig = receivedSignatureHeader ? String(receivedSignatureHeader).trim() : '';
    if (!sig) return false;
    const secret = webhookSecretOverride ?? getAlatpayWebhookSecret();
    const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf-8');
    const computed = crypto.createHmac('sha256', secret).update(bodyBuf).digest('base64');
    return constantTimeEqual(Buffer.from(sig, 'base64'), Buffer.from(computed, 'base64'));
  } catch {
    return false;
  }
}

export function isAlatpayWhitelistedIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const clean = String(ip).trim();
  if (!clean) return false;
  const forwarded = clean.split(',').map((s) => s.trim()).filter(Boolean);
  for (const candidate of forwarded) {
    if (ALAT_OFFICIAL_WEBHOOK_IPS.has(candidate)) return true;
  }
  return ALAT_OFFICIAL_WEBHOOK_IPS.has(clean);
}

export type AlatpayWebhookEnvelope = {
  Value?: {
    Data?: {
      Id?: string;
      Amount?: number;
      Status?: string;
      Channel?: string;
      Currency?: string;
      OrderId?: string;
      FeeAmount?: number;
      CallbackUrl?: string;
      SessionId?: string | null;
      SettlementType?: string;
      UpdatedAt?: string;
      CreatedAt?: string;
      Customer?: {
        Id?: string;
        TransactionId?: string;
        Email?: string;
        Phone?: string | null;
        FirstName?: string | null;
        LastName?: string | null;
        Metadata?: string | null;
      };
    };
    Status?: boolean;
    Message?: string;
  };
  StatusCode?: number;
  [k: string]: any;
};

export function normalizeAlatStatus(status?: string | null): 'pending' | 'success' | 'failed' {
  const s = String(status ?? '').trim().toLowerCase();
  if (!s) return 'pending';
  if (s === 'completed' || s === 'success' || s === 'successful' || s === 'paid') return 'success';
  if (s === 'failed' || s === 'declined' || s === 'rejected' || s === 'cancelled' || s === 'canceled' || s === 'expired') return 'failed';
  return 'pending';
}
