import { Decimal } from '@prisma/client/runtime/library';
import { TransactionStatus, PaymentGateway } from '@prisma/client';

export type PaymentBreakdown = {
  baseAmount: number;
  serviceCharge: number;
  gatewayFee: number;
  totalAmount: number;
  serviceChargeMode: 'none' | 'flat' | 'percent';
  gatewayFeeMode: 'none' | 'percent';
};

export type InitializeOptions = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  reference: string;
  callbackUrl: string;
  channels?: string[];
  metadata?: Record<string, unknown>;
  feePurpose?: 'WALLET_DEPOSIT' | 'INVOICE_PAYMENT';
  [key: string]: any;
};

export type InitializeResult = {
  checkoutUrl: string | null;
  authorization_url?: string | null;
  access_code?: string | null;
  providerReference: string;
  sessionId?: string | null;
  feeBreakdown: PaymentBreakdown;
  channelsUsed?: string[] | null;
  raw: any;
};

export type VerifyResult = {
  providerReference: string;
  paidAmountNaira: number;
  paidAmountMinor: number;
  status: TransactionStatus;
  channel: string | null;
  paidAt: Date;
  currency: string;
  providerStatus: string;
  expectedGatewayFeeNaira?: number;
  raw: any;
};

export type RefundResult = {
  success: boolean;
  status: string;
  reference: string | null;
  expectedGatewayFeeNaira?: number;
  expectedSettlementNaira?: number;
  raw?: any;
};

export interface IPaymentProvider {
  readonly name: PaymentGateway;
  initialize(
    email: string,
    baseAmountNaira: number,
    opts: InitializeOptions,
  ): Promise<InitializeResult>;
  verify(providerReference: string): Promise<VerifyResult>;
  createRefund?(
    providerReference: string,
    amountNaira?: number,
  ): Promise<RefundResult>;
}

export function gatewayLabel(gateway: PaymentGateway, channel?: string | null): string {
  const brand = gateway === PaymentGateway.PAYSTACK ? 'Paystack' : 'ALATPay';
  return channel ? `${brand} · ${String(channel)}` : brand;
}

export function decimalOrNull(n: number | Decimal | null | undefined): number {
  if (n === null || n === undefined) return 0;
  return Number(Number(n).toFixed(2));
}
