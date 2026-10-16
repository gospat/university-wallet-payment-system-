/**
 * RBAC FOLLOW-UP — permission mapping, any-of guards and sidebar visibility.
 * =============================================================================
 * Proves:
 *   A. Student Statement is mapped to REPORTS_VIEW_STUDENT_STATEMENT everywhere
 *      (route + sidebar + quick link) and that REPORTS_VIEW_COLLECTIONS alone
 *      does NOT grant it.
 *   B. Reports Centre is reachable through REPORTS_VIEW_REVENUE.
 *   C. Reports Centre is reachable through REPORTS_VIEW_ACCOUNTING.
 *   D. Reports Centre is denied when a BURSARY session has no report-view key.
 *   F. Protected /bursary/* routes carry a permission guard.
 *   G. ADMIN (super-administrator) passes every permission-aware guard.
 *   H. An EMPTY BURSARY permission array remains zero access.
 *
 * The Reports Centre entry permission is a PREFIX rule (`REPORTS_VIEW_`) so it
 * can never drift when the canonical backend registry grows, and it deliberately
 * excludes REPORTS_EXPORT_* and the ADMIN-only REPORTS_SCHEDULE.
 */

import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import fs from 'node:fs';
import path from 'node:path';

// --- live session under test -------------------------------------------------
let currentUser: any = null;

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/bursary/reports/centre', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
  Navigate: ({ to }: any) => React.createElement('div', { 'data-testid': 'navigate' }, String(to)),
  Outlet: () => React.createElement('div', { 'data-testid': 'outlet' }),
  Link: ({ children, to, ...rest }: any) => React.createElement('a', { href: to, ...rest }, children),
  MemoryRouter: ({ children }: any) => children,
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

vi.mock('../services/searchApi', () => ({
  searchAdmin: vi.fn().mockResolvedValue({ students: [], payments: [], receipts: [] }),
}));

// Any lucide-react icon resolves to an inert component.
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const out: Record<string, any> = {};
  for (const key of Object.keys(actual)) {
    if (key === 'default' || key === '__esModule') continue;
    out[key] = () => null;
  }
  return out;
});

import {
  hasAnyPermission,
  RequirePermission,
  RequireAnyPermission,
  REPORTS_VIEW_PERMISSION_PREFIX,
} from '../components/PrivateRoute';
import PortalShell from '../components/PortalShell';

const u = (role: 'ADMIN' | 'BURSARY' | 'STUDENT', permissions?: string[]) =>
  ({ id: 1, email: 't@u.ng', firstName: 'T', lastName: 'U', role, permissions } as any);

// ---------------------------------------------------------------------------
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const flush = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const render = async (el: React.ReactElement) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(el); });
  await flush();
};

const href = (h: string) => container.querySelector(`a[href="${h}"]`);

const teardown = () => {
  try { act(() => { root?.unmount(); }); } catch { /* already unmounted */ }
  container?.remove();
  root = undefined as any;
  container = undefined as any;
};

const renderShell = async (role: 'ADMIN' | 'BURSARY', perms: string[]) => {
  await render(
    <PortalShell
      role={role}
      activePath="/bursary/reports/centre"
      brand="Test Portal"
      userText="Tester"
      onLogout={() => {}}
      userPermissions={perms}
    >
      <span />
    </PortalShell>,
  );
};

beforeEach(() => {
  currentUser = null;
  vi.clearAllMocks();
});

afterEach(() => {
  teardown();
});

// ===========================================================================
describe('hasAnyPermission + REPORTS_VIEW_PERMISSION_PREFIX (prefix rule)', () => {
  it('the prefix is exactly REPORTS_VIEW_', () => {
    expect(REPORTS_VIEW_PERMISSION_PREFIX).toBe('REPORTS_VIEW_');
  });

  it('matches an explicit key OR any key with the prefix', () => {
    expect(hasAnyPermission(u('BURSARY', ['REPORTS_VIEW_REVENUE']), undefined, REPORTS_VIEW_PERMISSION_PREFIX)).toBe(true);
    expect(hasAnyPermission(u('BURSARY', ['REPORTS_VIEW_ACCOUNTING']), ['NOPE'], REPORTS_VIEW_PERMISSION_PREFIX)).toBe(true);
    expect(hasAnyPermission(u('BURSARY', ['VIEW_PAYMENTS']), ['VIEW_PAYMENTS'])).toBe(true);
    expect(hasAnyPermission(u('BURSARY', ['VIEW_PAYMENTS']), ['NOPE'], REPORTS_VIEW_PERMISSION_PREFIX)).toBe(false);
  });

  it('REPORTS_EXPORT_* alone is NOT a report-view capability', () => {
    expect(hasAnyPermission(u('BURSARY', ['REPORTS_EXPORT_EXCEL']), undefined, REPORTS_VIEW_PERMISSION_PREFIX)).toBe(false);
    expect(hasAnyPermission(u('BURSARY', ['REPORTS_EXPORT_PDF']), undefined, REPORTS_VIEW_PERMISSION_PREFIX)).toBe(false);
  });

  it('REPORTS_SCHEDULE (ADMIN-only) is NOT a BURSARY entry capability', () => {
    expect(hasAnyPermission(u('BURSARY', ['REPORTS_SCHEDULE']), undefined, REPORTS_VIEW_PERMISSION_PREFIX)).toBe(false);
  });

  it('an EMPTY array / missing session never passes', () => {
    expect(hasAnyPermission(u('BURSARY', []), undefined, REPORTS_VIEW_PERMISSION_PREFIX)).toBe(false);
    expect(hasAnyPermission(u('BURSARY', undefined), undefined, REPORTS_VIEW_PERMISSION_PREFIX)).toBe(false);
    expect(hasAnyPermission(null, undefined, REPORTS_VIEW_PERMISSION_PREFIX)).toBe(false);
  });

  it('ADMIN always passes', () => {
    expect(hasAnyPermission(u('ADMIN', []), undefined, REPORTS_VIEW_PERMISSION_PREFIX)).toBe(true);
  });
});

// ===========================================================================
describe('A. Student Statement guard uses REPORTS_VIEW_STUDENT_STATEMENT', () => {
  const renderGuarded = () =>
    render(
      <RequirePermission permission="REPORTS_VIEW_STUDENT_STATEMENT">
        <div>statement-body</div>
      </RequirePermission>,
    );

  it('BURSARY with REPORTS_VIEW_STUDENT_STATEMENT can open it', async () => {
    currentUser = u('BURSARY', ['REPORTS_VIEW_STUDENT_STATEMENT']);
    await renderGuarded();
    expect(container.textContent).toContain('statement-body');
    expect(container.textContent).not.toContain('Access Denied');
  });

  it('BURSARY without it cannot open it', async () => {
    currentUser = u('BURSARY', ['REPORTS_VIEW_REVENUE']);
    await renderGuarded();
    expect(container.textContent).toContain('Access Denied');
    expect(container.textContent).not.toContain('statement-body');
  });

  it('REPORTS_VIEW_COLLECTIONS alone must NOT grant Student Statement access', async () => {
    currentUser = u('BURSARY', ['REPORTS_VIEW_COLLECTIONS']);
    await renderGuarded();
    expect(container.textContent).toContain('Access Denied');
    expect(container.textContent).not.toContain('statement-body');
  });

  it('ADMIN passes', async () => {
    currentUser = u('ADMIN', []);
    await renderGuarded();
    expect(container.textContent).toContain('statement-body');
  });
});

// ===========================================================================
describe('B/C/D/G/H. RequireAnyPermission gates Reports Centre entry', () => {
  const renderCentre = () =>
    render(
      <RequireAnyPermission permissionPrefix={REPORTS_VIEW_PERMISSION_PREFIX}>
        <div>centre-body</div>
      </RequireAnyPermission>,
    );

  it('B. BURSARY with REPORTS_VIEW_REVENUE (no COLLECTIONS) can enter', async () => {
    currentUser = u('BURSARY', ['REPORTS_VIEW_REVENUE']);
    await renderCentre();
    expect(container.textContent).toContain('centre-body');
  });

  it('C. BURSARY with REPORTS_VIEW_ACCOUNTING (no COLLECTIONS) can enter', async () => {
    currentUser = u('BURSARY', ['REPORTS_VIEW_ACCOUNTING']);
    await renderCentre();
    expect(container.textContent).toContain('centre-body');
  });

  it('D. BURSARY with no report-view key is denied', async () => {
    for (const perms of [[], ['VIEW_PAYMENTS'], ['REPORTS_EXPORT_EXCEL'], ['REPORTS_SCHEDULE']]) {
      currentUser = u('BURSARY', perms as string[]);
      await renderCentre();
      expect(container.textContent).toContain('Access Denied');
      expect(container.textContent).not.toContain('centre-body');
      teardown();
    }
  });

  it('H. an EMPTY BURSARY permission array is zero access', async () => {
    currentUser = u('BURSARY', []);
    await renderCentre();
    expect(container.textContent).toContain('Access Denied');
  });

  it('G. ADMIN passes', async () => {
    currentUser = u('ADMIN', []);
    await renderCentre();
    expect(container.textContent).toContain('centre-body');
  });
});

// ===========================================================================
describe('A/B/C/D/G/H. Sidebar visibility matches the route permission', () => {
  it('Reports Centre appears for any single REPORTS_VIEW_* capability', async () => {
    for (const perms of [['REPORTS_VIEW_REVENUE'], ['REPORTS_VIEW_ACCOUNTING'], ['REPORTS_VIEW_COLLECTIONS']]) {
      await renderShell('BURSARY', perms);
      expect(href('/bursary/reports/centre')).toBeTruthy();
      teardown();
    }
  });

  it('Reports Centre is hidden without a REPORTS_VIEW_* capability', async () => {
    for (const perms of [[], ['REPORTS_EXPORT_EXCEL'], ['REPORTS_SCHEDULE'], ['VIEW_PAYMENTS']]) {
      await renderShell('BURSARY', perms);
      expect(href('/bursary/reports/centre')).toBeNull();
      teardown();
    }
  });

  it('A. Student Statement appears ONLY with REPORTS_VIEW_STUDENT_STATEMENT', async () => {
    await renderShell('BURSARY', ['REPORTS_VIEW_STUDENT_STATEMENT']);
    expect(href('/bursary/reports/student-statement')).toBeTruthy();
    teardown();

    // COLLECTIONS alone must NOT surface the Student Statement nav item.
    await renderShell('BURSARY', ['REPORTS_VIEW_COLLECTIONS']);
    expect(href('/bursary/reports/student-statement')).toBeNull();
    expect(href('/bursary/reports/centre')).toBeTruthy();
  });

  it('H. an EMPTY BURSARY permission array yields the empty-menu notice', async () => {
    await renderShell('BURSARY', []);
    expect(href('/bursary/reports/centre')).toBeNull();
    expect(href('/bursary/reports/student-statement')).toBeNull();
    expect(href('/bursary/dashboard')).toBeNull();
    expect(container.textContent).toContain('No menu items available');
  });

  it('G. ADMIN sidebar is unrestricted even with no explicit permissions', async () => {
    await renderShell('ADMIN', []);
    expect(href('/admin/dashboard')).toBeTruthy();
    expect(href('/admin/students')).toBeTruthy();
    expect(href('/admin/payments')).toBeTruthy();
    expect(href('/admin/roles')).toBeTruthy();
    expect(container.textContent).not.toContain('No menu items available');
  });
});

// ===========================================================================
describe('F/H. Static route contract — every /bursary/* route is guarded', () => {
  const APP_SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
  const SHELL_SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/components/PortalShell.tsx'), 'utf8');

  const GUARDS = ['RequirePermission', 'RequireAnyPermission', 'Navigate'];

  it('no /bursary/* route relies on role-only PrivateRoute (no bare Suspense element)', () => {
    const unguarded: string[] = [];
    const re = /path="(\/bursary\/[^"]*)"\s*element=\{\s*<([A-Za-z]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(APP_SRC)) !== null) {
      // `/bursary/login` is the public sign-in route, not a protected page.
      if (m[1] === '/bursary/login') continue;
      if (!GUARDS.includes(m[2])) unguarded.push(`${m[1]} -> <${m[2]}>`);
    }
    expect(unguarded).toEqual([]);
  });

  it('A. student-statement route maps to REPORTS_VIEW_STUDENT_STATEMENT only', () => {
    const i = APP_SRC.indexOf('path="/bursary/reports/student-statement"');
    expect(i).toBeGreaterThan(-1);
    const block = APP_SRC.slice(i, i + 400);
    expect(block).toContain('permission="REPORTS_VIEW_STUDENT_STATEMENT"');
    expect(block).not.toContain('REPORTS_VIEW_COLLECTIONS');
  });

  it('B/C/D. reports/centre route uses the any-REPORTS_VIEW_* guard', () => {
    const i = APP_SRC.indexOf('path="/bursary/reports/centre"');
    expect(i).toBeGreaterThan(-1);
    const block = APP_SRC.slice(i, i + 400);
    expect(block).toContain('RequireAnyPermission');
    expect(block).toContain('REPORTS_VIEW_PERMISSION_PREFIX');
    expect(block).not.toContain('REPORTS_VIEW_COLLECTIONS');
  });

  it('configurable /bursary/* capabilities map to canonical registry keys', () => {
    const expectations: Array<[string, string]> = [
      ['path="/bursary/dashboard"', 'VIEW_DASHBOARD'],
      ['path="/bursary/students"', 'VIEW_STUDENTS'],
      ['path="/bursary/bills/create"', 'CREATE_FEE'],
      ['path="/bursary/refunds"', 'PROCESS_REFUND'],
      ['path="/bursary/payments"', 'VIEW_PAYMENTS'],
      ['path="/bursary/receipts"', 'VIEW_RECEIPTS'],
      ['path="/bursary/audit-logs"', 'AUDIT_LOGS_VIEW_LIMITED'],
      ['path="/bursary/reconciliation"', 'VIEW_RECONCILIATION'],
      ['path="/bursary/academic/faculties"', 'VIEW_COLLEGES'],
      ['path="/bursary/academic/departments"', 'VIEW_DEPARTMENTS'],
      ['path="/bursary/academic/programmes"', 'VIEW_PROGRAMMES'],
      ['path="/bursary/academic/student-categories"', 'VIEW_STUDENTS'],
    ];
    for (const [needle, perm] of expectations) {
      const i = APP_SRC.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      expect(APP_SRC.slice(i, i + 500), needle).toContain(`permission="${perm}"`);
    }
  });

  it('fees and direct-billing routes use the any-of guard for their tabs', () => {
    for (const needle of ['path="/bursary/fees"', 'path="/bursary/fees/:tab"']) {
      const i = APP_SRC.indexOf(needle);
      const block = APP_SRC.slice(i, i + 400);
      expect(block, needle).toContain('RequireAnyPermission');
      for (const p of ['VIEW_BILL_CATEGORIES', 'VIEW_BILLS_CATALOGUE', 'EDIT_FEE', 'BULK_UPLOAD_FEES', 'ASSIGN_FEES']) {
        expect(block, `${needle}/${p}`).toContain(p);
      }
    }
    for (const needle of ['path="/bursary/direct-billing"', 'path="/bursary/direct-billing/:tab"']) {
      const i = APP_SRC.indexOf(needle);
      const block = APP_SRC.slice(i, i + 400);
      expect(block, needle).toContain('RequireAnyPermission');
      expect(block, needle).toContain('DIRECT_BILL_STUDENT');
      expect(block, needle).toContain('VIEW_DIRECT_BILLS_LOG');
    }
  });

  it('A. sidebar Student Statement item uses REPORTS_VIEW_STUDENT_STATEMENT', () => {
    const i = SHELL_SRC.indexOf("to: '/bursary/reports/student-statement'");
    expect(i).toBeGreaterThan(-1);
    const block = SHELL_SRC.slice(i, i + 220);
    expect(block).toContain("requiresPermission: 'REPORTS_VIEW_STUDENT_STATEMENT'");
    expect(block).not.toContain('REPORTS_VIEW_COLLECTIONS');
  });

  it('B/C/D. sidebar Reports Centre item uses the any-REPORTS_VIEW_* prefix', () => {
    const i = SHELL_SRC.indexOf("to: '/bursary/reports/centre'");
    expect(i).toBeGreaterThan(-1);
    const block = SHELL_SRC.slice(i, i + 220);
    expect(block).toContain('anyPermissionPrefix: REPORTS_VIEW_PERMISSION_PREFIX');
    expect(block).not.toContain('REPORTS_VIEW_COLLECTIONS');
  });
});
