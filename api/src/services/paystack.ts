import axios from 'axios';
import { AppError } from '../utils/AppError';
import { kobo } from '../utils/paystack';

type PaymentBreakdown = {
  baseAmount: number;
  serviceCharge: number;
  gatewayFee: number;
  totalAmount: number;
  serviceChargeMode: 'none' | 'flat' | 'percent';
  gatewayFeeMode: 'none' | 'percent';
};

type InitializeOptions = {
  channels?: string[];
  reference?: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  feePurpose?: 'WALLET_DEPOSIT' | 'INVOICE_PAYMENT';
  [key: string]: any;
};

type ServiceChargeConfig = {
  flat: number;
  percent: number;
  gatewayFeePercent: number;
};

function readServiceChargeConfig(): ServiceChargeConfig {
  const flat = Number(process.env.PAYSTACK_SERVICE_CHARGE_FLAT ?? 0);
  const percent = Number(process.env.PAYSTACK_SERVICE_CHARGE_PERCENT ?? 0);
  const gatewayFeePercent = Number(process.env.PAYSTACK_GATEWAY_FEE_PERCENT ?? 0);
  return {
    flat: Number.isFinite(flat) && flat > 0 ? flat : 0,
    percent: Number.isFinite(percent) && percent > 0 ? percent : 0,
    gatewayFeePercent:
      Number.isFinite(gatewayFeePercent) && gatewayFeePercent > 0 ? gatewayFeePercent : 0,
  };
}

export function computePaymentBreakdown(baseAmount: number, configOverride?: Partial<ServiceChargeConfig>): PaymentBreakdown {
  const base = +baseAmount.toFixed(2);
  return {
    baseAmount: base,
    serviceCharge: 0,
    gatewayFee: 0,
    totalAmount: base,
    serviceChargeMode: 'none',
    gatewayFeeMode: 'none',
  };
}

function readEnabledChannels(fallback?: string[]): string[] | undefined {
  const raw = process.env.PAYSTACK_ENABLED_CHANNELS;
  if (!raw || !String(raw).trim()) return fallback;
  const list = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

const KNOWN_OPTS_KEYS = new Set(['channels', 'reference', 'callbackUrl', 'metadata', 'feePurpose']);

function legacyNormalizeOptions(opts: InitializeOptions): {
  channels?: string[];
  reference?: string;
  callbackUrl?: string;
  metadata: Record<string, unknown>;
  feePurpose: 'WALLET_DEPOSIT' | 'INVOICE_PAYMENT';
} {
  const explicitMeta: Record<string, unknown> | undefined = opts.metadata;
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(opts)) {
    if (!KNOWN_OPTS_KEYS.has(k)) extra[k] = (opts as any)[k];
  }
  const metadata = explicitMeta && Object.keys(explicitMeta).length > 0 ? explicitMeta : extra;
  return {
    channels: opts.channels,
    reference: opts.reference,
    callbackUrl: opts.callbackUrl,
    metadata,
    feePurpose: opts.feePurpose ?? ('userId' in opts || 'walletId' in opts ? 'WALLET_DEPOSIT' : 'INVOICE_PAYMENT'),
  };
}

export class PaystackService {
  private static readonly SECRET_KEY = process.env.PAYSTACK_SECRET_KEY as string;
  private static readonly BASE_URL = 'https://api.paystack.co';

  static async initializeTransaction(
    email: string,
    baseAmountNaira: number,
    opts: InitializeOptions = {},
  ) {
    if (!Number.isFinite(baseAmountNaira) || baseAmountNaira <= 0) {
      throw new AppError('Payment amount must be greater than zero.', 400);
    }
    const norm = legacyNormalizeOptions(opts);
    const breakdown = computePaymentBreakdown(baseAmountNaira);
    const channels = readEnabledChannels(norm.channels);
    const callbackUrl =
      norm.callbackUrl ||
      process.env.PAYSTACK_CALLBACK_URL ||
      `${process.env.FRONTEND_BASE_URL ?? 'http://localhost:5174'}/student/dashboard`;

    const legacyFeesShape = {
      tuition: breakdown.baseAmount,
      serviceCharge: breakdown.serviceCharge,
      paystackFee: breakdown.gatewayFee,
      total: breakdown.totalAmount,
    };
    const enhancedMetadata: Record<string, any> = {
      ...(norm.metadata ?? {}),
      feePurpose: norm.feePurpose,
      breakdown: {
        baseAmount: breakdown.baseAmount,
        serviceCharge: breakdown.serviceCharge,
        gatewayFee: breakdown.gatewayFee,
        total: breakdown.totalAmount,
        serviceChargeMode: breakdown.serviceChargeMode,
        gatewayFeeMode: breakdown.gatewayFeeMode,
      },
      fees: legacyFeesShape,
    };
    const reference = norm.reference;

    try {
      const body: Record<string, any> = {
        email,
        amount: kobo.fromNaira(breakdown.totalAmount),
        metadata: enhancedMetadata,
        callback_url: callbackUrl,
      };
      if (reference) body.reference = reference;
      if (channels && channels.length > 0) body.channels = channels;

      const response = await axios.post(`${this.BASE_URL}/transaction/initialize`, body, {
        headers: {
          Authorization: `Bearer ${this.SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      return {
        ...(response.data?.data ?? {}),
        reference: reference ?? response.data?.data?.reference,
        feeBreakdown: breakdown,
        fees: legacyFeesShape,
        channelsUsed: channels ?? null,
      };
    } catch (error: any) {
      throw new AppError(
        `Paystack Initialization Error: ${error.response?.data?.message || error.message}`,
        500,
      );
    }
  }

  static async verifyTransaction(reference: string) {
    try {
      const response = await axios.get(
        `${this.BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
        {
          headers: {
            Authorization: `Bearer ${this.SECRET_KEY}`,
          },
        },
      );
      const data = response.data?.data;
      if (!data) throw new AppError('Paystack returned empty transaction.', 502);
      return data;
    } catch (error: any) {
      throw new AppError(
        `Paystack Verification Error: ${error.response?.data?.message || error.message}`,
        500,
      );
    }
  }

  static async createRefund(transactionReference: string, amountNaira?: number) {
    if (!transactionReference || !String(transactionReference).trim()) {
      throw new AppError('Transaction reference required to create refund.', 400);
    }
    try {
      const body: Record<string, any> = { transaction: transactionReference };
      if (Number.isFinite(amountNaira) && amountNaira! > 0) {
        body.amount = kobo.fromNaira(amountNaira!);
      }
      const response = await axios.post(`${this.BASE_URL}/refund`, body, {
        headers: {
          Authorization: `Bearer ${this.SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      });
      const data = response.data?.data;
      if (!data) throw new AppError('Paystack returned empty refund response.', 502);
      return {
        expectedStatus: data.status ?? 'pending',
        expectedReference: (data.reference ?? data.refund_reference ?? null) as string | null,
        expectedGatewayFee: Number(data.expected_deduction ?? data.gateway_fee ?? 0),
        expectedSettlement: Number(data.settlement_amount ?? 0),
        raw: data,
      };
    } catch (error: any) {
      throw new AppError(
        `Paystack Refund Error: ${error.response?.data?.message || error.message}`,
        502,
      );
    }
  }
}
