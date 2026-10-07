import axios from 'axios';
import { PaymentGateway, TransactionStatus } from '@prisma/client';
import { IPaymentProvider, InitializeOptions, InitializeResult, VerifyResult, RefundResult, PaymentBreakdown } from '../types';
import { computePaymentBreakdown } from '../../paystack';
import { AppError } from '../../../utils/AppError';
import {
  getActiveAlatpaySecretKey,
  getAlatpayBaseUrl,
  getAlatpayBusinessId,
  getAlatpayMerchantId,
  normalizeAlatStatus,
  ALATPAY_CURRENCY_ENUM_ORDINAL_NGN,
  ALATPAY_CHANNEL_CODES,
  isAlatpayPassChargeEnabled,
  getDefaultEmailDomain,
  serializeAlatpayCustomerMetadata,
} from '../../../utils/alatpay';

function money(n: number | string | null | undefined): number {
  return Number(Number(n ?? 0).toFixed(2));
}

function addAlatHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Ocp-Apim-Subscription-Key': getActiveAlatpaySecretKey(),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Ocp-Apim-Trace': 'true',
    ...extra,
  };
}

export class AlatpayProvider implements IPaymentProvider {
  readonly name = PaymentGateway.ALATPAY;

  private readonly BASE_URL: string;

  constructor() {
    this.BASE_URL = getAlatpayBaseUrl();
  }

  async initialize(
    email: string,
    baseAmountNaira: number,
    opts: InitializeOptions,
  ): Promise<InitializeResult> {
    if (!Number.isFinite(baseAmountNaira) || baseAmountNaira <= 0) {
      throw new AppError('Payment amount must be greater than zero.', 400);
    }
    const breakdown: PaymentBreakdown = computePaymentBreakdown(baseAmountNaira);
    const appBase = process.env.APP_BASE_URL ?? 'http://localhost:3001';
    const webhookDefault = `${appBase.replace(/\/$/, '')}/api/v1/webhooks/alatpay`;
    const businessId = getAlatpayBusinessId();
    const merchantId = getAlatpayMerchantId();
    const defaultEmailDomain = getDefaultEmailDomain();
    const wemaReference = `WEMA-${opts.reference}`;
    const orderId = wemaReference;
    const metadataForProvider: Record<string, unknown> = {
      ...(opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : {}),
      transaction_id: (opts.metadata as any)?.transaction_id ?? undefined,
      bells_payment_reference: opts.reference,
      student_id: (opts.metadata as any)?.student_id ?? undefined,
      invoice_id: (opts.metadata as any)?.invoice_id ?? undefined,
      fee_id: (opts.metadata as any)?.fee_id ?? undefined,
      academic_session: (opts.metadata as any)?.academic_session ?? undefined,
      fee_name: (opts.metadata as any)?.fee_name ?? undefined,
      idempotency_key: (opts.metadata as any)?.idempotency_key ?? undefined,
    };
    const metadataJsonString = serializeAlatpayCustomerMetadata(metadataForProvider);
    const body: Record<string, any> = {
      email: email || `${opts.reference}@${defaultEmailDomain}`,
      firstName: opts.firstName ?? opts.reference,
      lastName: opts.lastName ?? opts.reference,
      amount: breakdown.totalAmount,
      currency: ALATPAY_CURRENCY_ENUM_ORDINAL_NGN,
      redirectUrl: opts.callbackUrl,
      webhookUrl: webhookDefault,
      businessId,
      reference: wemaReference,
      orderId,
      passCharge: false,
      metadata: metadataJsonString,
    };
    if (merchantId) body.merchantId = merchantId;
    if (opts.phone) body.phone = opts.phone;
    if (opts.channels && opts.channels.length > 0) {
      const selected = opts.channels
        .map((c) => ALATPAY_CHANNEL_CODES[String(c).toLowerCase()] ?? null)
        .filter((x): x is string => !!x);
      if (selected.length > 0) {
        if (
          selected.includes(ALATPAY_CHANNEL_CODES.card) &&
          selected.includes(ALATPAY_CHANNEL_CODES.bank) &&
          selected.includes(ALATPAY_CHANNEL_CODES.ussd)
        ) {
          body.channel = '*';
        } else {
          body.channel = selected[0];
        }
      } else {
        body.channel = '*';
      }
    } else {
      body.channel = '*';
    }
    try {
      const t0 = Date.now();
      const response = await axios.post(
        `${this.BASE_URL}/merchant-onboarding/api/v1/payment/initialize`,
        body,
        { headers: addAlatHeaders() },
      );
      const elapsedMs = Date.now() - t0;
      const data = response?.data?.data ?? response?.data ?? {};
      // Order matters: ALATPAY returns BOTH paymentUrl (REAL checkout) and redirectUrl (our callback).
      // Real response structure (per real backend probe):
      //   response.data = { data: { id, paymentUrl, paymentReference, redirectUrl, metaData }, status:true, message:"Success" }
      const checkoutUrl =
        (data.paymentUrl ||
          data.checkoutUrl ||
          data.authorizationUrl ||
          data.authorization_url ||
          null) as string | null;
      const providerRef =
        (data.paymentReference ||
          data.transactionId ||
          data.id ||
          data.orderId ||
          opts.reference) as string;
      const sessionId = (data.sessionId ?? data.paymentReference ?? null) as string | null;
      console.info(
        JSON.stringify({
          provider: 'ALATPAY',
          operation: 'initialize',
          outcome: 'success',
          httpStatus: typeof response?.status === 'number' ? response.status : null,
          upstreamStatus: data?.Status ?? response?.data?.Status ?? null,
          upstreamCode: data?.code ?? null,
          sanitizedMessage: String(data?.Message ?? response?.data?.Message ?? 'ok').slice(0, 180),
          internalReference: opts.reference,
          wemaReference,
          elapsedMs,
        }),
      );
      return {
        checkoutUrl,
        authorization_url: checkoutUrl,
        access_code: sessionId,
        providerReference: providerRef,
        sessionId,
        orderReference: orderId,
        initPaymentReference: (data.paymentReference ?? providerRef) as string | undefined,
        feeBreakdown: breakdown,
        channelsUsed: opts.channels ?? null,
        raw: response?.data ?? data,
      };
    } catch (error: any) {
      const resp = error?.response;
      const respData = resp?.data;
      const rawStatus = typeof resp?.status === 'number' ? resp.status : null;
      const requestHadSecretHeader = true;
      let bodyText = '';
      try {
        if (typeof respData === 'string') bodyText = respData;
        else if (respData && typeof respData === 'object')
          bodyText =
            String(respData.message ?? respData.Message ?? respData.error ?? '') +
            ' ' +
            JSON.stringify({
              code: respData.code ?? respData.Code ?? null,
              status: respData.status ?? respData.Status ?? null,
            }).slice(0, 260);
      } catch (_) { /* noop */ }
      const axiosMsg = String(error?.message ?? '').trim();
      const upstreamSanitizedCode =
        (respData && typeof respData === 'object')
          ? String(respData.code ?? respData.Code ?? respData.statusCode ?? respData.StatusCode ?? '').slice(0, 64)
          : '';
      const upstreamSanitizedMessage = (bodyText || axiosMsg || 'Unknown error').trim().slice(0, 220);
      const isSandboxLocked = /not available in the test environment/i.test(bodyText + ' ' + upstreamSanitizedMessage);
      const ngrokHint =
        process.env.FRONTEND_BASE_URL?.includes('ngrok') || process.env.APP_BASE_URL?.includes('ngrok')
          ? ''
          : ' (run: ngrok http 3001, then set the ngrok HTTPS forwarding URL + /api/v1/webhooks/alatpay suffix)';

      // SANITIZED SERVER-SIDE DIAGNOSTICS. NEVER include secret/auth headers or full sensitive body.
      console.error(
        JSON.stringify({
          provider: 'ALATPAY',
          operation: 'initialize',
          outcome: 'failed',
          httpStatus: rawStatus,
          sanitizedCode: upstreamSanitizedCode || null,
          sanitizedMessage: upstreamSanitizedMessage.slice(0, 200),
          internalReference: opts.reference,
          wemaReference,
          baseUrl: this.BASE_URL,
          requestHadSecretHeader,
          isSandboxLocked: isSandboxLocked || false,
          errorClass: error?.name ?? (error?.isAxiosError ? 'AxiosError' : 'Error'),
          elapsedMs: typeof (error as any)?.$start === 'number' ? Date.now() - (error as any).$start : null,
        }),
      );

      let msg = `ALAT Pay Initialization Error: ${upstreamSanitizedMessage}`;
      if (rawStatus === 403 || isSandboxLocked) {
        const liveBusinessId = getAlatpayBusinessId();
        msg +=
          '. Quick fix: 1) Log into ALATPAY dashboard → Settings → Business Details, ensure Webhook URL is set to ' +
          'your internet-reachable callback' +
          ngrokHint +
          ', 2) If already set, this test merchant profile ("Bells University of Technology (Test)") still needs ' +
          'backend activation — contact ALATPAY / WEMA Bank merchant support and share: "Initialize endpoint returns ' +
          'HTTP 403: This endpoint is not available in the test environment even though Webhook URL is populated ' +
          'with a reachable ngrok HTTPS endpoint — please activate my test-mode merchant Business ID ' +
          liveBusinessId + ' for the /payment/initialize endpoint.".';
      }
      throw new AppError(msg, rawStatus && rawStatus >= 400 && rawStatus < 500 ? 502 : 502);
    }
  }

  async verify(providerReference: string): Promise<VerifyResult> {
    if (!providerReference || !String(providerReference).trim()) {
      throw new AppError('ALAT transaction reference is required for verification', 400);
    }
    try {
      const safeRef = encodeURIComponent(String(providerReference).trim());
      const candidates = [
        `${this.BASE_URL}/alatpaytransaction/api/v1/transactions/${safeRef}`,
        `${this.BASE_URL}/transaction/api/v1/transactions/${safeRef}`,
      ];
      let lastErr: any = null;
      let payload: any = null;
      for (const url of candidates) {
        try {
          const r = await axios.get(url, { headers: addAlatHeaders(), timeout: 15000 });
          payload = r?.data?.data ?? r?.data?.Value?.Data ?? r?.data;
          if (payload && (payload.Id || payload.id || payload.transactionId)) break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!payload) {
        if (lastErr) throw lastErr;
        throw new AppError('ALAT Pay returned empty transaction during verification.', 502);
      }
      const id = (payload.Id ?? payload.id ?? payload.transactionId ?? providerReference) as string;
      const rawStatus = String(payload.Status ?? payload.status ?? '').trim();
      const normalized = normalizeAlatStatus(rawStatus);
      const status =
        normalized === 'success'
          ? TransactionStatus.SUCCESS
          : normalized === 'failed'
          ? TransactionStatus.FAILED
          : TransactionStatus.PENDING;
      const amtNaira = money(payload.Amount ?? payload.amount ?? 0);
      const feeNaira = money(payload.FeeAmount ?? payload.feeAmount ?? 0);
      const channel = (payload.Channel ?? payload.channel ?? null) as string | null;
      const currency = (payload.Currency ?? payload.currency ?? 'NGN') as string;
      const updatedAt = payload.UpdatedAt ?? payload.updatedAt ?? payload.CreatedAt ?? payload.createdAt;
      const paidAt = updatedAt ? new Date(String(updatedAt)) : new Date();
      return {
        providerReference: id,
        paidAmountNaira: amtNaira,
        paidAmountMinor: Math.round(amtNaira * 100),
        status,
        channel,
        paidAt,
        currency,
        providerStatus: rawStatus || normalized,
        expectedGatewayFeeNaira: feeNaira > 0 ? feeNaira : undefined,
        raw: payload,
      };
    } catch (error: any) {
      const msg = error?.response?.data?.message ?? error?.response?.data?.Message ?? error?.message;
      throw new AppError(`ALAT Pay Verification Error: ${msg ?? 'Unknown error'}`, 502);
    }
  }

  async createRefund(_providerReference: string, _amountNaira?: number): Promise<RefundResult> {
    throw new AppError('Refunds are disabled per policy. For reversals: use Admin → Reversal Ledger.', 400);
  }
}
