import { PaymentGateway } from '@prisma/client';
import { IPaymentProvider, InitializeOptions, InitializeResult, VerifyResult, RefundResult } from '../types';
import { PaystackService, computePaymentBreakdown } from '../../paystack';
import { kobo } from '../../../utils/paystack';
import { TransactionStatus } from '@prisma/client';
import { AppError } from '../../../utils/AppError';

export class PaystackProvider implements IPaymentProvider {
  readonly name = PaymentGateway.PAYSTACK;

  async initialize(
    email: string,
    baseAmountNaira: number,
    opts: InitializeOptions,
  ): Promise<InitializeResult> {
    const raw = await PaystackService.initializeTransaction(email, baseAmountNaira, {
      reference: opts.reference,
      callbackUrl: opts.callbackUrl,
      channels: opts.channels,
      metadata: opts.metadata,
      feePurpose: opts.feePurpose ?? 'INVOICE_PAYMENT',
    });
    const breakdown = raw?.feeBreakdown ?? computePaymentBreakdown(baseAmountNaira);
    return {
      checkoutUrl: raw?.authorization_url ?? null,
      authorization_url: raw?.authorization_url ?? null,
      access_code: raw?.access_code ?? null,
      providerReference: raw?.reference ?? opts.reference,
      sessionId: raw?.access_code ?? null,
      feeBreakdown: breakdown,
      channelsUsed: raw?.channelsUsed ?? opts.channels ?? null,
      raw,
    };
  }

  async verify(providerReference: string): Promise<VerifyResult> {
    const data = await PaystackService.verifyTransaction(providerReference);
    const paidKobo = Number(data?.amount ?? 0);
    const paidNaira = kobo.toNaira(paidKobo);
    const channel = String(data?.channel ?? '').trim() || null;
    const paidAt = data?.paidAt
      ? new Date(data.paidAt)
      : data?.transaction_date
      ? new Date(data.transaction_date)
      : new Date();
    const rawStatus = String(data?.status ?? '').toLowerCase();
    let status: TransactionStatus = TransactionStatus.PENDING;
    if (rawStatus === 'success' || rawStatus === 'completed' || rawStatus === 'paid') {
      status = TransactionStatus.SUCCESS;
    } else if (rawStatus === 'failed' || rawStatus === 'declined' || rawStatus === 'rejected' || rawStatus === 'expired' || rawStatus === 'abandoned') {
      status = TransactionStatus.FAILED;
    }
    return {
      providerReference: String(data?.reference ?? providerReference),
      paidAmountNaira: paidNaira,
      paidAmountMinor: paidKobo,
      status,
      channel,
      paidAt,
      currency: String(data?.currency ?? 'NGN'),
      providerStatus: rawStatus,
      expectedGatewayFeeNaira:
        Number(data?.expected_deduction ?? data?.gateway_fee ?? 0) > 0
          ? kobo.toNaira(Number(data?.expected_deduction ?? data?.gateway_fee ?? 0))
          : undefined,
      raw: data,
    };
  }

  async createRefund(providerReference: string, amountNaira?: number): Promise<RefundResult> {
    throw new AppError('Refunds are disabled per policy', 400);
  }
}
