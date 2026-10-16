import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { launchAlatpayNativeModal } from '../utils/alatpayCheckout';
import type { AlatpayPublicCheckout, AlatpayNativeModalLaunchCallbacks } from '../types/alatpay';

type ReportTransactionFn = AlatpayNativeModalLaunchCallbacks['onReportTransaction'];
type ClosedFn = NonNullable<AlatpayNativeModalLaunchCallbacks['onClosed']>;
type ErrorFn = NonNullable<AlatpayNativeModalLaunchCallbacks['onError']>;

type CapturedCfg = {
  onTransaction: (tx: unknown) => void;
  onSuccess: (tx: unknown) => void;
  onClose: () => void;
};

const FINAL_UUID = 'd6b6d96c-92f9-4926-88a6-ffbe4d79ac27';
const CORRELATION_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeCheckout(): AlatpayPublicCheckout {
  return {
    apiKey: 'pk_test_dummy',
    businessId: 'BUS-TEST-001',
    amount: 150,
    currency: 'NGN',
    autoCloseModal: true,
    email: 'student@example.com',
    firstName: 'Test',
    lastName: 'Student',
    metadata: {
      bells_payment_reference: 'PAY-20261013-TEST01',
      order_reference: 'WEMA-PAY-20261013-TEST01',
      init_payment_reference: 'payk-init-xyz',
    },
    fallback: {
      enableRedirect: false,
      enablePopup: true,
      handshakeTimeoutMs: 4500,
    },
  };
}

describe('alatpayCheckout — actual implementation', () => {
  let capturedCfg!: CapturedCfg;
  let reportSpy: Mock<ReportTransactionFn>;
  let closedSpy: Mock<ClosedFn>;
  let errorSpy: Mock<ErrorFn>;

  beforeEach(() => {
    reportSpy = vi.fn<ReportTransactionFn>();
    closedSpy = vi.fn<ClosedFn>();
    errorSpy = vi.fn<ErrorFn>();
    window.Alatpay = {
      setup: (cfg: CapturedCfg) => {
        capturedCfg = cfg;
        return {
          open: vi.fn(),
          show: vi.fn(),
          close: vi.fn(),
        };
      },
    };
  });

  function makeCallbacks(): AlatpayNativeModalLaunchCallbacks {
    return {
      onReportTransaction: reportSpy,
      onClosed: closedSpy,
      onError: errorSpy,
    };
  }

  it('onTransaction fires onReportTransaction with extractedFinalTxId for data.id', async () => {
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    capturedCfg.onTransaction({ data: { id: FINAL_UUID, status: 'SUCCESSFUL' } });
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).toBe(FINAL_UUID.toLowerCase());
  });

  it('onSuccess ALONE (when onTransaction does not fire) captures the final UUID', async () => {
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    capturedCfg.onSuccess({ Value: { Data: { Id: FINAL_UUID } } });
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).toBe(FINAL_UUID.toLowerCase());
  });

  it('onTransaction then onSuccess with same UUID dedups (onReportTransaction called once)', async () => {
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    const payload = { data: { id: FINAL_UUID } };
    capturedCfg.onTransaction(payload);
    capturedCfg.onSuccess(payload);
    expect(reportSpy).toHaveBeenCalledTimes(1);
  });

  it('onTransaction then onSuccess with DIFFERENT UUIDs reports both', async () => {
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    capturedCfg.onTransaction({ data: { id: FINAL_UUID } });
    const other = 'e7c7c7c7-7777-4777-8777-777777777777';
    capturedCfg.onSuccess({ data: { id: other } });
    expect(reportSpy).toHaveBeenCalledTimes(2);
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).toBe(FINAL_UUID.toLowerCase());
    expect(reportSpy.mock.calls[1][0].extractedFinalTxId).toBe(other.toLowerCase());
  });

  it('extracts UUID from all 17 documented shapes', async () => {
    const shapes: Array<Record<string, unknown>> = [
      { Value: { Data: { Id: FINAL_UUID } } },
      { Value: { Data: { id: FINAL_UUID } } },
      { data: { id: FINAL_UUID } },
      { data: { Id: FINAL_UUID } },
      { data: { transactionId: FINAL_UUID } },
      { data: { TransactionId: FINAL_UUID } },
      { Id: FINAL_UUID },
      { id: FINAL_UUID },
      { Value: { Data: { transactionId: FINAL_UUID } } },
      { Value: { Data: { TransactionId: FINAL_UUID } } },
      { transactionId: FINAL_UUID },
      { TransactionId: FINAL_UUID },
      { Customer: { TransactionId: FINAL_UUID } },
      { Customer: { transactionId: FINAL_UUID } },
      { data: { customer: { TransactionId: FINAL_UUID } } },
      { data: { customer: { transactionId: FINAL_UUID } } },
      { data: { customer: { transaction_id: FINAL_UUID } } },
    ];
    for (const shape of shapes) {
      reportSpy.mockClear();
      await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
      capturedCfg.onTransaction(shape);
      expect(reportSpy).toHaveBeenCalledTimes(1);
      expect(reportSpy.mock.calls[0][0].extractedFinalTxId).toBe(FINAL_UUID.toLowerCase());
    }
  });

  it('distinguishes documented transaction IDs from correlation/customer/session UUIDs', async () => {
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    const payload = {
      correlationId: CORRELATION_UUID,
      customerId: CUSTOMER_UUID,
      sessionId: SESSION_UUID,
      data: { status: 'PENDING' },
    };
    capturedCfg.onTransaction(payload);
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).toBeNull();
  });

  it('ignores correlation/customer/session UUIDs even when a real data.id is present (picks real tx)', async () => {
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    const payload = {
      correlationId: CORRELATION_UUID,
      customerId: CUSTOMER_UUID,
      sessionId: SESSION_UUID,
      data: { id: FINAL_UUID, status: 'SUCCESSFUL' },
    };
    capturedCfg.onTransaction(payload);
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).toBe(FINAL_UUID.toLowerCase());
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).not.toBe(CORRELATION_UUID);
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).not.toBe(CUSTOMER_UUID);
  });

  it('rejects non-UUID-v4 strings (WEMA ref, PAY ref, v1 UUID) as null', async () => {
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    capturedCfg.onTransaction({ data: { id: 'WEMA-PAY-20261013-TEST01' } });
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).toBeNull();

    reportSpy.mockClear();
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    capturedCfg.onTransaction({ Value: { Data: { Id: 'PAY-123' } } });
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).toBeNull();

    reportSpy.mockClear();
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    const V1 = '00000000-0000-1000-8000-000000000000';
    capturedCfg.onTransaction({ data: { id: V1 } });
    expect(reportSpy.mock.calls[0][0].extractedFinalTxId).toBeNull();
  });

  it('onClose does NOT mark failure — only calls onClosed', async () => {
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    capturedCfg.onClose();
    expect(closedSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('passes bells/order/init references through onReportTransaction', async () => {
    await launchAlatpayNativeModal(makeCheckout(), makeCallbacks());
    capturedCfg.onTransaction({ data: { id: FINAL_UUID } });
    const ctx = reportSpy.mock.calls[0][0];
    expect(ctx.bellsReference).toBe('PAY-20261013-TEST01');
    expect(ctx.orderReference).toBe('WEMA-PAY-20261013-TEST01');
    expect(ctx.initPaymentReference).toBe('payk-init-xyz');
  });
});
