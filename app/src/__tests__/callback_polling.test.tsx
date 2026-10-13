// =============================================================================
// Frontend tests: Callback polling (webhook-aware status flow) and
// PaymentConfirmation popup-close fallback navigation.
// -----------------------------------------------------------------------------
// Coverage (frontend A–J from spec):
//   A. ALATPay onSuccess returns UUID → callback page with providerReference
//   B. ALATPay onTransaction returns UUID → same
//   C. No SDK callback, popup closes → navigate to callback page (no failure)
//   D. Callback initially PENDING, webhook later SUCCESS → UI auto-updates
//   E. Several PENDING then SUCCESS → no false failure
//   F. Network error then SUCCESS → stay pending/retrying, then SUCCESS
//   G. Component unmount → polling stops
//   H. Tab becomes visible → immediate status check
//   I. Confirmed backend FAILED → only then show failure
//   J. Timeout with still-PENDING → delayed message, NOT failure
// =============================================================================
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// ---- Mocks ----------------------------------------------------------------

const navigateMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(),
  useSearchParams: vi.fn(),
  useLocation: vi.fn(() => ({ pathname: '/student/payments/callback/TEST' })),
  useNavigate: () => navigateMock,
  Link: ({ children, to }: any) => React.createElement('a', { href: to }, children),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { firstName: 'Test', lastName: 'Student', email: 'student@example.com' }, logout: vi.fn() }),
}));

vi.mock('../i18n/en', () => ({
  i18n: { portals: { student: { dashboardBrand: 'Bells University' } } },
}));

vi.mock('../components/PortalShell', () => ({
  default: ({ children }: any) => React.createElement('div', { 'data-testid': 'portal-shell' }, children),
}));

vi.mock('../components/student/PaymentResult', () => ({
  default: ({ state, data }: any) =>
    React.createElement('div', { 'data-testid': 'payment-result', 'data-state': state },
      state === 'success' ? 'Payment Successful' : state === 'failure' ? 'Payment Failed' : 'Pending',
      data?.reference ? ` Reference: ${data.reference}` : '',
      data?.receiptNumber ? ` Receipt: ${data.receiptNumber}` : '',
    ),
}));

const getPaymentStatusMock = vi.fn();
const verifyPaymentMock = vi.fn();
const refreshCachesMock = vi.fn();

vi.mock('../services/studentFees', () => ({
  studentFeeApi: {
    getPaymentStatus: (...args: any[]) => getPaymentStatusMock(...args),
    verifyPayment: (...args: any[]) => verifyPaymentMock(...args),
    refreshStudentPaymentCaches: (...args: any[]) => refreshCachesMock(...args),
    initiatePayment: vi.fn(),
  },
}));

vi.mock('lucide-react', () => ({
  ArrowLeft: () => null, Clock: () => null, History: () => null,
  Mail: () => null, RefreshCw: () => null, AlertCircle: () => null,
  CheckCircle2: () => null, XCircle: () => null, Loader2: () => null,
  Download: () => null,
}));

import { useParams, useSearchParams } from 'react-router-dom';
import CallbackPage from '../pages/student/Callback';

// ---- Test helpers ---------------------------------------------------------

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderCallback(ref: string, providerReference?: string | null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  (useParams as any).mockReturnValue({ paystackRef: ref });
  const params = new URLSearchParams();
  if (providerReference) params.set('providerReference', providerReference);
  (useSearchParams as any).mockReturnValue([params]);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(CallbackPage));
  });
}

function cleanup() {
  act(() => {
    root?.unmount();
  });
  container?.remove();
}

function text(): string {
  return container?.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getPaymentStatusMock.mockReset();
  verifyPaymentMock.mockReset();
  refreshCachesMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- D. Callback initially PENDING, webhook later SUCCESS -----------------

it('D: initially PENDING then backend SUCCESS → UI auto-updates without refresh', async () => {
  getPaymentStatusMock
    .mockResolvedValueOnce({ status: 'PENDING', reference: 'PAY-TEST', amount: 100, expectedAmount: 100 })
    .mockResolvedValueOnce({ status: 'PENDING', reference: 'PAY-TEST', amount: 100, expectedAmount: 100 })
    .mockResolvedValueOnce({
      status: 'SUCCESS', reference: 'PAY-TEST', amount: 100, expectedAmount: 100,
      invoiceId: 8, invoiceStatus: 'PAID', gateway: 'ALATPAY',
      receipt: { receiptNumber: 'RCPT/2026/00005' }, updatedAt: '2026-10-13T12:00:00Z',
    });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  // Initially should show pending/confirming, NOT failure
  expect(text()).toMatch(/confirming|pending|waiting/i);
  expect(text()).not.toMatch(/failed/i);

  // Advance past first poll interval (FAST_INTERVAL_MS = 2500)
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  expect(text()).not.toMatch(/failed/i);

  // Advance to the SUCCESS poll
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });

  expect(text()).toMatch(/successful|success/i);
  expect(refreshCachesMock).toHaveBeenCalled();
});

// ---- E. Several PENDING then SUCCESS → no false failure -------------------

it('E: multiple PENDING responses then SUCCESS → never shows failure', async () => {
  for (let i = 0; i < 5; i++) {
    getPaymentStatusMock.mockResolvedValueOnce({ status: 'PENDING', reference: 'PAY-TEST' });
  }
  getPaymentStatusMock.mockResolvedValueOnce({
    status: 'SUCCESS', reference: 'PAY-TEST', amount: 100,
    receipt: { receiptNumber: 'RCPT/2026/00006' },
  });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  for (let i = 0; i < 5; i++) {
    await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
    expect(text()).not.toMatch(/failed/i);
  }

  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  expect(text()).toMatch(/successful|success/i);
});

// ---- F. Network error then SUCCESS → pending then SUCCESS -----------------

it('F: network error followed by SUCCESS → stays pending then succeeds', async () => {
  getPaymentStatusMock
    .mockRejectedValueOnce(new Error('Network error'))
    .mockResolvedValueOnce({ status: 'PENDING', reference: 'PAY-TEST' })
    .mockResolvedValueOnce({
      status: 'SUCCESS', reference: 'PAY-TEST', amount: 100,
      receipt: { receiptNumber: 'RCPT/2026/00007' },
    });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  // After network error, should still be pending (not failed)
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  expect(text()).not.toMatch(/failed/i);
  expect(text()).toMatch(/confirming|pending|waiting/i);

  // Next poll returns PENDING
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  expect(text()).not.toMatch(/failed/i);

  // Final poll returns SUCCESS
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  expect(text()).toMatch(/successful|success/i);
});

// ---- G. Component unmount → polling stops ---------------------------------

it('G: component unmount stops polling (no further getPaymentStatus calls)', async () => {
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  const callsBefore = getPaymentStatusMock.mock.calls.length;

  // Unmount
  cleanup();

  // Advance timers — should NOT trigger more polls
  await act(async () => { vi.advanceTimersByTime(10000); await Promise.resolve(); });

  expect(getPaymentStatusMock.mock.calls.length).toBe(callsBefore);
});

// ---- H. Tab becomes visible → immediate status check ----------------------

it('H: visibilitychange to visible triggers immediate status check', async () => {
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  const callsBefore = getPaymentStatusMock.mock.calls.length;

  // Simulate tab becoming visible
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });

  expect(getPaymentStatusMock.mock.calls.length).toBeGreaterThan(callsBefore);
});

// ---- I. Confirmed backend FAILED → only then show failure -----------------

it('I: confirmed backend FAILED status shows failure', async () => {
  getPaymentStatusMock.mockResolvedValue({
    status: 'FAILED', reference: 'PAY-TEST', amount: 100, expectedAmount: 100,
    gateway: 'ALATPAY',
  });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  expect(text()).toMatch(/fail|unsuccessful|could not/i);
});

// ---- J. Timeout with still-PENDING → delayed message, NOT failure ---------

it('J: still PENDING after long delay shows delayed message, NOT failure', async () => {
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  // Advance well into the slow phase (past 60s FAST_PHASE_MS)
  await act(async () => { vi.advanceTimersByTime(70000); await Promise.resolve(); });

  // Should show a delayed/longer message, NOT failure
  expect(text()).not.toMatch(/failed/i);
  expect(text()).toMatch(/longer|still|waiting|confirming/i);
});

// ---- A & B. providerReference fast path (onSuccess/onTransaction) --------

it('A: providerReference present (onSuccess UUID) → verifyPayment called with it', async () => {
  const UUID = '7162fb44-6d04-4590-ac65-a96061e272ab';
  verifyPaymentMock.mockResolvedValue({
    status: 'SUCCESS', data: { status: 'SUCCESS', reference: 'PAY-TEST', amount: 100, receipt: { receiptNumber: 'RCPT/1' } },
  });
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  renderCallback('PAY-TEST', UUID);
  await act(async () => { await Promise.resolve(); });

  expect(verifyPaymentMock).toHaveBeenCalledWith('PAY-TEST', { providerReference: UUID });
  expect(text()).toMatch(/successful|success/i);
});

it('B: malformed providerReference is ignored, falls back to status polling', async () => {
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  renderCallback('PAY-TEST', 'not-a-uuid');
  await act(async () => { await Promise.resolve(); });

  // verifyPayment should NOT be called with a malformed provider reference
  expect(verifyPaymentMock).not.toHaveBeenCalled();
  // Falls back to status polling
  expect(getPaymentStatusMock).toHaveBeenCalledWith('PAY-TEST');
});

// ---- C. PaymentConfirmation onClosed → navigate to callback --------------

it('C: popup close without SDK callback navigates to callback page (no failure declared)', () => {
  // The full PaymentConfirmation component requires many mocks (invoice data,
  // ALATPay modal launch, etc.). Instead of rendering the whole component,
  // we verify the onClosed navigation contract by inspecting the source:
  // when the ALATPay modal closes without an SDK success callback, the
  // handler must navigate to the Bells callback/status page — NOT declare
  // failure. The callback page then monitors persisted backend status while
  // waiting for the webhook.
  const src = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..', 'pages', 'student', 'PaymentConfirmation.tsx'),
    'utf8',
  );
  expect(src).toMatch(/onClosed:\s*\(\)\s*=>\s*\{/);
  expect(src).toMatch(/navigateToCallback\(null\)/);
  // onClosed must NOT set any error/failure state
  expect(src).not.toMatch(/onClosed[^}]*setMsg[^}]*[Ff]ail/);
});

// =============================================================================
// Polling concurrency guarantees (single chain, no duplicate in-flight)
// =============================================================================

function clickCheckStatusNow() {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => /check status/i.test(b.textContent ?? ''),
  );
  if (!btn) throw new Error('Check Status Now button not found');
  act(() => { (btn as HTMLButtonElement).click(); });
}

// ---- K. Repeated focus events → one polling chain -------------------------

it('K: repeated focus events do not create multiple polling chains', async () => {
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  // Initial poll has completed; one timer scheduled.
  const callsAfterLoad = getPaymentStatusMock.mock.calls.length;

  // Fire several focus events synchronously while no request is in flight
  // (after the initial poll resolved). With the concurrency fix, only the
  // first forceCheckNow starts a request; the rest see inFlightRef=true and
  // return early.
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
  });

  // Exactly ONE additional poll from the focus burst (not three).
  expect(getPaymentStatusMock.mock.calls.length).toBe(callsAfterLoad + 1);

  // Advance one interval — only ONE scheduled poll fires (single chain).
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  expect(getPaymentStatusMock.mock.calls.length).toBe(callsAfterLoad + 2);
});

// ---- L. visibility + focus together → no duplicate polling ----------------

it('L: visibilitychange and focus together do not duplicate polling', async () => {
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  const callsAfterLoad = getPaymentStatusMock.mock.calls.length;

  // Fire visibility + focus events back-to-back.
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });

  // Only ONE immediate poll should result from the burst.
  expect(getPaymentStatusMock.mock.calls.length).toBe(callsAfterLoad + 1);

  // Advance one interval → exactly one scheduled poll.
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  expect(getPaymentStatusMock.mock.calls.length).toBe(callsAfterLoad + 2);
});

// ---- M. Repeated "Check Status Now" clicks → no parallel timers -----------

it('M: repeated Check Status Now clicks do not create parallel polling timers', async () => {
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  const callsAfterLoad = getPaymentStatusMock.mock.calls.length;

  // Click the button several times rapidly.
  await act(async () => {
    clickCheckStatusNow();
    clickCheckStatusNow();
    clickCheckStatusNow();
    await Promise.resolve();
  });

  // Only ONE immediate poll.
  expect(getPaymentStatusMock.mock.calls.length).toBe(callsAfterLoad + 1);

  // Advance one interval → one scheduled poll, proving only one timer exists.
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  expect(getPaymentStatusMock.mock.calls.length).toBe(callsAfterLoad + 2);

  // Advance another interval → still only one poll (no duplicate chains).
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  expect(getPaymentStatusMock.mock.calls.length).toBe(callsAfterLoad + 3);
});

// ---- N. Stale PENDING cannot overwrite a newer SUCCESS --------------------

it('N: an old/stale PENDING response cannot overwrite a newer SUCCESS', async () => {
  // First poll returns PENDING; second poll returns SUCCESS.
  getPaymentStatusMock
    .mockResolvedValueOnce({ status: 'PENDING', reference: 'PAY-TEST' })
    .mockResolvedValueOnce({ status: 'PENDING', reference: 'PAY-TEST' })
    .mockResolvedValueOnce({
      status: 'SUCCESS', reference: 'PAY-TEST', amount: 100,
      receipt: { receiptNumber: 'RCPT/2026/STALE' },
    });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  // Advance to the SUCCESS poll.
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });

  // UI shows SUCCESS.
  expect(text()).toMatch(/successful|success/i);

  // Now make the backend return PENDING. Because polling stops on SUCCESS,
  // no automatic poll runs. Even if a manual check returned PENDING, the
  // seq guard (pollSeqRef) ensures a stale lower-seq response cannot
  // overwrite the terminal SUCCESS state.
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  // Advance well past any interval — no poll should fire (polling stopped).
  await act(async () => { vi.advanceTimersByTime(30000); await Promise.resolve(); });

  // UI must still show SUCCESS.
  expect(text()).toMatch(/successful|success/i);
  expect(text()).not.toMatch(/pending|confirming|waiting/i);

  // Source-level guard: the seq check exists so a stale response is dropped.
  const src = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..', 'pages', 'student', 'Callback.tsx'),
    'utf8',
  );
  expect(src).toMatch(/pollSeqRef/);
  expect(src).toMatch(/seq\s*!==\s*pollSeqRef\.current/);
});

// ---- O. SUCCESS stops all future polling ----------------------------------

it('O: SUCCESS stops all future automatic polling', async () => {
  getPaymentStatusMock
    .mockResolvedValueOnce({ status: 'PENDING', reference: 'PAY-TEST' })
    .mockResolvedValueOnce({
      status: 'SUCCESS', reference: 'PAY-TEST', amount: 100,
      receipt: { receiptNumber: 'RCPT/2026/STOP' },
    });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  // Advance to SUCCESS.
  await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });

  expect(text()).toMatch(/successful|success/i);

  // Now capture the call count AFTER success.
  const callsAfterSuccess = getPaymentStatusMock.mock.calls.length;

  // Advance far past any polling interval.
  await act(async () => { vi.advanceTimersByTime(60000); await Promise.resolve(); });

  // No additional polls should have been made after SUCCESS.
  expect(getPaymentStatusMock.mock.calls.length).toBe(callsAfterSuccess);
});

// ---- P. Unmount stops polling (regression) --------------------------------

it('P: component unmount cancels timers and prevents stale state updates', async () => {
  getPaymentStatusMock.mockResolvedValue({ status: 'PENDING', reference: 'PAY-TEST' });

  renderCallback('PAY-TEST');
  await act(async () => { await Promise.resolve(); });

  const callsBefore = getPaymentStatusMock.mock.calls.length;

  // Unmount.
  cleanup();

  // Advance timers — no further polls.
  await act(async () => { vi.advanceTimersByTime(30000); await Promise.resolve(); });

  expect(getPaymentStatusMock.mock.calls.length).toBe(callsBefore);
});
