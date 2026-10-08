export type AlatpayCheckoutEnv = 'sandbox' | 'production';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isAlatpayUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_V4_RE.test(s.trim());
}

export type AlatpayPublicBusiness = {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly logoUrl: string;
};

export type AlatpayPublicCheckoutMetadata = {
  readonly bells_payment_reference: string;
  readonly order_reference: string;
  readonly init_payment_reference: string;
};

export type AlatpayPublicCheckoutFallback = {
  readonly enableRedirect: false;
  readonly enablePopup: true;
  readonly handshakeTimeoutMs: number;
};

export type AlatpayPublicCheckout = {
  readonly businessId: string;
  readonly business: AlatpayPublicBusiness;
  readonly amount: number;
  readonly currency: 'NGN';
  readonly autoCloseModal: boolean;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly metadata: AlatpayPublicCheckoutMetadata;
  readonly fallback: AlatpayPublicCheckoutFallback;
};

export type AlatpayNativeModalLaunchCallbacks = {
  onReportTransaction: (context: {
    bellsReference: string;
    orderReference: string;
    initPaymentReference: string;
    providerTx: unknown;
    extractedFinalTxId: string | null;
  }) => void;
  onError?: (err: { code?: string; message: string }) => void;
  onClosed?: () => void;
};

declare global {
  interface Window {
    Alatpay?: {
      setup: (cfg: any) => {
        open?: () => void;
        show?: () => void;
        close?: () => void;
      };
    };
  }
}

export {};
