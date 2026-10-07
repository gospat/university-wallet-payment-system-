export type AlatpayCheckoutEnv = 'sandbox' | 'production';

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
