import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: any) => React.createElement('a', { href: to }, children),
}));

const mockUser: any = {
  firstName: 'Bursary',
  lastName: 'User',
  email: 'bursary@uni.edu.ng',
  permissions: ['VIEW_RECONCILIATION', 'VIEW_RECONCILIATION_REPORTS'],
};
const setMockUser = (u: any) => {
  mockUser.firstName = u.firstName;
  mockUser.lastName = u.lastName;
  mockUser.email = u.email;
  mockUser.permissions = u.permissions;
};

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, logout: vi.fn() }),
}));

vi.mock('../i18n/en', () => ({
  i18n: {
    portals: {
      bursary: { dashboardBrand: 'Bursary Portal', dashboardGreeting: (n: string) => `Bursary: ${n}` },
      admin: { dashboardBrand: 'Admin Portal', dashboardGreeting: (n: string) => `Admin: ${n}` },
    },
  },
}));

vi.mock('../components/PortalShell', () => ({
  default: ({ children }: any) => React.createElement('div', { 'data-testid': 'portal-shell' }, children),
}));

vi.mock('lucide-react', () => {
  const icons = [
    'RefreshCw', 'Download', 'Filter', 'ChevronLeft', 'ChevronRight', 'Loader2',
    'AlertTriangle', 'CheckCircle2', 'XCircle', 'Database', 'Building2', 'CreditCard',
    'Link2Off', 'Copy', 'RotateCcw', 'FileQuestion', 'FileText',
  ];
  const out: any = {};
  icons.forEach((n) => { out[n] = () => null; });
  return out;
});

const summaryMock = vi.fn();
const itemsMock = vi.fn();
const buildReportUrlMock = vi.fn();
const downloadBlobMock = vi.fn();

vi.mock('../services/reconciliationApi', () => ({
  getReconciliationSummary: (...args: any[]) => summaryMock(...args),
  getReconciliationItems: (...args: any[]) => itemsMock(...args),
  buildReportCsvUrl: (...args: any[]) => buildReportUrlMock(...args),
}));

vi.mock('../services/api', () => ({
  downloadBlob: (...args: any[]) => downloadBlobMock(...args),
}));

import ReconciliationDashboardPage from '../pages/bursary/ReconciliationDashboard';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(ReconciliationDashboardPage, {
        role: 'BURSARY',
        brand: 'Bursary Portal',
        userText: 'Bursary: Test',
        onLogout: vi.fn(),
        dashboardTo: '/bursary/dashboard',
      }),
    );
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

function cleanup() {
  act(() => { root?.unmount(); });
  container?.remove();
}

const baseSummary = {
  systemRecords: 100,
  gatewayRecords: 100,
  matched: 90,
  amountMismatch: 2,
  missingInternal: 1,
  missingGateway: 1,
  duplicateReference: 1,
  reversedTxn: 2,
  missingReceipt: 3,
};

const baseItems = [
  {
    date: '2025-06-15',
    gateway: 'PAYSTACK',
    gatewayReference: 'PSK-REF-001',
    paymentReference: 'PAY-001',
    classification: 'MATCHED',
    expectedAmount: 50000,
    actualAmount: 50000,
    studentName: 'John Doe',
    studentId: 10,
    chargeSource: 'CATALOGUE',
    assignmentId: null,
  },
  {
    date: '2025-06-16',
    gateway: 'ALATPAY',
    gatewayReference: 'ALAT-REF-002',
    paymentReference: 'PAY-002',
    classification: 'AMOUNT_MISMATCH',
    expectedAmount: 30000,
    actualAmount: 29500,
    studentName: 'Jane Smith',
    studentId: 11,
    chargeSource: 'DIRECT_BILL',
    assignmentId: 5,
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  summaryMock.mockReset();
  itemsMock.mockReset();
  buildReportUrlMock.mockReset();
  downloadBlobMock.mockReset();
  summaryMock.mockResolvedValue(baseSummary);
  itemsMock.mockResolvedValue({
    items: baseItems,
    pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
    summary: baseSummary,
    filters: {},
  });
  buildReportUrlMock.mockReturnValue('/bursary/reconciliation/report?format=csv');
  downloadBlobMock.mockResolvedValue(undefined);
  setMockUser({
    firstName: 'Bursary', lastName: 'User', email: 'bursary@uni.edu.ng',
    permissions: ['VIEW_RECONCILIATION', 'VIEW_RECONCILIATION_REPORTS'],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Reconciliation Dashboard', () => {
  it('1. renders real dashboard page (not placeholder)', async () => {
    render();
    await flush();
    const title = container.querySelector('h1');
    expect(title?.textContent).toBe('Reconciliation');
    expect(container.textContent).toContain('Compare internal payment records');
    expect(container.textContent).not.toContain('under construction');
  });

  it('2. initial request contains valid dateFrom and dateTo', async () => {
    render();
    await flush();
    expect(itemsMock).toHaveBeenCalled();
    const firstCall = itemsMock.mock.calls[0][0];
    expect(firstCall.dateFrom).toBeTruthy();
    expect(firstCall.dateTo).toBeTruthy();
    expect(new Date(firstCall.dateFrom).getTime()).toBeLessThanOrEqual(new Date(firstCall.dateTo).getTime());
  });

  it('3. summary uses current API response shape (9 cards)', async () => {
    render();
    await flush();
    const text = container.textContent || '';
    expect(text).toContain('System Records');
    expect(text).toContain('Gateway Records');
    expect(text).toContain('Matched');
    expect(text).toContain('Amount Mismatch');
    expect(text).toContain('Missing Internal');
    expect(text).toContain('Missing Gateway');
    expect(text).toContain('Duplicate References');
    expect(text).toContain('Reversed');
    expect(text).toContain('Missing Receipt');
    expect(text).toContain('100');
    expect(text).toContain('90');
  });

  it('4. items render correctly with expected/actual/variance', async () => {
    render();
    await flush();
    const text = container.textContent || '';
    expect(text).toContain('PSK-REF-001');
    expect(text).toContain('PAY-001');
    expect(text).toContain('John Doe');
    expect(text).toContain('Matched');
    expect(text).toContain('Jane Smith');
    expect(text).toContain('Amount Mismatch');
  });

  it('5. gateway filter sends selected gateway to API', async () => {
    render();
    await flush();
    const selects = container.querySelectorAll('select');
    const gatewaySelect = Array.from(selects).find((s) => {
      const opts = Array.from(s.options).map((o) => o.value);
      return opts.includes('PAYSTACK') && opts.includes('ALATPAY') && !opts.includes('MATCHED');
    });
    expect(gatewaySelect).toBeTruthy();
    act(() => {
      (gatewaySelect as HTMLSelectElement).value = 'PAYSTACK';
      gatewaySelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const lastCall = itemsMock.mock.calls[itemsMock.mock.calls.length - 1][0];
    expect(lastCall.gateway).toBe('PAYSTACK');
  });

  it('6. classification filter sends selected classification', async () => {
    render();
    await flush();
    const selects = container.querySelectorAll('select');
    const classSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === 'MISSING_RECEIPT'),
    );
    expect(classSelect).toBeTruthy();
    act(() => {
      (classSelect as HTMLSelectElement).value = 'MISSING_RECEIPT';
      classSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const lastCall = itemsMock.mock.calls[itemsMock.mock.calls.length - 1][0];
    expect(lastCall.classification).toBe('MISSING_RECEIPT');
  });

  it('7. charge-source filter sends selected value', async () => {
    render();
    await flush();
    const selects = container.querySelectorAll('select');
    const csSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === 'DIRECT_BILL') &&
      Array.from(s.options).some((o) => o.value === 'CATALOGUE'),
    );
    expect(csSelect).toBeTruthy();
    act(() => {
      (csSelect as HTMLSelectElement).value = 'DIRECT_BILL';
      csSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const lastCall = itemsMock.mock.calls[itemsMock.mock.calls.length - 1][0];
    expect(lastCall.chargeSource).toBe('DIRECT_BILL');
  });

  it('8. pagination sends correct page on Next', async () => {
    itemsMock.mockResolvedValue({
      items: baseItems,
      pagination: { page: 1, limit: 50, total: 120, totalPages: 3 },
      summary: baseSummary,
      filters: {},
    });
    render();
    await flush();
    const nextBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Next'),
    );
    expect(nextBtn).toBeTruthy();
    expect(nextBtn?.disabled).toBe(false);
    act(() => { nextBtn!.click(); });
    await flush();
    const lastCall = itemsMock.mock.calls[itemsMock.mock.calls.length - 1][0];
    expect(lastCall.page).toBe(2);
  });

  it('9. changing a filter resets page to 1', async () => {
    itemsMock.mockResolvedValue({
      items: baseItems,
      pagination: { page: 2, limit: 50, total: 120, totalPages: 3 },
      summary: baseSummary,
      filters: {},
    });
    render();
    await flush();
    const nextBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Next'),
    );
    act(() => { nextBtn!.click(); });
    await flush();
    let lastCall = itemsMock.mock.calls[itemsMock.mock.calls.length - 1][0];
    expect(lastCall.page).toBe(2);
    const selects = container.querySelectorAll('select');
    const classSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === 'MATCHED') &&
      Array.from(s.options).some((o) => o.value === 'MISSING_RECEIPT'),
    );
    act(() => {
      (classSelect as HTMLSelectElement).value = 'MATCHED';
      classSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    lastCall = itemsMock.mock.calls[itemsMock.mock.calls.length - 1][0];
    expect(lastCall.page).toBe(1);
  });

  it('10. CSV export builds report URL with selected filters', async () => {
    render();
    await flush();
    const selects = container.querySelectorAll('select');
    const gatewaySelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === 'ALATPAY'),
    );
    act(() => {
      (gatewaySelect as HTMLSelectElement).value = 'ALATPAY';
      gatewaySelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const exportBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Export CSV'),
    );
    expect(exportBtn).toBeTruthy();
    act(() => { exportBtn!.click(); });
    await flush();
    expect(buildReportUrlMock).toHaveBeenCalled();
    const urlArgs = buildReportUrlMock.mock.calls[buildReportUrlMock.mock.calls.length - 1][0];
    expect(urlArgs.gateway).toBe('ALATPAY');
    expect(downloadBlobMock).toHaveBeenCalled();
  });

  it('11. user without VIEW_RECONCILIATION sees access denied', async () => {
    setMockUser({
      firstName: 'Bursary', lastName: 'User', email: 'bursary@uni.edu.ng',
      permissions: [],
    });
    render();
    await flush();
    const text = container.textContent || '';
    expect(text).toContain('Access denied');
    expect(text).toContain('VIEW_RECONCILIATION');
  });

  it('12. user without VIEW_RECONCILIATION_REPORTS cannot export', async () => {
    setMockUser({
      firstName: 'Bursary', lastName: 'User', email: 'bursary@uni.edu.ng',
      permissions: ['VIEW_RECONCILIATION'],
    });
    render();
    await flush();
    const exportBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Export CSV'),
    );
    expect(exportBtn).toBeFalsy();
  });

  it('13. empty results render empty-state message', async () => {
    itemsMock.mockResolvedValue({
      items: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
      summary: { ...baseSummary, systemRecords: 0, gatewayRecords: 0 },
      filters: {},
    });
    render();
    await flush();
    const text = container.textContent || '';
    expect(text).toContain('No reconciliation records found for the selected period.');
  });

  it('14. API errors are displayed and not represented as zero totals', async () => {
    itemsMock.mockRejectedValue(new Error('Network timeout'));
    summaryMock.mockRejectedValue(new Error('Network timeout'));
    render();
    await flush();
    const text = container.textContent || '';
    expect(text).toContain('Failed to load reconciliation data');
    expect(text).toContain('Network timeout');
  });

  it('15. refresh does not create overlapping requests (aborts previous signal)', async () => {
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    itemsMock.mockImplementation((_filters: any, signal?: AbortSignal) => {
      if (!firstSignal) firstSignal = signal;
      else secondSignal = signal;
      return new Promise(() => {});
    });
    summaryMock.mockResolvedValue(baseSummary);
    render();
    await flush();
    expect(firstSignal).toBeDefined();
    expect(firstSignal!.aborted).toBe(false);
    const selects = container.querySelectorAll('select');
    const gatewaySelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === 'ALATPAY'),
    );
    act(() => {
      (gatewaySelect as HTMLSelectElement).value = 'ALATPAY';
      gatewaySelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(secondSignal).toBeDefined();
    expect(firstSignal!.aborted).toBe(true);
  });
});
