// =============================================================================
// Frontend tests: ALATPay popup remains Pending while backend confirms SUCCESS
// -----------------------------------------------------------------------------
// Production observation: the ALATPay popup stays on "Payment Processing/Pending"
// even after the webhook confirms the payment and our backend records SUCCESS.
// The student must be transitioned to our Payment Successful screen based
// SOLELY on the backend's persisted status — never on the popup state,
// the SDK callback, or a frontend timer.
//
// Coverage:
//   K. Backend SUCCESS while popup open → popup closed + navigate to callback
//   L. Backend still PENDING → keep polling, no navigation, no close()
//   M. Backend FAILED → popup closed + navigate to callback
//   N. SDK exposes no close() → still navigate on backend SUCCESS
//   O. Network error during polling → NOT a failure, keep polling
//   P. Student manually closes popup (onClosed) → navigate to callback, no fail
//   Q. SDK onReportTransaction never fires → backend polling still drives nav
// =============================================================================
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// ---- Mocks ----------------------------------------------------------------

const navigateMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(),
  useLocation: vi.fn(() => ({ pathname: '/student/payments/confirm/INV-1' })),
  useNavigate: () => navigateMock,
  Link: ({ children, to }: any) => React.createElement('a', { href: to }, children),
}));

const mockUser = { firstName: 'Test', lastName: 'Student', email: 'student@example.com' };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, logout: vi.fn() }),
}));

vi.mock('../i18n/en', () => ({
  i18n: {
    portals: { student: { dashboardBrand: 'Bells University' } },
    paymentResult: { confirmPayment: { ctaCancel: 'Cancel', heroTitle: 'Confirm Payment', heroSubtitle: 'Review', feeLabel: 'Fee', sessionLabel: 'Session', studentLabel: 'Student', matricLabel: 'Matric', amountLabel: 'Amount', ctaProceed: 'Pay Now' } },
    payment: { processingVia: 'Processing via' },
  },
}));

vi.mock('../components/PortalShell', () => ({
  default: ({ children }: any) => React.createElement('div', { 'data-testid': 'portal-shell' }, children),
}));

vi.mock('../components/HostedCheckoutModal', () => ({
  default: () => null,
}));

const getInvoiceMock = vi.fn();
const initiatePaymentMock = vi.fn();
const getPaymentStatusMock = vi.fn();

vi.mock('../services/studentFees', () => ({
  studentFeeApi: {
    getInvoice: (...args: any[]) => getInvoiceMock(...args),
    initiatePayment: (...args: any[]) => initiatePaymentMock(...args),
    getPaymentStatus: (...args: any[]) => getPaymentStatusMock(...args),
  },
}));

const alatpayCloseMock = vi.fn();
const launchAlatpayMock = vi.fn();

vi.mock('../utils/alatpayCheckout', () => ({
  launchAlatpayNativeModal: (...args: any[]) => launchAlatpayMock(...args),
}));

vi.mock('lucide-react', () => ({
  ArrowLeft: () => null, ArrowRight: () => null, Loader2: () => null,
  CreditCard: () => null, Receipt: () => null, ShieldCheck: () => null,
  User: () => null, GraduationCap: () => null, Calculator: () => null,
}));

import { useParams } from 'react-router-dom';
import PaymentConfirmation from '../pages/student/PaymentConfirmation';

// ---- Test helpers ---------------------------------------------------------

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderConfirm() {
  container = document.createElement('div');
  document.body.appendChild(container);
  (useParams as any).mockReturnValue({ invoiceId: 'INV-1' });
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(PaymentConfirmation));
  });
}

async function flushLoad() {
  await act(async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  });
}

function cleanup() {
  act(() => { root?.unmount(); });
  container?.remove();
}

function clickPay() {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => b.type === 'button' && !b.disabled,
  );
  if (!btn) throw new Error('Pay button not found. Content: ' + (container.textContent ?? '').slice(0, 200));
  act(() => { (btn as HTMLButtonElement).click(); });
}

async function proceed() {
  clickPay();
  // Flush microtasks so initiatePayment + launchAlatpayNativeModal resolve
  // and the polling timer is scheduled — but do NOT advance timers yet
  // (that would fire the polling loop).
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  });
}

async function tickPolls(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getInvoiceMock.mockResolvedValue({
    data: {
      invoice: {
        id: 42, invoiceNumber: 'INV/2026/00042', amountDue: 45000, amountPaid: 0,
        fee: { name: 'Tuition' }, session: '2026/2027',
        studentName: 'Test Student', matricNumber: 'BLS/123',
      },
    },
  });
  initiatePaymentMock.mockResolvedValue({
    data: {
      checkout_popup_mode: 'alatpay_native_modal_v1',
      alatpay_public_checkout: { apiKey: 'pk', businessId: 'bid', amount: 45000, currency: 'NGN', autoCloseModal: true, metadata: { bells_payment_reference: 'PAY-REF-001', order_reference: 'ORD-1', init_payment_reference: 'INIT-1' } },
      alatpay_refs: { bells_reference: 'PAY-REF-001' },
      reference: 'PAY-REF-001',
    },
  });
  alatpayCloseMock.mockReset();
  launchAlatpayMock.mockResolvedValue({ close: alatpayCloseMock });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- K. Backend SUCCESS while popup open -----------------------------------

it('K: backend SUCCESS while popup open → closes popup + navigates to callback', async () => {
  getPaymentStatusMock
    .mockResolvedValueOnce({ status: 'PENDING' })
    .mockResolvedValueOnce({ status: 'SUCCESS', reference: 'PAY-REF-001' });

  renderConfirm();
  await flushLoad();
  await proceed();

  expect(launchAlatpayMock).toHaveBeenCalledTimes(1);

  // First poll → PENDING, no navigation
  await tickPolls(2500);
  expect(getPaymentStatusMock).toHaveBeenCalledWith('PAY-REF-001');
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();

  // Second poll → SUCCESS: popup closed + navigated
  await tickPolls(2500);
  expect(alatpayCloseMock).toHaveBeenCalledTimes(1);
  expect(navigateMock).toHaveBeenCalledWith('/student/payments/callback/PAY-REF-001');
});

// ---- L. Backend still PENDING ---------------------------------------------

it('L: backend stays PENDING → keep polling, no navigation, no close', async () => {
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING' });

  renderConfirm();
  await flushLoad();
  await proceed();

  for (let i = 0; i < 3; i++) {
    await tickPolls(2500);
  }
  expect(getPaymentStatusMock).toHaveBeenCalledTimes(3);
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();
});

// ---- M. Backend FAILED ----------------------------------------------------

it('M: backend FAILED while popup open → closes popup + navigates to callback', async () => {
  getPaymentStatusMock.mockResolvedValueOnce({ status: 'PENDING' })
    .mockResolvedValueOnce({ status: 'FAILED', reference: 'PAY-REF-001' });

  renderConfirm();
  await flushLoad();
  await proceed();

  await tickPolls(5000);

  expect(alatpayCloseMock).toHaveBeenCalledTimes(1);
  expect(navigateMock).toHaveBeenCalledWith('/student/payments/callback/PAY-REF-001');
});

// ---- N. SDK exposes no close() --------------------------------------------

it('N: no SDK close() method → still navigates on backend SUCCESS', async () => {
  launchAlatpayMock.mockResolvedValue({ close: undefined });
  getPaymentStatusMock.mockResolvedValueOnce({ status: 'PENDING' })
    .mockResolvedValueOnce({ status: 'SUCCESS', reference: 'PAY-REF-001' });

  renderConfirm();
  await flushLoad();
  await proceed();

  await tickPolls(5000);

  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).toHaveBeenCalledWith('/student/payments/callback/PAY-REF-001');
});

// ---- O. Network error during polling --------------------------------------

it('O: network error during polling → NOT a failure, keeps polling', async () => {
  getPaymentStatusMock
    .mockRejectedValueOnce(new Error('Network error'))
    .mockResolvedValueOnce({ status: 'PENDING' })
    .mockResolvedValueOnce({ status: 'SUCCESS', reference: 'PAY-REF-001' });

  renderConfirm();
  await flushLoad();
  await proceed();

  await tickPolls(2500);
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();

  await tickPolls(2500);
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();

  await tickPolls(2500);
  expect(alatpayCloseMock).toHaveBeenCalledTimes(1);
  expect(navigateMock).toHaveBeenCalledWith('/student/payments/callback/PAY-REF-001');
});

// ---- P. Student manually closes popup -------------------------------------

it('P: onClosed fires → navigates to callback, no failure declared', async () => {
  let onClosedCb: (() => void) | null = null;
  launchAlatpayMock.mockImplementation(async (_co: any, cb: any) => {
    onClosedCb = cb.onClosed ?? null;
    return { close: alatpayCloseMock };
  });
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING' });

  renderConfirm();
  await flushLoad();
  await proceed();

  act(() => { onClosedCb?.(); });

  expect(navigateMock).toHaveBeenCalledWith('/student/payments/callback/PAY-REF-001');
});

// ---- Q. SDK onReportTransaction never fires -------------------------------

it('Q: no SDK callback → backend polling alone drives navigation', async () => {
  getPaymentStatusMock
    .mockResolvedValueOnce({ status: 'PENDING' })
    .mockResolvedValueOnce({ status: 'SUCCESS', reference: 'PAY-REF-001' });

  renderConfirm();
  await flushLoad();
  await proceed();

  await tickPolls(5000);

  expect(alatpayCloseMock).toHaveBeenCalledTimes(1);
  expect(navigateMock).toHaveBeenCalledWith('/student/payments/callback/PAY-REF-001');
});

// ---- R. onTransaction + backend PENDING → capture UUID only ---------------
// The SDK fires onTransaction as soon as the transaction is created, which
// may be while it is still PENDING. onReportTransaction MUST only capture the
// provider UUID — it must NOT navigate or close the popup. Backend polling
// remains authoritative and must continue.

it('R: onTransaction + PENDING → captures UUID, popup stays open, no navigation, polling continues', async () => {
  let onReportTx: ((r: any) => void) | null = null;
  launchAlatpayMock.mockImplementation(async (_co: any, cb: any) => {
    onReportTx = cb.onReportTransaction ?? null;
    return { close: alatpayCloseMock };
  });
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING' });

  renderConfirm();
  await flushLoad();
  await proceed();

  act(() => {
    onReportTx?.({
      bellsReference: 'PAY-REF-001',
      orderReference: 'ORD-1',
      initPaymentReference: 'INIT-1',
      providerTx: { data: { id: '7162fb44-6d04-4590-ac65-a96061e272ab' } },
      extractedFinalTxId: '7162fb44-6d04-4590-ac65-a96061e272ab',
      source: 'transaction',
    });
  });

  // Popup NOT closed, no navigation yet.
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();

  // Polling continues — fire two poll cycles.
  await tickPolls(2500);
  const callsAfterFirst = getPaymentStatusMock.mock.calls.length;
  expect(callsAfterFirst).toBeGreaterThanOrEqual(1);
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();

  await tickPolls(2500);
  expect(getPaymentStatusMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();
});

// ---- S. onTransaction + later backend SUCCESS -----------------------------
// The provider UUID is captured onTransaction, but the popup stays open until
// backend polling sees persisted SUCCESS. Then: close popup exactly once,
// navigate exactly once, by Bells reference alone (no provider reference).

it('S: onTransaction then backend SUCCESS → popup closes once, navigates once by Bells ref', async () => {
  let onReportTx: ((r: any) => void) | null = null;
  launchAlatpayMock.mockImplementation(async (_co: any, cb: any) => {
    onReportTx = cb.onReportTransaction ?? null;
    return { close: alatpayCloseMock };
  });
  getPaymentStatusMock
    .mockResolvedValueOnce({ status: 'PENDING' })
    .mockResolvedValueOnce({ status: 'SUCCESS', reference: 'PAY-REF-001' });

  renderConfirm();
  await flushLoad();
  await proceed();

  act(() => {
    onReportTx?.({
      bellsReference: 'PAY-REF-001',
      orderReference: 'ORD-1',
      initPaymentReference: 'INIT-1',
      providerTx: { data: { id: '7162fb44-6d04-4590-ac65-a96061e272ab' } },
      extractedFinalTxId: '7162fb44-6d04-4590-ac65-a96061e272ab',
      source: 'transaction',
    });
  });

  // After onTransaction: popup still open, no navigation.
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();

  // First poll → PENDING: still no close/navigate.
  await tickPolls(2500);
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();

  // Second poll → SUCCESS: popup closed + navigated by Bells ref only.
  await tickPolls(2500);
  expect(alatpayCloseMock).toHaveBeenCalledTimes(1);
  expect(navigateMock).toHaveBeenCalledTimes(1);
  expect(navigateMock).toHaveBeenCalledWith('/student/payments/callback/PAY-REF-001');
});

// ---- U. SDK onSuccess while backend PENDING -------------------------------
// The SDK's onSuccess must NOT create financial SUCCESS. It may trigger an
// immediate backend status refresh, but the Bells success screen requires
// persisted backend SUCCESS/PAID. If the backend is still PENDING, the popup
// stays open and polling continues.

it('U: onSuccess while backend PENDING → no SUCCESS, popup stays open, check continues', async () => {
  let onSuccessCb: (() => void) | null = null;
  launchAlatpayMock.mockImplementation(async (_co: any, cb: any) => {
    onSuccessCb = cb.onSuccess ?? null;
    return { close: alatpayCloseMock };
  });
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING' });

  renderConfirm();
  await flushLoad();
  await proceed();

  act(() => { onSuccessCb?.(); });

  // onSuccess triggers an immediate check, but backend says PENDING:
  // no close, no navigation.
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();

  // Polling continues.
  const callsBefore = getPaymentStatusMock.mock.calls.length;
  await tickPolls(2500);
  expect(getPaymentStatusMock.mock.calls.length).toBeGreaterThan(callsBefore);
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();
});

// ---- V. onSuccess does not create duplicate in-flight polls ----------------
// onSuccess cancels the scheduled timer and fires an immediate poll. It must
// not create a parallel in-flight request while one is already running.

it('V: onSuccess during in-flight poll → no duplicate request', async () => {
  let onSuccessCb: (() => void) | null = null;
  let resolveFirst: ((v: any) => void) | null = null;
  launchAlatpayMock.mockImplementation(async (_co: any, cb: any) => {
    onSuccessCb = cb.onSuccess ?? null;
    return { close: alatpayCloseMock };
  });
  // First poll hangs (unresolved promise) to simulate an in-flight request.
  getPaymentStatusMock
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValue({ status: 'PENDING' });

  renderConfirm();
  await flushLoad();
  await proceed();

  // Fire the first poll (in-flight, unresolved).
  await tickPolls(2500);
  const callsDuringFlight = getPaymentStatusMock.mock.calls.length;

  // Trigger onSuccess while the first poll is still in flight.
  act(() => { onSuccessCb?.(); });
  // Flush microtasks — the immediate poll should be skipped (in-flight guard).
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

  // No new poll was started; still the same in-flight request.
  expect(getPaymentStatusMock.mock.calls.length).toBe(callsDuringFlight);

  // Resolve the first poll with PENDING; polling resumes normally.
  act(() => { resolveFirst?.({ status: 'PENDING' }); });
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();
});

// ---- W. No duplicate close or navigation from overlapping events ----------
// A backend SUCCESS poll, an onSuccess callback, and onTransaction all arriving
// together must result in exactly one close() and one navigation.

it('W: SUCCESS poll + onSuccess + onTransaction → exactly one close, one navigate', async () => {
  let onReportTx: ((r: any) => void) | null = null;
  let onSuccessCb: (() => void) | null = null;
  launchAlatpayMock.mockImplementation(async (_co: any, cb: any) => {
    onReportTx = cb.onReportTransaction ?? null;
    onSuccessCb = cb.onSuccess ?? null;
    return { close: alatpayCloseMock };
  });
  getPaymentStatusMock.mockResolvedValue({ status: 'SUCCESS', reference: 'PAY-REF-001' });

  renderConfirm();
  await flushLoad();
  await proceed();

  // Fire a poll that resolves to SUCCESS.
  await tickPolls(2500);

  // Immediately fire onSuccess and onTransaction (which would normally try to
  // trigger more checks). Because navigatedRef is now true, they are no-ops.
  act(() => { onSuccessCb?.(); });
  act(() => {
    onReportTx?.({
      bellsReference: 'PAY-REF-001',
      orderReference: 'ORD-1',
      initPaymentReference: 'INIT-1',
      providerTx: { data: { id: '7162fb44-6d04-4590-ac65-a96061e272ab' } },
      extractedFinalTxId: '7162fb44-6d04-4590-ac65-a96061e272ab',
      source: 'transaction',
    });
  });

  expect(alatpayCloseMock).toHaveBeenCalledTimes(1);
  expect(navigateMock).toHaveBeenCalledTimes(1);
});

// ---- T. Unmount while popup open → popup is closed, no unwanted redirect ---
// The SDK appends its popup iframes to document.body, outside the React tree.
// If the component unmounts while the popup is open, it must dismiss the popup
// without triggering an unwanted callback redirect.

it('T: unmount while popup open → closes popup, no unwanted redirect', async () => {
  launchAlatpayMock.mockResolvedValue({ close: alatpayCloseMock });
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING' });

  renderConfirm();
  await flushLoad();
  await proceed();

  expect(alatpayCloseMock).not.toHaveBeenCalled();
  expect(navigateMock).not.toHaveBeenCalled();

  cleanup();

  expect(alatpayCloseMock).toHaveBeenCalledTimes(1);
  // No navigation triggered by the unmount close.
  expect(navigateMock).not.toHaveBeenCalled();
});
