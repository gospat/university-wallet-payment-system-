import type {
  AlatpayCheckoutEnv,
  AlatpayNativeModalLaunchCallbacks,
  AlatpayPublicCheckout,
} from '../types/alatpay';
import { isAlatpayUuid } from '../types/alatpay';

const SDK_SRC: Record<AlatpayCheckoutEnv, string> = {
  production: 'https://web.alatpay.ng/js/alatpay.js',
  sandbox: 'https://alatpay-client.azurewebsites.net/js/alatpay.js',
};

let loadPromise: Promise<void> | null = null;
let loadEnv: AlatpayCheckoutEnv | null = null;

function detectDefaultEnv(): AlatpayCheckoutEnv {
  const override = (import.meta as any).env?.VITE_ALATPAY_ENV;
  if (typeof override === 'string') {
    const v = override.trim().toLowerCase();
    if (v === 'production' || v === 'sandbox') return v;
  }
  return typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? 'production'
    : 'sandbox';
}

function isWindowAlatpayReady(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as any).Alatpay === 'object'
    && (window as any).Alatpay !== null
    && typeof (window as any).Alatpay.setup === 'function';
}

function extractAlatpayFinalTxId(providerTx: unknown): string | null {
  if (providerTx == null || typeof providerTx !== 'object') return null;
  const root = providerTx as Record<string, any>;
  const candidates: Array<unknown> = [
    root?.Value?.Data?.Id,
    root?.Value?.Data?.id,
    root?.data?.id,
    root?.data?.Id,
    root?.data?.transactionId,
    root?.data?.TransactionId,
    root?.Id,
    root?.id,
    root?.Value?.Data?.transactionId,
    root?.Value?.Data?.TransactionId,
    root?.transactionId,
    root?.TransactionId,
    root?.Customer?.TransactionId,
    root?.Customer?.transactionId,
    root?.data?.customer?.TransactionId,
    root?.data?.customer?.transactionId,
    root?.data?.customer?.transaction_id,
  ];
  for (const c of candidates) {
    if (isAlatpayUuid(c)) return String(c).trim().toLowerCase();
  }
  return null;
}

export function loadAlatpaySdk(env?: AlatpayCheckoutEnv): Promise<void> {
  const effectiveEnv: AlatpayCheckoutEnv = env ?? detectDefaultEnv();
  if (isWindowAlatpayReady() && loadEnv === effectiveEnv && loadPromise !== null) {
    return loadPromise;
  }
  if (loadPromise !== null && loadEnv === effectiveEnv) {
    return loadPromise;
  }
  loadEnv = effectiveEnv;
  loadPromise = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Document not available (SSR)'));
      return;
    }
    if (isWindowAlatpayReady()) {
      resolve();
      return;
    }
    let timer: number | null = window.setTimeout(() => {
      timer = null;
      cleanup();
      reject(new Error('ALATPAY_SDK_LOAD_TIMEOUT'));
    }, 6000) as unknown as number;
    let script: HTMLScriptElement | null = document.querySelector<HTMLScriptElement>(
      `script[data-alatpay-sdk-env="${effectiveEnv}"]`,
    );
    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const cleanup = () => {
      clearTimer();
    };
    if (!script) {
      script = document.createElement('script');
      script.src = SDK_SRC[effectiveEnv];
      script.async = true;
      script.defer = true;
      script.setAttribute('data-alatpay-sdk-env', effectiveEnv);
      script.setAttribute('data-alatpay-role', 'checkout-sdk');
      script.referrerPolicy = 'strict-origin-when-cross-origin';
      script.addEventListener('load', () => {
        if (isWindowAlatpayReady()) {
          clearTimer();
          resolve();
        } else {
          const check = (attempts: number) => {
            if (isWindowAlatpayReady()) {
              clearTimer();
              resolve();
              return;
            }
            if (attempts <= 0) {
              clearTimer();
              reject(new Error('ALATPAY_SDK_SETUP_MISSING'));
              return;
            }
            window.setTimeout(() => check(attempts - 1), 150);
          };
          check(6);
        }
      }, { once: true });
      script.addEventListener('error', () => {
        clearTimer();
        reject(new Error('ALATPAY_SDK_NETWORK_ERROR'));
      }, { once: true });
      document.head.appendChild(script);
    } else {
      const poll = (attempts: number) => {
        if (isWindowAlatpayReady()) {
          clearTimer();
          resolve();
          return;
        }
        if (attempts <= 0) {
          clearTimer();
          reject(new Error('ALATPAY_SDK_PRE_EXISTING_BUT_NOT_READY'));
          return;
        }
        window.setTimeout(() => poll(attempts - 1), 150);
      };
      poll(20);
    }
  });
  return loadPromise;
}

export async function launchAlatpayNativeModal(
  checkout: AlatpayPublicCheckout,
  callbacks: AlatpayNativeModalLaunchCallbacks,
): Promise<void> {
  await loadAlatpaySdk();
  const Alatpay = (window as any).Alatpay;
  if (!Alatpay || typeof Alatpay.setup !== 'function') {
    callbacks.onError?.({ code: 'ALATPAY_SDK_NOT_AVAILABLE', message: 'Checkout SDK not available.' });
    throw new Error('ALATPAY_SDK_NOT_AVAILABLE');
  }
  const fallback = checkout.fallback ?? {};
  let lastReportedFinalTxId: string | null = null;
  const reportTransaction = (providerTx: unknown) => {
    const finalTxId = extractAlatpayFinalTxId(providerTx);
    if (finalTxId && lastReportedFinalTxId === finalTxId) return;
    lastReportedFinalTxId = finalTxId;
    callbacks.onReportTransaction({
      bellsReference: String(checkout.metadata?.bells_payment_reference ?? ''),
      orderReference: String(checkout.metadata?.order_reference ?? ''),
      initPaymentReference: String(checkout.metadata?.init_payment_reference ?? ''),
      providerTx,
      extractedFinalTxId: finalTxId,
    });
  };
  const cfg = {
    apiKey: checkout.apiKey,
    businessId: checkout.businessId,
    amount: checkout.amount,
    currency: checkout.currency ?? 'NGN',
    email: checkout.email ?? undefined,
    firstName: checkout.firstName ?? undefined,
    lastName: checkout.lastName ?? undefined,
    phone: checkout.phone ?? undefined,
    autoCloseModal: checkout.autoCloseModal ?? true,
    metadata: checkout.metadata ?? {},
    fallback: {
      enableRedirect: false,
      enablePopup: true,
      handshakeTimeoutMs: Number.isFinite(fallback.handshakeTimeoutMs) ? fallback.handshakeTimeoutMs : 4500,
    },
    onTransaction: (providerTx: unknown) => {
      reportTransaction(providerTx);
    },
    onSuccess: (providerTx: unknown) => {
      reportTransaction(providerTx);
    },
    onClose: () => {
      callbacks.onClosed?.();
    },
  };
  try {
    const handle = Alatpay.setup(cfg);
    const op = (handle.open ?? handle.show) as (() => void) | undefined;
    if (typeof op === 'function') {
      op.call(handle);
    } else {
      callbacks.onError?.({ code: 'ALATPAY_SDK_NO_OPEN', message: 'SDK did not expose an open/show method.' });
    }
  } catch (err: any) {
    callbacks.onError?.({
      code: err?.code ?? 'ALATPAY_NATIVE_LAUNCH_ERROR',
      message: err?.message ?? 'Unable to launch ALATPay native checkout.',
    });
    throw err;
  }
}
