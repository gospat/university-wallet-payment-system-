/**
 * BURSARY DASHBOARD — data-consistency + availability contract
 * =============================================================================
 * Production defect this suite locks down: for ONE selected date range the
 * Collections-over-time trend and the Collections-by-category breakdown agreed
 * (₦700 / 6 transactions) while the summary KPIs rendered ₦0.00 / 0 / empty.
 *
 * Cause: the summary request failed server-side (an Invalid Date was built by
 * concatenating a suffix onto an already-coerced Date) and the page swallowed
 * the rejection, leaving `summary = {}` and rendering legitimate-looking zeroes.
 *
 * Proved here:
 *   • a FAILED summary request renders an explicit "Dashboard unavailable"
 *     surface and NEVER a ₦0.00 / 0-transaction KPI grid;
 *   • the recent-transactions table reports "unavailable" rather than "empty";
 *   • every dashboard request is issued with date-only Lagos business dates —
 *     no `T23:59:59` suffix is ever appended by the client;
 *   • a successful non-zero summary renders the same total as the trend and the
 *     category breakdown.
 *
 * NOTE: this is a pure-frontend contract. The API owns the business-day window.
 */

import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/bursary/dashboard', search: '' }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: any) => React.createElement('a', { href: to }, children),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      firstName: 'Bursary',
      lastName: 'User',
      email: 'bursary@uni.edu.ng',
      permissions: [],
    },
    logout: vi.fn(),
  }),
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

vi.mock('../components/Modal', () => ({
  default: ({ isOpen, children, title }: any) =>
    isOpen
      ? React.createElement(
          'div',
          { 'data-testid': 'modal' },
          React.createElement('div', { 'data-testid': 'modal-title' }, title),
          children,
        )
      : null,
}));

vi.mock('lucide-react', () => {
  const icons = [
    'ShieldCheck', 'Mail', 'History', 'Banknote', 'Users', 'TrendingUp', 'BarChart3',
    'Download', 'FileText', 'CalendarDays', 'ArrowUpRight', 'Layers', 'CircleDollarSign',
    'GraduationCap', 'Receipt', 'CheckCircle2', 'Percent', 'ListChecks', 'AlertTriangle',
    'RefreshCw',
  ];
  const out: any = {};
  icons.forEach((n) => { out[n] = () => null; });
  return out;
});

const apiGetMock = vi.fn();
const navCountersMock = vi.fn();

vi.mock('../services/api', () => ({
  __esModule: true,
  default: { get: (...args: any[]) => apiGetMock(...args) },
  navCounters: (...args: any[]) => navCountersMock(...args),
}));

import BursaryDashboard from '../pages/bursary/Dashboard';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(BursaryDashboard));
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

function cleanup() {
  act(() => { root?.unmount(); });
  container?.remove();
}

function text() {
  return container.textContent || '';
}

function findBtn(label: string) {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent || '').includes(label),
  );
}

// --- fixtures ----------------------------------------------------------------

/**
 * One canonical population: ₦700 across 6 successful FEE_PAYMENT transactions
 * (4 × ₦125 + 2 × ₦100) for 2 unique students. Exactly the shape the production
 * screenshot showed in trend + by-category but not in the summary KPIs.
 */
const SUMMARY_OK = {
  cards: {
    totalCollected: 700,
    totalRevenue: 700,
    totalRevenueTransactions: 6,
    transactionsCount: 6,
    receiptsIssued: 6,
    uniquePayingStudents: 2,
    averageTransaction: 700 / 6,
    totalStudents: 1234,
    feesPublishedCount: 12,
  },
  recentTransactions: [
    {
      id: 1,
      reference: 'PAY-END-OF-DAY',
      amount: 125,
      type: 'FEE_PAYMENT',
      createdAt: '2026-10-15T21:30:00.000Z',
      student: { name: 'Ada Obi', matricNumber: 'MAT/2026/001' },
      invoice: { feeName: 'Tuition', invoiceNumber: 'INV-1' },
    },
  ],
};

const TREND_OK = {
  unit: 'day',
  total: 700,
  totalCount: 6,
  buckets: [{ label: '2026-10-15', value: 700, count: 6, date: '2026-10-15' }],
};

const CATEGORY_OK = {
  grandTotal: 700,
  rows: [
    { id: 11, name: 'Tuition', code: 'TUI', total: 700, count: 6 },
  ],
};

/**
 * Route the mocked API client by endpoint. Summary/trend/by-category are
 * independent requests — exactly what let the production defect hide.
 */
function routeApi(overrides: { summary?: any; trend?: any; category?: any } = {}) {
  const plan = {
    summary: overrides.summary ?? SUMMARY_OK,
    trend: overrides.trend ?? TREND_OK,
    category: overrides.category ?? CATEGORY_OK,
  };
  apiGetMock.mockImplementation((url: string) => {
    const resolve = (payload: any) => Promise.resolve({ data: { data: payload } });
    if (url.includes('/bursary/dashboard/summary')) {
      return plan.summary instanceof Error ? Promise.reject(plan.summary) : resolve(plan.summary);
    }
    if (url.includes('/bursary/dashboard/trend')) {
      return plan.trend instanceof Error ? Promise.reject(plan.trend) : resolve(plan.trend);
    }
    if (url.includes('/bursary/dashboard/by-category')) {
      return plan.category instanceof Error ? Promise.reject(plan.category) : resolve(plan.category);
    }
    return Promise.resolve({ data: { data: {} } });
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
  navCountersMock.mockReset();
  navCountersMock.mockResolvedValue({});
  routeApi();
});

afterEach(() => {
  cleanup();
});

describe('Bursary dashboard — failed summary must never look like ₦0.00', () => {
  it('renders an explicit Dashboard-unavailable state and no zero KPI grid', async () => {
    routeApi({ summary: new Error('Request failed with status code 500') });
    render();
    await flush();

    const banner = container.querySelector('[data-testid="bursary-dashboard-error"]');
    expect(banner).toBeTruthy();
    expect(text()).toContain('Dashboard unavailable');
    expect(text()).toContain('Request failed with status code 500');

    // The KPI grid (Total Collected / Paying Students / Avg Transaction …) must
    // be suppressed — otherwise a failed request reads as legitimate ₦0.00.
    expect(text()).not.toContain('Avg Transaction');
    expect(text()).not.toContain('Paying Students');
    expect(text()).not.toContain('0 successful transactions');

    // Trend + category still loaded (they agree), and the failure is surfaced.
    expect(text()).toContain('Recent transactions unavailable');
    expect(text()).not.toContain('No recent fee payments');
  });

  it('re-issues every dashboard request when Retry is pressed', async () => {
    routeApi({ summary: new Error('boom') });
    render();
    await flush();

    const before = apiGetMock.mock.calls.length;
    const retry = findBtn('Retry');
    expect(retry).toBeTruthy();
    act(() => { retry!.click(); });
    await flush();
    expect(apiGetMock.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('Bursary dashboard — one consistent window for summary / trend / category', () => {
  it('sends date-only Lagos business dates to every endpoint (no T23:59:59 suffix)', async () => {
    render();
    await flush();

    const urls = apiGetMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/bursary/dashboard/summary'))).toBe(true);
    expect(urls.some((u) => u.includes('/bursary/dashboard/trend'))).toBe(true);
    expect(urls.some((u) => u.includes('/bursary/dashboard/by-category'))).toBe(true);

    for (const u of urls) {
      // The API owns the business-day window. The client must not append a time.
      expect(u).not.toContain('T23:59:59');
      expect(u).not.toContain('T23%3A59%3A59');
      expect(u).not.toContain('23%3A59');
    }

    // Summary + by-category carry BOTH bounds as plain YYYY-MM-DD values.
    for (const base of ['/bursary/dashboard/summary', '/bursary/dashboard/by-category']) {
      const url = urls.find((u) => u.startsWith(base))!;
      expect(url).toMatch(/dateFrom=\d{4}-\d{2}-\d{2}/);
      expect(url).toMatch(/dateTo=\d{4}-\d{2}-\d{2}/);
    }
  });

  it('renders a non-zero range consistently across summary, trend and category', async () => {
    render();
    await flush();

    const t = text();
    // Summary KPIs.
    expect(t).toContain('6 successful transactions');
    expect(t).toContain('Paying Students');
    // Average transaction = totalCollected / successfulTransactionCount.
    expect(t).toContain('₦116.67');
    // Trend + category agree with the summary on ₦700 (KPI, trend total, grand).
    expect(t.split('₦700.00').length - 1).toBeGreaterThanOrEqual(3);
    // Recent transactions come from the same population/window.
    expect(t).toContain('Ada Obi');
    expect(t).toContain('PAY-END-OF-DAY');
  });
});
