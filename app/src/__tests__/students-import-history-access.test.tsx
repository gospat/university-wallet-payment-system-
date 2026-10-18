/**
 * ADMIN STUDENTS — Import History access contract (VIEW_IMPORT_HISTORY)
 * =============================================================================
 * Production defect this suite locks down: VIEW_IMPORT_HISTORY correctly hid the
 * Import History navigation item, but the PAGE did not enforce it. Students.tsx
 * handled `view=create` and `view=upload` but never `view=history`, so
 * /students?view=history rendered nothing meaningful AND, once wired, must not
 * leak import-history data to a user who lacks the capability.
 *
 * Proved here:
 *   • the History TAB is only rendered for a user holding VIEW_IMPORT_HISTORY
 *     (or a protected Super Admin);
 *   • BULK_UPLOAD_STUDENTS alone does NOT grant history reading;
 *   • direct-URL ?view=history without the capability renders the explicit
 *     "Access Denied" panel and NEVER ImportHistoryPage;
 *   • with the capability (any role, or Super Admin) ImportHistoryPage renders.
 *
 * NOTE: this is a pure-frontend contract — the API is the security boundary.
 * The matching API-side enforcement is asserted separately.
 */

import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const { searchParamsRef, currentUser } = vi.hoisted(() => ({
  searchParamsRef: { current: new URLSearchParams() },
  currentUser: { value: null as any },
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/admin/students', search: '' }),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
  Link: ({ children, to }: any) => React.createElement('a', { href: to }, children),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: currentUser.value, logout: vi.fn() }),
}));

vi.mock('../components/PortalShell', () => ({
  default: ({ children }: any) => React.createElement('div', { 'data-testid': 'portal-shell' }, children),
}));

vi.mock('../components/Modal', () => ({
  default: ({ isOpen, children, title }: any) =>
    isOpen
      ? React.createElement('div', { 'data-testid': 'modal' },
          React.createElement('div', { 'data-testid': 'modal-title' }, title),
          children,
        )
      : null,
}));

vi.mock('../components/ConfirmAction', () => ({ default: () => null }));

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const out: Record<string, any> = {};
  for (const key of Object.keys(actual)) {
    if (key === 'default' || key === '__esModule') continue;
    out[key] = () => null;
  }
  return out;
});

// The real ImportHistoryPage is NOT under test; a marker stands in for it so we
// can assert whether it was rendered at all.
vi.mock('../pages/admin/ImportHistoryPage', () => ({
  default: () => React.createElement('div', { 'data-testid': 'import-history-page' }, 'import-history-data'),
}));

const apiGetMock = vi.fn();
const apiDeleteMock = vi.fn();

vi.mock('../services/api', () => ({
  __esModule: true,
  default: {
    get: (...args: any[]) => apiGetMock(...args),
    delete: (...args: any[]) => apiDeleteMock(...args),
  },
  navCounters: vi.fn().mockResolvedValue({}),
  downloadBlob: vi.fn(),
  apiErrorMessage: (err: any, fallback: string) => err?.message ?? fallback,
}));

vi.mock('../services/academicApi', () => ({
  programmesApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));

vi.mock('../services/adminApi', () => ({
  emailResendCredentialsApi: { resend: vi.fn() },
}));

vi.mock('../services/studentCategoriesApi', () => ({
  studentCategoriesApi: { list: vi.fn().mockResolvedValue({ rows: [], total: 0 }) },
}));

import StudentsPage from '../pages/admin/Students';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(role: 'ADMIN' | 'BURSARY' = 'ADMIN') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(StudentsPage, {
        role,
        brand: role === 'ADMIN' ? 'Admin Portal' : 'Bursary Portal',
        userText: `${role}: Test`,
        onLogout: vi.fn(),
        goBack: vi.fn(),
        dashboardTo: `/${role.toLowerCase()}/dashboard`,
      }),
    );
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

function setPermUiUser(over: Record<string, any>) {
  currentUser.value = {
    id: 7,
    role: 'ADMIN',
    isSuperAdmin: false,
    permissions: ['VIEW_STUDENTS', 'CREATE_STUDENT', 'BULK_UPLOAD_STUDENTS'],
    ...over,
  };
}

const historyTabButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent || '').includes('Import History'),
  );

beforeEach(() => {
  apiGetMock.mockReset();
  apiDeleteMock.mockReset();
  apiGetMock.mockResolvedValue({
    data: { data: { students: [], total: 0, page: 1, pageSize: 25, pageCount: 1 } },
  });
  searchParamsRef.current = new URLSearchParams();
  setPermUiUser({});
});

afterEach(() => {
  cleanup();
});

describe('Students — Import History tab visibility', () => {
  it('hides the Import History tab without VIEW_IMPORT_HISTORY', async () => {
    setPermUiUser({ permissions: ['VIEW_STUDENTS', 'BULK_UPLOAD_STUDENTS'] });
    render();
    await flush();
    expect(historyTabButton()).toBeFalsy();
  });

  it('shows the Import History tab with VIEW_IMPORT_HISTORY', async () => {
    setPermUiUser({ permissions: ['VIEW_STUDENTS', 'VIEW_IMPORT_HISTORY'] });
    render();
    await flush();
    expect(historyTabButton()).toBeTruthy();
  });

  it('shows the Import History tab for a protected Super Admin without explicit permissions', async () => {
    setPermUiUser({ isSuperAdmin: true, permissions: [] });
    render();
    await flush();
    expect(historyTabButton()).toBeTruthy();
  });

  it('BULK_UPLOAD_STUDENTS alone does NOT reveal the Import History tab', async () => {
    setPermUiUser({ permissions: ['VIEW_STUDENTS', 'BULK_UPLOAD_STUDENTS', 'CREATE_STUDENT'] });
    render();
    await flush();
    expect(text()).toContain('Bulk Upload');
    expect(historyTabButton()).toBeFalsy();
  });
});

describe('Students — direct URL /students?view=history is capability gated', () => {
  it('renders Access Denied (and no history data) for a user without VIEW_IMPORT_HISTORY', async () => {
    setPermUiUser({ permissions: ['VIEW_STUDENTS', 'BULK_UPLOAD_STUDENTS'] });
    searchParamsRef.current = new URLSearchParams('view=history');
    render();
    await flush();

    expect(container.querySelector('[data-testid="import-history-access-denied"]')).toBeTruthy();
    expect(text()).toContain('Access Denied');
    expect(text()).toContain('does not have the required permissions to view Import History');
    // The panel offers a way back, and no import-history data was rendered.
    expect(Array.from(container.querySelectorAll('button')).some((b) => (b.textContent || '').includes('Back to Students'))).toBe(true);
    expect(container.querySelector('[data-testid="import-history-page"]')).toBeNull();
    expect(text()).not.toContain('import-history-data');
  });

  it('renders ImportHistoryPage for an ADMIN holding VIEW_IMPORT_HISTORY', async () => {
    setPermUiUser({ permissions: ['VIEW_STUDENTS', 'VIEW_IMPORT_HISTORY'] });
    searchParamsRef.current = new URLSearchParams('view=history');
    render();
    await flush();

    expect(container.querySelector('[data-testid="import-history-page"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="import-history-access-denied"]')).toBeNull();
  });

  it('renders ImportHistoryPage for a protected Super Admin', async () => {
    setPermUiUser({ isSuperAdmin: true, permissions: ['VIEW_STUDENTS'] });
    searchParamsRef.current = new URLSearchParams('view=history');
    render();
    await flush();

    expect(container.querySelector('[data-testid="import-history-page"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="import-history-access-denied"]')).toBeNull();
  });

  it('renders ImportHistoryPage for a BURSARY user holding VIEW_IMPORT_HISTORY', async () => {
    setPermUiUser({ role: 'BURSARY', permissions: ['VIEW_STUDENTS', 'VIEW_IMPORT_HISTORY'] });
    searchParamsRef.current = new URLSearchParams('view=history');
    render('BURSARY');
    await flush();

    expect(container.querySelector('[data-testid="import-history-page"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="import-history-access-denied"]')).toBeNull();
  });

  it('does NOT render ImportHistoryPage for a BURSARY user without VIEW_IMPORT_HISTORY', async () => {
    setPermUiUser({ role: 'BURSARY', permissions: ['VIEW_STUDENTS'] });
    searchParamsRef.current = new URLSearchParams('view=history');
    render('BURSARY');
    await flush();

    expect(container.querySelector('[data-testid="import-history-page"]')).toBeNull();
    expect(container.querySelector('[data-testid="import-history-access-denied"]')).toBeTruthy();
  });
});
