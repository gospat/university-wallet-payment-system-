/**
 * RBAC FOLLOW-UP — Reports Centre granular report permissions + collection-summary
 * containment. Proves:
 *   B. Reports Centre renders for a BURSARY session with REPORTS_VIEW_REVENUE and
 *      NO REPORTS_VIEW_COLLECTIONS, showing ONLY the permitted reports.
 *   C. Same for REPORTS_VIEW_ACCOUNTING.
 *   D. A BURSARY session with no report-view key sees no reports.
 *   E. GET /reports/dashboard-summary is NOT requested (and no collection summary
 *      is rendered) when REPORTS_VIEW_COLLECTIONS is absent — the page still works.
 *   A. The Student Statement quick link honours REPORTS_VIEW_STUDENT_STATEMENT and
 *      is NOT unlocked by REPORTS_VIEW_COLLECTIONS.
 *
 * Backend protection on /reports/dashboard-summary is intentionally left intact;
 * the page simply never asks for data the session may not view.
 */

import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

let currentUser: any = null;

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/bursary/reports/centre', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
  Navigate: ({ to }: any) => React.createElement('div', { 'data-testid': 'navigate' }, String(to)),
  Outlet: () => React.createElement('div', { 'data-testid': 'outlet' }),
  Link: ({ children, to, ...rest }: any) => React.createElement('a', { href: to, ...rest }, children),
  MemoryRouter: ({ children }: any) => children,
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: currentUser,
    isAuthenticated: !!currentUser,
    isValidating: false,
    logout: vi.fn(),
    refetchUser: vi.fn(),
  }),
  AuthProvider: ({ children }: any) => children,
}));

// Render the page body only — sidebar visibility is covered by the mapping suite.
vi.mock('../components/PortalShell', () => ({
  default: ({ children }: any) => React.createElement('div', { 'data-testid': 'portal-shell' }, children),
}));

vi.mock('../services/api', () => ({
  __esModule: true,
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  navCounters: vi.fn().mockResolvedValue({}),
}));

const getDashboardSummaryMock = vi.fn().mockResolvedValue({ cards: {} });
const getReconciliationExceptionsMock = vi.fn().mockResolvedValue({ totalCount: 0 });

vi.mock('../services/reportsApi', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getDashboardSummary: (...a: any[]) => getDashboardSummaryMock(...a),
    getReconciliationExceptions: (...a: any[]) => getReconciliationExceptionsMock(...a),
  };
});

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const out: Record<string, any> = {};
  for (const key of Object.keys(actual)) {
    if (key === 'default' || key === '__esModule') continue;
    out[key] = () => null;
  }
  return out;
});

import ReportsCentre from '../pages/bursary/ReportsCentre';

const u = (role: 'ADMIN' | 'BURSARY', permissions: string[]) =>
  ({ id: 1, email: 't@u.ng', firstName: 'T', lastName: 'U', role, permissions } as any);

// ---------------------------------------------------------------------------
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const flush = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const renderCentre = async (permissions: string[]) => {
  currentUser = u('BURSARY', permissions);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ReportsCentre role="BURSARY" activePath="/bursary/reports/centre" />);
  });
  await flush();
};

const hrefPrefix = (p: string) => container.querySelector(`a[href^="${p}"]`);

beforeEach(() => {
  currentUser = null;
  getDashboardSummaryMock.mockClear();
  getReconciliationExceptionsMock.mockClear();
  getDashboardSummaryMock.mockResolvedValue({ cards: {} });
  getReconciliationExceptionsMock.mockResolvedValue({ totalCount: 0 });
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
});

// ===========================================================================
describe('B. Reports Centre with REPORTS_VIEW_REVENUE (no COLLECTIONS)', () => {
  it('renders, shows revenue reports and hides collections reports', async () => {
    await renderCentre(['REPORTS_VIEW_REVENUE']);

    expect(container.textContent).not.toContain('Access Denied');
    // permitted (Revenue group)
    expect(hrefPrefix('/bursary/reports/view/revenue-by-bill')).toBeTruthy();
    expect(hrefPrefix('/bursary/reports/view/hierarchical-revenue')).toBeTruthy();
    // not permitted (Collections group)
    expect(hrefPrefix('/bursary/reports/view/daily-collections')).toBeNull();
    expect(hrefPrefix('/bursary/reports/view/payment-register')).toBeNull();
  });
});

// ===========================================================================
describe('C. Reports Centre with REPORTS_VIEW_ACCOUNTING (no COLLECTIONS)', () => {
  it('renders, shows accounting reports and hides collections reports', async () => {
    await renderCentre(['REPORTS_VIEW_ACCOUNTING']);

    expect(container.textContent).not.toContain('Access Denied');
    expect(hrefPrefix('/bursary/reports/view/charges-fee-income')).toBeTruthy();
    expect(hrefPrefix('/bursary/reports/view/general-ledger')).toBeTruthy();
    expect(hrefPrefix('/bursary/reports/view/daily-collections')).toBeNull();
  });
});

// ===========================================================================
describe('D. Reports Centre with no report-view permission', () => {
  it('shows no reports at all', async () => {
    await renderCentre([]);

    expect(container.textContent).toContain('No reports available');
    expect(hrefPrefix('/bursary/reports/view/')).toBeNull();
    expect(getDashboardSummaryMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe('E. Collection summary is never fetched or rendered without REPORTS_VIEW_COLLECTIONS', () => {
  it('does NOT call getDashboardSummary for a REVENUE-only session and shows no summary cards', async () => {
    await renderCentre(['REPORTS_VIEW_REVENUE']);

    expect(getDashboardSummaryMock).not.toHaveBeenCalled();
    // The collection-summary section is not rendered at all.
    expect(container.textContent).not.toContain('Summary Cards');
    // ...and the page is NOT reported as failed.
    expect(container.textContent).not.toContain('Failed to load summary cards');
  });

  it('does NOT call getDashboardSummary for an ACCOUNTING-only session', async () => {
    await renderCentre(['REPORTS_VIEW_ACCOUNTING']);
    expect(getDashboardSummaryMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Summary Cards');
  });

  it('DOES call getDashboardSummary when REPORTS_VIEW_COLLECTIONS is present', async () => {
    await renderCentre(['REPORTS_VIEW_COLLECTIONS']);
    expect(getDashboardSummaryMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Summary Cards');
  });
});

// ===========================================================================
describe('A. Student Statement quick link honours its own permission', () => {
  it('is visible (not hidden) with REPORTS_VIEW_STUDENT_STATEMENT', async () => {
    await renderCentre(['REPORTS_VIEW_STUDENT_STATEMENT']);
    const link = container.querySelector('a[href="/bursary/reports/student-statement"]') as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link!.className).not.toContain('hidden');
  });

  it('is hidden with REPORTS_VIEW_COLLECTIONS alone', async () => {
    await renderCentre(['REPORTS_VIEW_COLLECTIONS']);
    const link = container.querySelector('a[href="/bursary/reports/student-statement"]') as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link!.className).toContain('hidden');
  });
});
