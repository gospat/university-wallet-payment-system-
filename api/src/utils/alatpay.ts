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
  const simpleKey = process.env.ALATPAY_SECRET_KEY ?? process.env.WEMA_ALATPAY_SECRET_KEY;
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
  return 'https://apibox.alatpay.ng';
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

// =============================================================================
// WEBHOOK HMAC VERIFICATION — Status: IMPLEMENTED as HMAC-SHA256 + Base64 digest
// =============================================================================
// ⚠️  PROVIDER-UNPROVEN PORTION (ISSUE 4 CLARIFICATION):
//    What is CONFIRMED (from our own integration tests + correlation unit
//    tests + operator's prior server-side receipt of the incident payload
//    structure via their dashboard's history):
//      1) our Webhook receipt endpoint requires a valid signature (HMAC
//         fail-closed; otherwise HTTP 403)
//      2) our algorithm: HMAC( SHA256, utf-8 raw request body, secret )
//         → raw 32-byte digest → base64-encoded (no prefix, no hex, no sha256=)
//      3) comparison performed via constant-time Buffer equality on the
//         decoded base64 bytes (never on strings — avoids timing oracles)
//      4) accepted header names (any one):
//           x-alatpay-signature   (preferred — name commonly used by Wema/ALAT)
//           alatpay-signature
//           x-signature
//    What is NOT CONFIRMED / still OPERATOR-ACTION REQUIRED before
//    relying on this alone in production:
//      5) We have no independent signed real webhook sample captured from
//         ALATPay servers we could replay-verify against this algorithm.
//         (The incident's real webhook never arrived; the provider dashboard
//         UI logs display payload content, not cryptographically preserved
//         raw signatures.)
//      6) ALATPay could legitimately use SHA512/hex, HMAC prefixes, or
//         timestamped concatenated format without notice.
//    MANDATORY OPERATOR ACTION BEFORE FIRST LIVE WEBHOOK:
//      → use Dashboard → Webhook → Send Test Payload feature against a
//        staging mirror of this exact code path. Capture the signed request
//        in raw form and compare: if signature does not decode as base64
//        32 bytes or constantTimeEqual fails → treat implementation as
//        mismatched; raise an incident ticket with ALATPay support showing
//        the exact algorithm used here. DO NOT relax the HMAC check to
//        pass-through (never `return true`) — a false-positive success
//        means forging a charge.success becomes possible without provider
//        authority, resulting in double-credit of student accounts.
// =============================================================================

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
    // Per §above (Issue 4): our assumed algorithm. Still FAIL-CLOSED on any mismatch.
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

export type AlatpayCustomerMetadata = {
  transaction_id?: number | string;
  bells_payment_reference?: string;
  student_id?: number | string;
  invoice_id?: number | string;
  fee_id?: number | string;
  academic_session?: string;
  fee_name?: string;
  idempotency_key?: string;
};

export const ALATPAY_CORRELATION_ALLOWLIST: ReadonlyArray<keyof AlatpayCustomerMetadata> = [
  'transaction_id',
  'bells_payment_reference',
  'student_id',
  'invoice_id',
  'fee_id',
  'academic_session',
  'fee_name',
  'idempotency_key',
] as const;

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
        Metadata?: string | null | Record<string, unknown>;
      };
    };
    Status?: boolean;
    Message?: string;
  };
  // Documented ALATPay "Setup Callback URL" payload variant: lowercase root `data` object.
  // Supported alongside the legacy Value.Data envelope for compatibility with
  // either provider-documented or actual webhook payload shapes.
  data?: {
    id?: string;
    amount?: number | string;
    status?: string;
    channel?: string;
    currency?: string;
    orderId?: string;
    order_id?: string;
    feeAmount?: number | string;
    fee_amount?: number | string;
    callbackUrl?: string;
    sessionId?: string | null;
    settlementType?: string;
    updatedAt?: string;
    createdAt?: string;
    customer?: {
      id?: string;
      transactionId?: string;
      transaction_id?: string;
      email?: string;
      phone?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      metadata?: string | null | Record<string, unknown>;
    };
  };
  // Root-level identifiers (some providers emit id/status at the envelope root).
  id?: string;
  status?: string;
  StatusCode?: number;
  [k: string]: any;
};

export type AlatpayNormalizedData = {
  Id: string | null;
  Amount: number | null;
  Status: string | null;
  Channel: string | null;
  Currency: string | null;
  OrderId: string | null;
  FeeAmount: number | null;
  CallbackUrl: string | null;
  SessionId: string | null;
  UpdatedAt: string | null;
  CreatedAt: string | null;
  Customer: {
    Id: string | null;
    TransactionId: string | null;
    Email: string | null;
    Phone: string | null;
    FirstName: string | null;
    LastName: string | null;
    Metadata: string | null | Record<string, unknown> | null;
  } | null;
};

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/**
 * Normalize both known ALATPay webhook envelope variants into a single
 * canonical shape so downstream handlers never need to branch on case:
 *   1) Legacy { Value: { Data: { Id, Status, OrderId, Customer: { TransactionId, ... } } } }
 *   2) Documented lowercase { data: { id, status, orderId, customer: { transactionId, ... } } }
 *   3) Fallback root-level { id, status, ... } (if present)
 * The HMAC/signature layer remains authoritative; normalization only affects
 * field extraction after authentication has already passed.
 */
export function normalizeAlatpayWebhookEnvelope(raw: AlatpayWebhookEnvelope | any): AlatpayNormalizedData {
  const vData = (raw?.Value?.Data ?? {}) as Record<string, any>;
  const dData = (raw?.data ?? {}) as Record<string, any>;
  const vCust = (vData.Customer ?? {}) as Record<string, any>;
  const dCust = (dData.customer ?? {}) as Record<string, any>;

  const id =
    asString(vData.Id) ??
    asString(vData.id) ??
    asString(dData.id) ??
    asString(dData.Id) ??
    asString(raw?.id) ??
    asString(raw?.Id) ??
    null;

  const amount =
    asNumber(vData.Amount) ??
    asNumber(dData.amount) ??
    asNumber(raw?.amount) ??
    null;

  const status =
    asString(vData.Status) ??
    asString(vData.status) ??
    asString(dData.status) ??
    asString(dData.Status) ??
    asString(raw?.status) ??
    asString(raw?.Status) ??
    null;

  const channel =
    asString(vData.Channel) ??
    asString(dData.channel) ??
    null;

  const currency =
    asString(vData.Currency) ??
    asString(dData.currency) ??
    null;

  const orderId =
    asString(vData.OrderId) ??
    asString(dData.orderId) ??
    asString(dData.order_id) ??
    asString(raw?.orderId) ??
    asString(raw?.orderReference) ??
    null;

  const feeAmount =
    asNumber(vData.FeeAmount) ??
    asNumber(dData.feeAmount) ??
    asNumber(dData.fee_amount) ??
    null;

  const callbackUrl =
    asString(vData.CallbackUrl) ??
    asString(dData.callbackUrl) ??
    null;

  const sessionId =
    asString(vData.SessionId) ??
    asString(vData.sessionId) ??
    asString(dData.sessionId) ??
    null;

  const updatedAt =
    asString(vData.UpdatedAt) ??
    asString(dData.updatedAt) ??
    null;

  const createdAt =
    asString(vData.CreatedAt) ??
    asString(dData.createdAt) ??
    null;

  const custId =
    asString(vCust.Id) ??
    asString(dCust.id) ??
    null;

  const custTxId =
    asString(vCust.TransactionId) ??
    asString(dCust.transactionId) ??
    asString(dCust.transaction_id) ??
    null;

  const custEmail =
    asString(vCust.Email) ??
    asString(dCust.email) ??
    null;

  const custPhone =
    asString(vCust.Phone) ??
    asString(dCust.phone) ??
    null;

  const custFirst =
    asString(vCust.FirstName) ??
    asString(dCust.firstName) ??
    null;

  const custLast =
    asString(vCust.LastName) ??
    asString(dCust.lastName) ??
    null;

  const custMetaRaw =
    (vCust.Metadata !== undefined && vCust.Metadata !== null) ? vCust.Metadata :
    (dCust.metadata !== undefined && dCust.metadata !== null) ? dCust.metadata :
    null;

  const hasAnyCustomer =
    custId !== null ||
    custTxId !== null ||
    custEmail !== null ||
    custFirst !== null ||
    custLast !== null ||
    custMetaRaw !== null;

  return {
    Id: id,
    Amount: amount,
    Status: status,
    Channel: channel,
    Currency: currency,
    OrderId: orderId,
    FeeAmount: feeAmount,
    CallbackUrl: callbackUrl,
    SessionId: sessionId,
    UpdatedAt: updatedAt,
    CreatedAt: createdAt,
    Customer: hasAnyCustomer
      ? {
          Id: custId,
          TransactionId: custTxId,
          Email: custEmail,
          Phone: custPhone,
          FirstName: custFirst,
          LastName: custLast,
          Metadata: custMetaRaw,
        }
      : null,
  };
}


export function serializeAlatpayCustomerMetadata(meta: Record<string, unknown> | undefined | null): string {
  try {
    const allowed = ALATPAY_CORRELATION_ALLOWLIST as readonly string[];
    const sanitized: Record<string, unknown> = {};
    if (meta && typeof meta === 'object') {
      for (const k of allowed) {
        if (k in meta && (meta as any)[k] !== undefined && (meta as any)[k] !== null) {
          sanitized[k] = (meta as any)[k];
        }
      }
    }
    return JSON.stringify(sanitized);
  } catch {
    return JSON.stringify({});
  }
}

export function parseAlatpayCustomerMetadata(raw: unknown): AlatpayCustomerMetadata | null {
  if (raw === null || raw === undefined) return null;
  let obj: any = null;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try { obj = JSON.parse(raw); } catch { return null; }
  } else if (typeof raw === 'object') {
    obj = raw;
  } else {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: AlatpayCustomerMetadata = {};
  const toFiniteNumber = (v: any): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const asNumberOrString = (v: any): number | string | undefined => {
    const n = toFiniteNumber(v);
    if (n !== undefined) return String(Math.trunc(n)) === String(v).trim() || typeof v === 'number' ? n : String(v);
    if (typeof v === 'string' && v.trim()) return v.trim();
    return undefined;
  };
  if (obj.transaction_id !== undefined && obj.transaction_id !== null) {
    const v = asNumberOrString(obj.transaction_id);
    if (v !== undefined) out.transaction_id = v;
  }
  if (typeof obj.bells_payment_reference === 'string' && obj.bells_payment_reference.trim()) {
    out.bells_payment_reference = obj.bells_payment_reference.trim();
  }
  if (obj.student_id !== undefined && obj.student_id !== null) {
    const v = asNumberOrString(obj.student_id);
    if (v !== undefined) out.student_id = v;
  }
  if (obj.invoice_id !== undefined && obj.invoice_id !== null) {
    const v = asNumberOrString(obj.invoice_id);
    if (v !== undefined) out.invoice_id = v;
  }
  if (obj.fee_id !== undefined && obj.fee_id !== null) {
    const v = asNumberOrString(obj.fee_id);
    if (v !== undefined) out.fee_id = v;
  }
  if (typeof obj.academic_session === 'string' && obj.academic_session.trim()) {
    out.academic_session = obj.academic_session.trim();
  }
  if (typeof obj.fee_name === 'string' && obj.fee_name.trim()) {
    out.fee_name = obj.fee_name.trim();
  }
  if (typeof obj.idempotency_key === 'string' && obj.idempotency_key.trim()) {
    out.idempotency_key = obj.idempotency_key.trim();
  }
  const hasAny = Object.keys(out).length > 0;
  return hasAny ? out : null;
}

/**
 * Select the authoritative ALATPAY final transaction UUID for server-to-server
 * verification against /transactions/{id}.
 *
 * PRODUCTION REQUIREMENT (verified against the real live payment):
 *   - Final transaction identifier is UUID v4 shaped (e.g.
 *     b5a198af-6582-42ac-9fc5-bc593685c954).
 *   - Value.Data.Id (when present and UUID-shaped) is the primary
 *     authoritative identifier and is GUARANTEED to work with the verify
 *     endpoint.
 *   - Customer.TransactionId ONLY if it is UUID shaped; otherwise ignore.
 *   - Order references (WEMA-PAY-... / WEMA-...) and init/session refs
 *     (payk..., short tokens) MUST NEVER be sent to
 *     /transactions/{id}. Calling /transactions/{WEMA-order-ref} or
 *     /transactions/{payk-init-ref} fails in production.
 *
 * We ONLY accept candidates that match UUID v4 regex. Anything non-UUID is
 * deliberately rejected (returns null). Caller MUST then fail closed
 * (not process money, leave for reconciliation).
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAlatpayUuid(s: any): boolean {
  return typeof s === 'string' && UUID_V4_RE.test(s.trim());
}

export function selectAlatpayFinalTxId(
  payload: any,
  fallback?: string | null,
): string | null {
  try {
    const candidates: Array<string | null | undefined> = [];
    candidates.push(payload?.Value?.Data?.Id);
    candidates.push(payload?.Value?.Data?.id);
    candidates.push(payload?.data?.id);
    candidates.push(payload?.data?.Id);
    candidates.push(payload?.data?.transactionId);
    candidates.push(payload?.data?.TransactionId);
    candidates.push(payload?.Id);
    candidates.push(payload?.id);
    candidates.push(payload?.Value?.Data?.transactionId);
    candidates.push(payload?.Value?.Data?.TransactionId);
    candidates.push(payload?.transactionId);
    candidates.push(payload?.TransactionId);
    if (payload?.Customer?.TransactionId && typeof payload.Customer.TransactionId === 'string') {
      candidates.push(payload.Customer.TransactionId);
    }
    if (payload?.Customer?.transactionId && typeof payload.Customer.transactionId === 'string') {
      candidates.push(payload.Customer.transactionId);
    }
    if (payload?.data?.customer?.TransactionId && typeof payload.data.customer.TransactionId === 'string') {
      candidates.push(payload.data.customer.TransactionId);
    }
    if (payload?.data?.customer?.transactionId && typeof payload.data.customer.transactionId === 'string') {
      candidates.push(payload.data.customer.transactionId);
    }
    if (payload?.data?.customer?.transaction_id && typeof payload.data.customer.transaction_id === 'string') {
      candidates.push(payload.data.customer.transaction_id);
    }
    for (const c of candidates) {
      if (isAlatpayUuid(c)) return (c as string).trim().toLowerCase();
    }
    if (isAlatpayUuid(fallback)) return (fallback as string).trim().toLowerCase();
    return null;
  } catch {
    if (isAlatpayUuid(fallback)) return (fallback as string).trim().toLowerCase();
    return null;
  }
}

export function normalizeAlatStatus(status?: string | null): 'pending' | 'success' | 'failed' {
  const s = String(status ?? '').trim().toLowerCase();
  if (!s) return 'pending';
  if (s === 'completed' || s === 'success' || s === 'successful' || s === 'paid') return 'success';
  if (s === 'failed' || s === 'declined' || s === 'rejected' || s === 'cancelled' || s === 'canceled' || s === 'expired') return 'failed';
  return 'pending';
}

export class AlatpayPopupUnavailableError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 502, details);
    this.name = 'AlatpayPopupUnavailableError';
    Object.setPrototypeOf(this, AlatpayPopupUnavailableError.prototype);
  }
}

// --- Secret / credential fields  --> ABORT native checkout. ---
const ALATPAY_SECRET_ABORT_KEY_REGEX =
  /(^|[_\s\-.])(api[_-]?key|apikey|secret|secret[_-]?key|secretkey|token|password|passwd|private[_-]?key|subscription[_-]?key|ocp[-_]apim[-_]subscription[-_]key|authorization|auth|bearer|credential|credentials?|signing[_-]?key|webhook[_-]?secret|client[_-]?secret)$/i;

// --- Ordinary provider navigation/configuration URL fields  --> DROP silently, NEVER forward to browser,
//     but their presence in ALATPay responses MUST NOT abort native checkout. ---
const ALATPAY_NAVURL_DROP_KEY_REGEX =
  /(^|[_\s\-.])(callback[_-]?url|callbackurl|redirect[_-]?url|redirecturl|success[_-]?url|successurl|cancel[_-]?url|cancelurl|webhook[_-]?url|webhookurl|return[_-]?url|returnurl|fail[_-]?url|failurl|close[_-]?url|closeurl|click[_-]?url|clickurl)$/i;

const ALATPAY_SECRET_VALUE_PREFIXES = [/^(bearer|basic)\s+/i, /^sk[_-]/i];
const ALATPAY_SECRET_VALUE_STARTS_WITH = ['Ocp-Apim'];

function isSecretAbortKey(key: string): boolean {
  if (!key) return false;
  return ALATPAY_SECRET_ABORT_KEY_REGEX.test(String(key));
}

function isNavUrlDropKey(key: string): boolean {
  if (!key) return false;
  return ALATPAY_NAVURL_DROP_KEY_REGEX.test(String(key));
}

function isSecretValue(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  for (const re of ALATPAY_SECRET_VALUE_PREFIXES) if (re.test(value)) return true;
  for (const prefix of ALATPAY_SECRET_VALUE_STARTS_WITH) if (value.startsWith(prefix)) return true;
  return false;
}

type SecretScanOpts = {
  allowExactTopLevelKeys?: ReadonlySet<string>;
  depth?: number;
};

function scanRecursivelyForSecretFields(
  node: unknown,
  trail: string[] = [],
  opts: SecretScanOpts = {},
): string | null {
  if (node === null || node === undefined) return null;
  const depth = opts.depth ?? 0;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = scanRecursivelyForSecretFields(node[i], [...trail, `[${i}]`], { ...opts, depth: depth + 1 });
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const rawKey of Object.keys(node as Record<string, unknown>)) {
      if (isNavUrlDropKey(rawKey)) continue;
      const isTopLevel = depth === 0;
      if (isTopLevel && opts.allowExactTopLevelKeys && opts.allowExactTopLevelKeys.has(rawKey)) {
        // Narrow exception: exact depth-0 top-level key names only.
        // Nested keys of the same name still abort (handled below when not skipped).
        // Secret VALUE patterns are still checked via recursion into the value.
        const childHit = scanRecursivelyForSecretFields(
          (node as Record<string, unknown>)[rawKey],
          [...trail, rawKey],
          { ...opts, depth: depth + 1 },
        );
        if (childHit) return childHit;
        continue;
      }
      if (isSecretAbortKey(rawKey)) return `key=${rawKey} at ${[...trail, rawKey].join('.')}`;
      const hit = scanRecursivelyForSecretFields(
        (node as Record<string, unknown>)[rawKey],
        [...trail, rawKey],
        { ...opts, depth: depth + 1 },
      );
      if (hit) return hit;
    }
    return null;
  }
  if (isSecretValue(node)) return `value at ${trail.join('.') || '<root>'} matches credential pattern`;
  return null;
}

export function generateAlatpayPlaceholderRefs(reference: string): {
  orderReference: string;
  initPaymentReference: string;
  sessionId: string | null;
  checkoutUrl: string | null;
  providerReference: string;
} {
  const ref = reference && String(reference).trim() ? String(reference).trim() : `PAY-${Date.now()}`;
  const orderReference = `WEMA-${ref}`;
  return {
    orderReference,
    initPaymentReference: orderReference,
    sessionId: null,
    checkoutUrl: null,
    providerReference: orderReference,
  };
}

export async function fetchAlatpayBusinessForPlugin(
  businessId: string,
  apiKey: string,
  amountNgn: number,
  currency = 'NGN',
  passCharge = false,
): Promise<unknown> {
  if (!businessId || !String(businessId).trim()) {
    throw new AlatpayPopupUnavailableError('ALATPay business identifier missing for native modal mode.');
  }
  if (!apiKey || !String(apiKey).trim()) {
    throw new AlatpayPopupUnavailableError('ALATPay merchant API key missing for native modal mode.');
  }
  const base = getAlatpayBaseUrl();
  const amountFinite = Number.isFinite(amountNgn) && amountNgn > 0 ? Number(amountNgn) : 0;
  const params = new URLSearchParams({
    'subscription-key': String(apiKey).trim(),
    amount: String(amountFinite),
    currency: currency && String(currency).trim() ? String(currency).trim() : 'NGN',
  });
  if (typeof passCharge === 'boolean') params.set('PassCharge', String(passCharge));
  const url = `${base}/merchant-onboarding/api/v1/merchants/business-for-plugin/${encodeURIComponent(
    String(businessId).trim(),
  )}?${params.toString()}`;
  try {
    const axios = await import('axios');
    const response = await axios.default.get(url, {
      headers: {
        Accept: 'application/json',
        'Ocp-Apim-Subscription-Key': String(apiKey).trim(),
      },
      timeout: 7500,
      responseType: 'json',
    });
    const payload = response?.data ?? null;
    const scan = scanRecursivelyForSecretFields(payload);
    if (scan) {
      throw new AlatpayPopupUnavailableError(
        'ALATPay business-for-plugin response contained credential-like fields. Popup checkout mode aborted for safety. Contact ALATPay/WEMA merchant support and request a sanitized business-for-plugin schema, or disable ALATPAY_USE_POPUP_CHECKOUT to use legacy payment-link path.',
        { detected: scan },
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof AlatpayPopupUnavailableError) throw error;
    const axiosMsg = String((error as any)?.message ?? '').trim().slice(0, 180);
    throw new AlatpayPopupUnavailableError(
      'ALATPay native modal could not resolve merchant configuration. Please retry shortly or use Paystack.',
      { upstream: axiosMsg },
    );
  }
}

export type AlatpayPublicBusiness = {
  id: string;
  businessId: string;
  name: string;
  logoUrl: string | null;
};

export type AlatpayPublicCheckoutMetadata = {
  bells_payment_reference: string;
  order_reference: string;
  init_payment_reference: string;
};

export type AlatpayPublicCheckout = {
  apiKey: string;
  amount: number;
  currency: 'NGN';
  businessId: string;
  autoCloseModal: true;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  metadata: AlatpayPublicCheckoutMetadata;
  fallback: {
    enableRedirect: false;
    enablePopup: true;
    handshakeTimeoutMs: 4500;
  };
};

export function buildSanitizedAlatpayPublicCheckout(
  rawBusinessResponse: unknown,
  ctx: {
    bellsRef: string;
    orderRef: string;
    initRef: string;
    businessId: string;
    amountNgn: number;
    currency?: 'NGN';
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    popupModeEnabled: boolean;
  },
): AlatpayPublicCheckout {
  if (!ctx || typeof ctx !== 'object') {
    throw new AlatpayPopupUnavailableError('ALATPay native modal context missing.');
  }
  const preScan = scanRecursivelyForSecretFields(rawBusinessResponse);
  if (preScan) {
    throw new AlatpayPopupUnavailableError(
      'ALATPay business-for-plugin response contained credential-like fields before sanitization. Popup checkout mode aborted for safety.',
      { detected: preScan },
    );
  }
  const publicKey = getAlatpayPublicKey();
  if (ctx.popupModeEnabled && !publicKey) {
    throw new AlatpayPopupUnavailableError(
      'ALATPay native checkout requires ALATPAY_PUBLIC_KEY. Native popup mode disabled until a public key is configured server-side.',
    );
  }
  if (!publicKey) {
    throw new AlatpayPopupUnavailableError(
      'ALATPay native checkout public key missing. Native popup mode aborted.',
    );
  }
  const body =
    rawBusinessResponse !== null && rawBusinessResponse !== undefined && typeof rawBusinessResponse === 'object'
      ? (rawBusinessResponse as Record<string, unknown>)
      : null;
  const data =
    body && body.data !== null && body.data !== undefined && typeof body.data === 'object'
      ? (body.data as Record<string, unknown>)
      : body;
  const pick = <T>(obj: Record<string, unknown> | null, key: string, fallback: T | null = null): unknown => {
    if (!obj) return fallback;
    const v = obj[key] ?? obj[key.toLowerCase()] ?? obj[key.toUpperCase()] ?? fallback;
    return v;
  };
  const asString = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string' && v.trim()) return v.trim();
    return null;
  };
  const id = asString(pick(data ?? ({} as Record<string, unknown>), 'id'));
  const busId = asString(pick(data ?? ({} as Record<string, unknown>), 'businessId')) ?? String(ctx.businessId ?? '').trim();
  const name = asString(pick(data ?? ({} as Record<string, unknown>), 'name')) ?? asString(pick(data ?? ({} as Record<string, unknown>), 'businessName'));
  const logoRaw =
    asString(pick(data ?? ({} as Record<string, unknown>), 'logoUrl')) ??
    asString(pick(data ?? ({} as Record<string, unknown>), 'logo_url')) ??
    asString(pick(data ?? ({} as Record<string, unknown>), 'logo'));
  const logoUrl =
    logoRaw && (logoRaw.startsWith('http://') || logoRaw.startsWith('https://') || logoRaw.startsWith('data:'))
      ? logoRaw
      : null;
  if (!id || !busId || !name) {
    throw new AlatpayPopupUnavailableError(
      'ALATPay native modal received an incomplete merchant identity response. Expected business identifier, display name, and logo URL fields. Contact ALATPay/WEMA merchant support or disable ALATPAY_USE_POPUP_CHECKOUT to use legacy payment-link mode.',
      { missing: [id ? null : 'business.data.id', busId ? null : 'business.data.businessId', name ? null : 'business.data.name'].filter(Boolean) },
    );
  }
  const amountNgnClean = Number.isFinite(ctx.amountNgn) && ctx.amountNgn > 0 ? Number(ctx.amountNgn) : NaN;
  if (!Number.isFinite(amountNgnClean)) {
    throw new AlatpayPopupUnavailableError('ALATPay native modal received invalid amount.');
  }
  const bellsRef = ctx.bellsRef && String(ctx.bellsRef).trim() ? String(ctx.bellsRef).trim() : null;
  const orderRef = ctx.orderRef && String(ctx.orderRef).trim() ? String(ctx.orderRef).trim() : null;
  const initRef = ctx.initRef && String(ctx.initRef).trim() ? String(ctx.initRef).trim() : null;
  if (!bellsRef || !orderRef || !initRef) {
    throw new AlatpayPopupUnavailableError('ALATPay native modal correlation references incomplete.');
  }
  const emailClean =
    ctx.email && String(ctx.email).trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(ctx.email).trim())
      ? String(ctx.email).trim()
      : `${bellsRef}@${getDefaultEmailDomain()}`;
  const safe: AlatpayPublicCheckout = {
    apiKey: publicKey,
    amount: amountNgnClean,
    currency: 'NGN',
    businessId: busId,
    autoCloseModal: true,
    email: emailClean,
    firstName: ctx.firstName && String(ctx.firstName).trim() ? String(ctx.firstName).trim() : undefined,
    lastName: ctx.lastName && String(ctx.lastName).trim() ? String(ctx.lastName).trim() : undefined,
    phone: ctx.phone && String(ctx.phone).trim() ? String(ctx.phone).trim() : undefined,
    metadata: {
      bells_payment_reference: bellsRef,
      order_reference: orderRef,
      init_payment_reference: initRef,
    },
    fallback: {
      enableRedirect: false,
      enablePopup: true,
      handshakeTimeoutMs: 4500,
    },
  };
  const postScan = scanRecursivelyForSecretFields(safe, [], {
    allowExactTopLevelKeys: new Set(['apiKey']),
  });
  if (postScan) {
    throw new AlatpayPopupUnavailableError(
      'ALATPay native modal sanitized checkout contained credential-like fields after sanitization. Aborted.',
      { detected: postScan },
    );
  }
  return safe;
}
