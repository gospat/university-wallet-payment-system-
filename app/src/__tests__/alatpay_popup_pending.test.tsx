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
