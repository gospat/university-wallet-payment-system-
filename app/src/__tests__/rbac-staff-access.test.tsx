/**
 * HIERARCHICAL STAFF ACCESS — individual access + super-admin (contract §3 items
 * 5 & 6; binding decisions D1 + D6).
 * =============================================================================
 * Proves:
 *   • the admin API client exposes GET/PATCH /admin/users/:id/access and
 *     POST /admin/users/:id/super-admin with the exact verbs, URLs and bodies;
 *   • an EMPTY `permissionKeys` array is a valid, submittable CUSTOM payload;
 *   • the Users page summarises access as Super Admin / Inherits Admin Role /
 *     Inherits Bursary Role / Custom · X of Y;
 *   • the Manage Access affordance is suppressed for ADMIN targets when the
 *     viewer is a NORMAL admin (contract D6 — super-admin only);
 *   • the Manage Access modal lists ONLY the target role's available permissions
 *     (never an ADMIN-only key for a BURSARY target);
 *   • a protected super-admin target is shown read-only (no checkboxes);
 *   • a zero-permission CUSTOM selection is saveable.
 *
 * NOTE: this is a pure-frontend contract. The backend is the security boundary;
 * these tests only pin the UX contract and the request shape.
 */

import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// --- live session under test -------------------------------------------------
let currentUser: any = null;

// The single network boundary mocked is the axios instance. The REAL adminApi
// client (verbs, URLs, body, unwrapping) is exercised on top of it.
const { apiGet, apiPost, apiPatch, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/admin/users', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
  Navigate: ({ to }: any) => React.createElement('div', { 'data-testid': 'navigate' }, String(to)),
  Outlet: () => React.createElement('div', { 'data-testid': 'outlet' }),
  Link: ({ children, to }: any) => React.createElement('a', { href: to }, children),
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

vi.mock('../components/PortalShell', () => ({
  default: ({ children }: any) => React.createElement('div', { 'data-testid': 'portal-shell' }, children),
}));

vi.mock('../components/Modal', () => ({
  default: ({ isOpen, children, title, footer }: any) =>
    isOpen
      ? React.createElement(
          'div',
          { 'data-testid': 'modal', 'data-title': title },
          React.createElement('div', { 'data-testid': 'modal-title' }, title),
          children,
          React.createElement('div', { 'data-testid': 'modal-footer' }, footer),
        )
      : null,
}));

// ConfirmAction is not under test here (delete/suspend/reset confirmations).
vi.mock('../components/ConfirmAction', () => ({ default: () => null }));

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

vi.mock('../i18n/en', () => ({
  i18n: {
    errors: { generic: 'Something went wrong.' },
    portals: {
      admin: { dashboardBrand: 'Admin Portal', dashboardGreeting: (n: string) => `Admin: ${n}` },
    },
  },
}));

vi.mock('../services/api', () => ({
  __esModule: true,
  default: { get: apiGet, post: apiPost, patch: apiPatch, delete: apiDelete },
  navCounters: vi.fn().mockResolvedValue({}),
}));

import { usersApi } from '../services/adminApi';
import UsersPage from '../pages/admin/Users';

// ---------------------------------------------------------------------------
const ROWS: any[] = [
  {
    id: 1, firstName: 'Ada', lastName: 'Owner', email: 'ada@u.ng', role: 'ADMIN',
    accountStatus: 'ACTIVE', isSuperAdmin: true, accessMode: 'INHERIT',
    rolePermissionCount: 76, effectivePermissionCount: 76,
  },
  {
    id: 2, firstName: 'Norm', lastName: 'Admin', email: 'norm@u.ng', role: 'ADMIN',
    accountStatus: 'ACTIVE', isSuperAdmin: false, accessMode: 'INHERIT',
    rolePermissionCount: 76, effectivePermissionCount: 76,
  },
  {
    id: 3, firstName: 'Burs', lastName: 'Staff', email: 'burs@u.ng', role: 'BURSARY',
    accountStatus: 'ACTIVE', isSuperAdmin: false, accessMode: 'CUSTOM',
    rolePermissionCount: 40, effectivePermissionCount: 3,
  },
];

const PERMS: any[] = [
  { key: 'VIEW_DASHBOARD', name: 'View Dashboard', category: 'Dashboard', description: 'See the dashboard', adminOnly: false, assignable: true, roles_assigned: ['ADMIN', 'BURSARY'] },
  { key: 'VIEW_STUDENTS', name: 'View Students', category: 'Students', description: null, adminOnly: false, assignable: true, roles_assigned: ['ADMIN'] },
  { key: 'REPORTS_VIEW_COLLECTIONS', name: 'Reports: Collections', category: 'Reports', description: null, adminOnly: false, assignable: true, roles_assigned: ['ADMIN'] },
  { key: 'REPORTS_SCHEDULE', name: 'Reports: Schedule', category: 'Reports', description: null, adminOnly: true, assignable: false, roles_assigned: ['ADMIN'] },
];

const ACCESS_BURSARY: any = {
  user: { id: 3, email: 'burs@u.ng', firstName: 'Burs', lastName: 'Staff', role: 'BURSARY', accountStatus: 'ACTIVE', isSuperAdmin: false },
  accessMode: 'CUSTOM',
  rolePermissions: ['VIEW_DASHBOARD', 'VIEW_STUDENTS', 'REPORTS_VIEW_COLLECTIONS'],
  rolePermissionCount: 3,
  selectedPermissions: ['VIEW_DASHBOARD'],
  effectivePermissions: ['VIEW_DASHBOARD'],
  effectivePermissionCount: 1,
  isProtected: false,
};

const ACCESS_ADMIN_NORMAL: any = {
  user: { id: 2, email: 'norm@u.ng', firstName: 'Norm', lastName: 'Admin', role: 'ADMIN', accountStatus: 'ACTIVE', isSuperAdmin: false },
  accessMode: 'INHERIT',
  rolePermissions: ['VIEW_DASHBOARD', 'VIEW_STUDENTS', 'REPORTS_VIEW_COLLECTIONS', 'REPORTS_SCHEDULE'],
  rolePermissionCount: 4,
  selectedPermissions: [],
  effectivePermissions: ['VIEW_DASHBOARD', 'VIEW_STUDENTS', 'REPORTS_VIEW_COLLECTIONS', 'REPORTS_SCHEDULE'],
  effectivePermissionCount: 4,
  isProtected: false,
};

const ACCESS_SUPER: any = {
  user: { id: 1, email: 'ada@u.ng', firstName: 'Ada', lastName: 'Owner', role: 'ADMIN', accountStatus: 'ACTIVE', isSuperAdmin: true },
  accessMode: 'INHERIT',
  rolePermissions: ['VIEW_DASHBOARD', 'VIEW_STUDENTS', 'REPORTS_VIEW_COLLECTIONS', 'REPORTS_SCHEDULE'],
  rolePermissionCount: 4,
  selectedPermissions: [],
  effectivePermissions: ['VIEW_DASHBOARD', 'VIEW_STUDENTS', 'REPORTS_VIEW_COLLECTIONS', 'REPORTS_SCHEDULE'],
  effectivePermissionCount: 4,
  isProtected: true,
};

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

const teardown = () => {
  try { act(() => { root?.unmount(); }); } catch { /* already unmounted */ }
  container?.remove();
  root = undefined as any;
  container = undefined as any;
};

const modalByTitle = (prefix: string): HTMLElement | null =>
  container.querySelector(`[data-testid="modal"][data-title^="${prefix}"]`) as HTMLElement | null;

const clickIn = async (scope: HTMLElement, re: RegExp) => {
  const btn = Array.from(scope.querySelectorAll('button')).find((b) => re.test(b.textContent || ''));
  if (!btn) throw new Error(`button matching ${re} not found`);
  await act(async () => { (btn as HTMLButtonElement).click(); });
  await flush();
};

const clickRowAction = async (email: string, label: string) => {
  const row = Array.from(container.querySelectorAll('tr')).find((tr) => (tr.textContent || '').includes(email));
  if (!row) throw new Error(`row not found: ${email}`);
  const btn = Array.from(row.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === label);
  if (!btn) throw new Error(`button "${label}" not found in row ${email}`);
  await act(async () => { (btn as HTMLButtonElement).click(); });
  await flush();
};

const setRadio = async (scope: HTMLElement, value: string) => {
  const input = scope.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement | null;
  if (!input) throw new Error(`radio ${value} not found`);
  await act(async () => {
    input.click();
    if (!input.checked) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await flush();
};

beforeEach(() => {
  currentUser = null;
  vi.clearAllMocks();
  apiGet.mockImplementation((url: string) => {
    if (url === '/admin/users') {
      return Promise.resolve({ data: { data: { items: ROWS, total: ROWS.length, page: 1, pageSize: 25, pageCount: 1 } } });
    }
    if (url === '/admin/permissions') return Promise.resolve({ data: { data: { items: PERMS } } });
    if (url === '/admin/users/3/access') return Promise.resolve({ data: { data: ACCESS_BURSARY } });
    if (url === '/admin/users/2/access') return Promise.resolve({ data: { data: ACCESS_ADMIN_NORMAL } });
    if (url === '/admin/users/1/access') return Promise.resolve({ data: { data: ACCESS_SUPER } });
    return Promise.resolve({ data: { data: {} } });
  });
  apiPatch.mockResolvedValue({ data: { data: ACCESS_BURSARY } });
  apiPost.mockResolvedValue({ data: { data: ACCESS_SUPER } });
  apiDelete.mockResolvedValue({ data: { data: {} } });
});

afterEach(() => {
  teardown();
});

// ===========================================================================
describe('admin API client — individual access + super-admin (contract §3 item 5)', () => {
  it('getAccess uses GET /admin/users/:id/access', async () => {
    await usersApi.getAccess(5);
    expect(apiGet).toHaveBeenCalledWith('/admin/users/5/access');
  });

  it('updateAccess PATCHes the access payload', async () => {
    await usersApi.updateAccess(5, { accessMode: 'CUSTOM', permissionKeys: ['VIEW_STUDENTS'] });
    expect(apiPatch).toHaveBeenCalledWith('/admin/users/5/access', {
      accessMode: 'CUSTOM',
      permissionKeys: ['VIEW_STUDENTS'],
    });
  });

  it('updateAccess submits an EMPTY permissionKeys array for an explicit zero', async () => {
    await usersApi.updateAccess(7, { accessMode: 'CUSTOM', permissionKeys: [] });
    expect(apiPatch).toHaveBeenCalledWith('/admin/users/7/access', {
      accessMode: 'CUSTOM',
      permissionKeys: [],
    });
  });

  it('updateAccess with INHERIT sends no permissionKeys', async () => {
    await usersApi.updateAccess(7, { accessMode: 'INHERIT' });
    expect(apiPatch).toHaveBeenCalledWith('/admin/users/7/access', { accessMode: 'INHERIT' });
  });

  it('setSuperAdmin POSTs the grant/revoke flag', async () => {
    await usersApi.setSuperAdmin(9, true);
    expect(apiPost).toHaveBeenCalledWith('/admin/users/9/super-admin', { grant: true });
    await usersApi.setSuperAdmin(9, false);
    expect(apiPost).toHaveBeenCalledWith('/admin/users/9/super-admin', { grant: false });
  });
});

// ===========================================================================
describe('Users page — Access column (contract §3 item 6)', () => {
  it('summarises each row as Super Admin / Inherits Admin Role / Custom · X of Y', async () => {
    currentUser = { id: 99, role: 'ADMIN', isSuperAdmin: true, permissions: [] };
    await render(<UsersPage />);
    expect(container.textContent).toContain('Super Admin');
    expect(container.textContent).toContain('Inherits Admin Role');
    expect(container.textContent).toContain('Custom · 3 of 40');
  });

  it('a SUPER ADMIN viewer can Manage Access on every row', async () => {
    currentUser = { id: 99, role: 'ADMIN', isSuperAdmin: true, permissions: [] };
    await render(<UsersPage />);
    const manage = Array.from(container.querySelectorAll('button')).filter(
      (b) => (b.textContent || '').includes('Manage Access'),
    );
    expect(manage.length).toBe(3);
  });

  it('a NORMAL ADMIN viewer cannot Manage Access on ADMIN targets (contract D6)', async () => {
    currentUser = { id: 99, role: 'ADMIN', isSuperAdmin: false, permissions: ['MANAGE_USERS'] };
    await render(<UsersPage />);
    const manage = Array.from(container.querySelectorAll('button')).filter(
      (b) => (b.textContent || '').includes('Manage Access'),
    );
    // Only the BURSARY target remains manageable for a normal ADMIN.
    expect(manage.length).toBe(1);
  });
});

// ===========================================================================
describe('Manage Access modal (contract §3 item 6)', () => {
  beforeEach(() => {
    currentUser = { id: 99, role: 'ADMIN', isSuperAdmin: true, permissions: [] };
  });

  it('shows the target summary and ONLY the target role available permissions', async () => {
    await render(<UsersPage />);
    await clickRowAction('burs@u.ng', 'Manage Access');
    const modal = modalByTitle('Manage Access: Burs Staff');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('BURSARY');
    expect(modal!.textContent).toContain('ACTIVE');
    // CUSTOM is the current mode → the picker is visible with 1 of 3 selected.
    expect(modal!.textContent).toContain('Permissions (1/3)');
    expect(modal!.textContent).toContain('REPORTS_VIEW_COLLECTIONS');
    // ADMIN-only key must NEVER be offered for a BURSARY target.
    expect(modal!.textContent).not.toContain('REPORTS_SCHEDULE');
  });

  it('switching to Inherit Role Access hides the permission picker', async () => {
    await render(<UsersPage />);
    await clickRowAction('burs@u.ng', 'Manage Access');
    const modal = modalByTitle('Manage Access: Burs Staff');
    expect(modal!.textContent).toContain('Select All Available');
    await setRadio(modal!, 'INHERIT');
    expect(modal!.textContent).not.toContain('Select All Available');
  });

  it('an ADMIN target exposes the FULL catalogue (incl. ADMIN-only keys) in custom mode', async () => {
    await render(<UsersPage />);
    await clickRowAction('norm@u.ng', 'Manage Access');
    const modal = modalByTitle('Manage Access: Norm Admin');
    expect(modal).not.toBeNull();
    await setRadio(modal!, 'CUSTOM');
    // The ADMIN role maximum is the whole registry, so REPORTS_SCHEDULE IS offered.
    expect(modal!.textContent).toContain('REPORTS_SCHEDULE');
    expect(modal!.textContent).toContain('Permissions (0/4)');
    // A super-admin viewer of an ADMIN target can also grant the protected flag.
    expect(modal!.textContent).toContain('Grant Super Admin');
  });

  it('a protected super-admin target is read-only (no checkboxes, no radios)', async () => {
    await render(<UsersPage />);
    await clickRowAction('ada@u.ng', 'Manage Access');
    const modal = modalByTitle('Manage Access: Ada Owner');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('Protected Super Administrator');
    expect(modal!.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(modal!.querySelectorAll('input[type="radio"]').length).toBe(0);
    // A super-admin viewer may revoke the protected flag.
    expect(modal!.textContent).toContain('Revoke Super Admin');
  });

  it('a ZERO-permission CUSTOM selection is saveable and submits permissionKeys: []', async () => {
    await render(<UsersPage />);
    await clickRowAction('burs@u.ng', 'Manage Access');
    const modal = modalByTitle('Manage Access: Burs Staff');

    await clickIn(modal!, /Clear All/);
    expect(modal!.textContent).toContain('Permissions (0/3)');

    await clickIn(modal!, /Review & Save/);
    const confirm = modalByTitle('Confirm access change');
    expect(confirm).not.toBeNull();
    expect(confirm!.textContent).toContain('Permissions selected: 0');

    await clickIn(confirm!, /Confirm & Save/);
    expect(apiPatch).toHaveBeenCalledWith('/admin/users/3/access', {
      accessMode: 'CUSTOM',
      permissionKeys: [],
    });
  });

  it('does not expose a save affordance until something changes', async () => {
    await render(<UsersPage />);
    await clickRowAction('burs@u.ng', 'Manage Access');
    const modal = modalByTitle('Manage Access: Burs Staff');
    const save = Array.from(modal!.querySelectorAll('button')).find((b) => /Review & Save/.test(b.textContent || '')) as HTMLButtonElement;
    expect(save).toBeTruthy();
    // No change yet → disabled (nothing to submit, and never a silent no-op save).
    expect(save.disabled).toBe(true);
  });
});
