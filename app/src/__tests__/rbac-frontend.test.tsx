/**
 * RBAC FRONTEND — role/permission UI + permission-aware routing (brief §12-§15, §20, §22)
 * =============================================================================
 * Proves:
 *   • the backend catalogue drives the UI (no independent frontend master list);
 *   • ADMIN is presented as a PROTECTED super-administrator and is never editable;
 *   • BURSARY is the only editable role; STUDENT is a fixed system role;
 *   • categories are derived dynamically (a new backend category shows up);
 *   • ADMIN-only permissions are never offered for assignment;
 *   • an EMPTY permission set is a valid, saveable configuration (`[]`);
 *   • `hasPermission`/`RequirePermission`/`PrivateRoute` treat `[]` as ZERO
 *     permissions — an empty array never activates a fallback.
 */

import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// --- live session under test -------------------------------------------------
let currentUser: any = null;

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/bursary/students', search: '', hash: '' }),
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

vi.mock('lucide-react', () => {
  const icons = [
    'Shield', 'Pencil', 'Eye', 'ChevronDown', 'ChevronRight', 'Loader2',
    'CheckCircle2', 'AlertTriangle', 'Info', 'Lock', 'ShieldAlert', 'Search', 'UserCog',
  ];
  const out: any = {};
  icons.forEach((n) => { out[n] = () => null; });
  return out;
});

vi.mock('../i18n/en', () => ({
  i18n: {
    errors: { generic: 'Something went wrong.' },
    portals: {
      admin: { dashboardBrand: 'Admin Portal', dashboardGreeting: (n: string) => `Admin: ${n}` },
      bursary: { dashboardBrand: 'Bursary Portal', dashboardGreeting: (n: string) => `Bursary: ${n}` },
    },
  },
}));

const navCountersMock = vi.fn().mockResolvedValue({});
vi.mock('../services/api', () => ({
  __esModule: true,
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  navCounters: (...args: any[]) => navCountersMock(...args),
}));

// --- canonical-catalogue payload returned by the API ------------------------
const PERMS: any[] = [
  { key: 'VIEW_DASHBOARD', name: 'View Dashboard', category: 'Dashboard', description: null, adminOnly: false, assignable: true, roles_assigned: ['ADMIN', 'BURSARY'] },
  { key: 'VIEW_STUDENTS', name: 'View Students', category: 'Students', description: null, adminOnly: false, assignable: true, roles_assigned: ['ADMIN'] },
  { key: 'REPORTS_VIEW_COLLECTIONS', name: 'Reports: View Collections (R1/R2/R3)', category: 'Reports', description: null, adminOnly: false, assignable: true, roles_assigned: ['ADMIN'] },
  { key: 'REPORTS_SCHEDULE', name: 'Reports: Schedule Recurring (R20)', category: 'Reports', description: null, adminOnly: true, assignable: false, roles_assigned: ['ADMIN'] },
];

const ROLES: any[] = [
  { role: 'ADMIN', name: 'Administrator', description: 'Full system access. Protected role.', modifiable: false, isSuperAdmin: true, permissions: PERMS, permissionsCount: PERMS.length },
  { role: 'BURSARY', name: 'Bursary', description: 'Financial operations.', modifiable: true, isSuperAdmin: false, permissions: [PERMS[0]], permissionsCount: 1 },
  { role: 'STUDENT', name: 'Student', description: 'Fixed student self-service access.', modifiable: false, isSuperAdmin: false, permissions: [], permissionsCount: 0 },
];

const rolesListMock = vi.fn().mockResolvedValue(ROLES);
const rolesUpdateMock = vi.fn().mockResolvedValue({ diff: { added: [], removed: ['VIEW_DASHBOARD'] } });
const permsListMock = vi.fn().mockResolvedValue(PERMS);

vi.mock('../services/adminApi', () => ({
  rolesApi: { list: (...a: any[]) => rolesListMock(...a), update: (...a: any[]) => rolesUpdateMock(...a), get: vi.fn(), assignPermissions: vi.fn() },
  permissionsApi: { list: (...a: any[]) => permsListMock(...a) },
}));

import { hasPermission, hasAnyPermission, RequirePermission } from '../components/PrivateRoute';
import PrivateRoute from '../components/PrivateRoute';
import RolesPage from '../pages/admin/Roles';
import PermissionsPage from '../pages/admin/Permissions';

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

const clickText = async (text: string) => {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent || '').trim() === text,
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  await act(async () => { (btn as HTMLButtonElement).click(); });
  await flush();
};

const clickMatch = async (re: RegExp) => {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => re.test(b.textContent || ''));
  if (!btn) throw new Error(`button not found matching ${re}`);
  await act(async () => { (btn as HTMLButtonElement).click(); });
  await flush();
};

const modalByTitle = (prefix: string): HTMLElement | null =>
  container.querySelector(`[data-testid="modal"][data-title^="${prefix}"]`) as HTMLElement | null;

beforeEach(() => {
  currentUser = null;
  rolesUpdateMock.mockClear();
  vi.clearAllMocks();
  rolesListMock.mockResolvedValue(ROLES);
  permsListMock.mockResolvedValue(PERMS);
  navCountersMock.mockResolvedValue({});
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
});

// ===========================================================================
describe('hasPermission — empty array means ZERO permissions (brief §15; contract D1)', () => {
  const u = (role: string, permissions?: string[], isSuperAdmin?: boolean) =>
    ({ id: 1, email: 't@u.ng', firstName: 'T', lastName: 'U', role, permissions, isSuperAdmin } as any);

  it('a PROTECTED SUPER ADMIN passes for any permission', () => {
    expect(hasPermission(u('ADMIN', [], true), 'ANYTHING')).toBe(true);
    expect(hasPermission(u('ADMIN', undefined, true), 'ANYTHING')).toBe(true);
  });

  it('a NORMAL ADMIN is evaluated against its permissions (no longer unrestricted)', () => {
    // isSuperAdmin absent/false → the role short-circuit must NOT apply.
    expect(hasPermission(u('ADMIN', []), 'ANYTHING')).toBe(false);
    expect(hasPermission(u('ADMIN', undefined), 'ANYTHING')).toBe(false);
    expect(hasPermission(u('ADMIN', ['VIEW_STUDENTS']), 'VIEW_STUDENTS')).toBe(true);
    expect(hasPermission(u('ADMIN', ['VIEW_STUDENTS']), 'VIEW_PAYMENTS')).toBe(false);
  });

  it('an EMPTY permissions array never activates a fallback', () => {
    expect(hasPermission(u('BURSARY', []), 'VIEW_STUDENTS')).toBe(false);
    expect(hasPermission(u('BURSARY', undefined), 'VIEW_STUDENTS')).toBe(false);
  });

  it('a granted permission is honoured; an ungranted one is denied', () => {
    expect(hasPermission(u('BURSARY', ['VIEW_STUDENTS']), 'VIEW_STUDENTS')).toBe(true);
    expect(hasPermission(u('BURSARY', ['VIEW_STUDENTS']), 'VIEW_PAYMENTS')).toBe(false);
  });

  it('no session → never permitted', () => {
    expect(hasPermission(null, 'VIEW_STUDENTS')).toBe(false);
    expect(hasPermission(undefined, 'VIEW_STUDENTS')).toBe(false);
  });
});

describe('permission-aware routing (brief §12, §13)', () => {
  it('RequirePermission denies a zero-permission BURSARY session', async () => {
    currentUser = { role: 'BURSARY', permissions: [] };
    await render(<RequirePermission permission="VIEW_STUDENTS"><div>secret</div></RequirePermission>);
    expect(container.textContent).toContain('Access Denied');
    expect(container.textContent).not.toContain('secret');
  });

  it('RequirePermission renders the page once the permission is granted', async () => {
    currentUser = { role: 'BURSARY', permissions: ['VIEW_STUDENTS'] };
    await render(<RequirePermission permission="VIEW_STUDENTS"><div>secret</div></RequirePermission>);
    expect(container.textContent).toContain('secret');
  });

  it('RequirePermission passes for a PROTECTED SUPER ADMIN without any explicit permission', async () => {
    currentUser = { role: 'ADMIN', isSuperAdmin: true, permissions: [] };
    await render(<RequirePermission permission="VIEW_STUDENTS"><div>secret</div></RequirePermission>);
    expect(container.textContent).toContain('secret');
  });

  it('RequirePermission DENIES a normal ADMIN with an empty permission set', async () => {
    currentUser = { role: 'ADMIN', permissions: [] };
    await render(<RequirePermission permission="VIEW_STUDENTS"><div>secret</div></RequirePermission>);
    expect(container.textContent).toContain('Access Denied');
    expect(container.textContent).not.toContain('secret');
  });

  it('RequirePermission lets a normal ADMIN through when the permission IS granted', async () => {
    currentUser = { role: 'ADMIN', permissions: ['VIEW_STUDENTS'] };
    await render(<RequirePermission permission="VIEW_STUDENTS"><div>secret</div></RequirePermission>);
    expect(container.textContent).toContain('secret');
  });

  it('PrivateRoute enforces the role boundary before permissions', async () => {
    currentUser = { role: 'STUDENT', permissions: [] };
    await render(<PrivateRoute roles={['BURSARY']} permission="VIEW_STUDENTS" />);
    expect(container.textContent).toContain('Access Denied');
  });

  it('PrivateRoute hides a route when the permission was removed', async () => {
    currentUser = { role: 'BURSARY', permissions: [] };
    await render(<PrivateRoute roles={['BURSARY']} permission="VIEW_PAYMENTS" />);
    expect(container.textContent).toContain('Access Denied');
    expect(container.querySelector('[data-testid="outlet"]')).toBeNull();
  });

  it('PrivateRoute renders the route when the permission is present', async () => {
    currentUser = { role: 'BURSARY', permissions: ['VIEW_PAYMENTS'] };
    await render(<PrivateRoute roles={['BURSARY']} permission="VIEW_PAYMENTS" />);
    expect(container.querySelector('[data-testid="outlet"]')).not.toBeNull();
  });
});

// ===========================================================================
describe('RBAC HARDENING — operational capability guards (role=ADMIN is not a bypass)', () => {
  // The canonical operational keys now enforced by the backend. A normal ADMIN
  // (unflagged) must pass a guard ONLY when it actually holds the capability.
  const OPERATIONAL_KEYS = [
    'VIEW_DASHBOARD',
    'VIEW_EMAIL_DELIVERY_LOGS',
    'MANAGE_EMAIL_TEMPLATES',
    'RESEND_CREDENTIALS',
    'MANAGE_ACADEMIC_STRUCTURE',
    'REPORTS_VIEW_COLLECTIONS',
    'RUN_RECONCILIATION',
  ];

  it('hasAnyPermission — empty array is ZERO, a super admin always passes', () => {
    expect(hasAnyPermission({ role: 'ADMIN', isSuperAdmin: true, permissions: [] } as any, OPERATIONAL_KEYS)).toBe(true);
    expect(hasAnyPermission({ role: 'ADMIN', permissions: [] } as any, OPERATIONAL_KEYS)).toBe(false);
    expect(hasAnyPermission({ role: 'ADMIN', permissions: undefined } as any, OPERATIONAL_KEYS)).toBe(false);
    expect(hasAnyPermission({ role: 'BURSARY', permissions: ['REPORTS_VIEW_COLLECTIONS'] } as any, OPERATIONAL_KEYS)).toBe(true);
    expect(hasAnyPermission({ role: 'BURSARY', permissions: ['VIEW_STUDENTS'] } as any, OPERATIONAL_KEYS)).toBe(false);
  });

  it('hasAnyPermission — prefix matching never admits EXPORT/SCHEDULE report keys', () => {
    expect(hasAnyPermission({ role: 'BURSARY', permissions: ['REPORTS_VIEW_REVENUE'] } as any, undefined, 'REPORTS_VIEW_')).toBe(true);
    expect(hasAnyPermission({ role: 'BURSARY', permissions: ['REPORTS_EXPORT_PDF'] } as any, undefined, 'REPORTS_VIEW_')).toBe(false);
    expect(hasAnyPermission({ role: 'BURSARY', permissions: ['REPORTS_SCHEDULE'] } as any, undefined, 'REPORTS_VIEW_')).toBe(false);
  });

  it('a zero-permission normal ADMIN is denied every operational guard', async () => {
    currentUser = { role: 'ADMIN', permissions: [] };
    for (const permission of OPERATIONAL_KEYS) {
      await render(<RequirePermission permission={permission}><div>secret</div></RequirePermission>);
      expect({ permission, denied: container.textContent?.includes('Access Denied') }).toEqual({ permission, denied: true });
      expect(container.textContent).not.toContain('secret');
    }
  });

  it('a normal ADMIN passes a guard only for the capability it holds', async () => {
    currentUser = { role: 'ADMIN', permissions: ['MANAGE_EMAIL_TEMPLATES'] };
    await render(<RequirePermission permission="MANAGE_EMAIL_TEMPLATES"><div>secret</div></RequirePermission>);
    expect(container.textContent).toContain('secret');

    await render(<RequirePermission permission="VIEW_DASHBOARD"><div>secret</div></RequirePermission>);
    expect(container.textContent).toContain('Access Denied');
  });

  it('a BURSARY session holding a capability is admitted to that guard only', async () => {
    currentUser = { role: 'BURSARY', permissions: ['VIEW_EMAIL_DELIVERY_LOGS'] };
    await render(<RequirePermission permission="VIEW_EMAIL_DELIVERY_LOGS"><div>secret</div></RequirePermission>);
    expect(container.textContent).toContain('secret');

    await render(<RequirePermission permission="VIEW_DASHBOARD"><div>secret</div></RequirePermission>);
    expect(container.textContent).toContain('Access Denied');
  });

  it('PrivateRoute enforces the ADMIN role boundary AND the VIEW_DASHBOARD capability', async () => {
    currentUser = { role: 'ADMIN', permissions: [] };
    await render(<PrivateRoute roles={['ADMIN']} permission="VIEW_DASHBOARD" />);
    expect(container.textContent).toContain('Access Denied');

    currentUser = { role: 'ADMIN', permissions: ['VIEW_DASHBOARD'] };
    await render(<PrivateRoute roles={['ADMIN']} permission="VIEW_DASHBOARD" />);
    expect(container.querySelector('[data-testid="outlet"]')).not.toBeNull();
  });

  it('a protected SUPER ADMIN passes every operational guard without explicit permissions', async () => {
    currentUser = { role: 'ADMIN', isSuperAdmin: true, permissions: [] };
    for (const permission of OPERATIONAL_KEYS) {
      await render(<RequirePermission permission={permission}><div>secret</div></RequirePermission>);
      expect({ permission, ok: container.textContent?.includes('secret') }).toEqual({ permission, ok: true });
    }
  });
});

// ===========================================================================
describe('Roles page — ADMIN protected, BURSARY configurable, STUDENT fixed (brief §2, §3.3, §22)', () => {
  beforeEach(() => { currentUser = { role: 'ADMIN', permissions: [] }; });

  it('presents ADMIN as Protected and STUDENT as a System Role', async () => {
    await render(<RolesPage />);
    expect(container.textContent).toContain('Protected');
    expect(container.textContent).toContain('System Role');
  });

  it('offers exactly one editable role (BURSARY)', async () => {
    await render(<RolesPage />);
    const manage = Array.from(container.querySelectorAll('button')).filter(
      (b) => (b.textContent || '').includes('Manage Permissions'),
    );
    expect(manage.length).toBe(1);
  });

  it('opens ADMIN read-only with the complete permission set', async () => {
    await render(<RolesPage />);
    await clickText('View Permissions'); // first card = ADMIN
    const modal = modalByTitle('Permissions: ADMIN');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('ADMIN is a protected super-administrator');
    expect(modal!.textContent).toContain('REPORTS_SCHEDULE');
  });

  it('derives categories dynamically, including a backend-only "Reports" category', async () => {
    await render(<RolesPage />);
    await clickText('Manage Permissions');
    const modal = modalByTitle('Manage Permissions: BURSARY');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('Reports');
    expect(modal!.textContent).toContain('REPORTS_VIEW_COLLECTIONS');
  });

  it('never lists an ADMIN-only permission for assignment', async () => {
    await render(<RolesPage />);
    await clickText('Manage Permissions');
    const modal = modalByTitle('Manage Permissions: BURSARY');
    expect(modal!.textContent).not.toContain('REPORTS_SCHEDULE');
  });

  it('Select all only selects assignable permissions', async () => {
    await render(<RolesPage />);
    await clickText('Manage Permissions');
    await clickText('Select all');
    const modal = modalByTitle('Manage Permissions: BURSARY');
    // 3 assignable of 4 total — REPORTS_SCHEDULE is excluded.
    expect(modal!.textContent).toContain('Permissions (3/3)');
  });

  it('Clear produces an EMPTY selection and saving submits permissionKeys: []', async () => {
    await render(<RolesPage />);
    await clickText('Manage Permissions');
    await clickText('Clear');

    const modal = modalByTitle('Manage Permissions: BURSARY');
    expect(modal!.textContent).toContain('Permissions selected: 0');

    await clickMatch(/Review & Save/);
    const confirm = modalByTitle('Confirm permission change: BURSARY');
    expect(confirm).not.toBeNull();
    expect(confirm!.textContent).toContain('Permissions selected: 0');

    await clickText('Confirm & Save');
    expect(rolesUpdateMock).toHaveBeenCalledWith('BURSARY', { permissionKeys: [] });
  });

  it('shows the pending added/removed counts before saving', async () => {
    await render(<RolesPage />);
    await clickText('Manage Permissions');
    await clickText('Clear');
    const modal = modalByTitle('Manage Permissions: BURSARY');
    expect(modal!.textContent).toContain('removed');
  });

  it('a NORMAL ADMIN sees the ADMIN baseline as read-only with a Super-Admin explanation', async () => {
    await render(<RolesPage />);
    // Only BURSARY is editable for a non-super-admin viewer.
    const manage = Array.from(container.querySelectorAll('button')).filter(
      (b) => (b.textContent || '').includes('Manage Permissions'),
    );
    expect(manage.length).toBe(1);
    expect(container.textContent).toContain('requires a Super Administrator');
  });

  it('a SUPER ADMIN can edit the ADMIN role baseline (full registry)', async () => {
    currentUser = { role: 'ADMIN', isSuperAdmin: true, permissions: [] };
    await render(<RolesPage />);
    // ADMIN + BURSARY both become editable for a Super Admin.
    const manage = Array.from(container.querySelectorAll('button')).filter(
      (b) => (b.textContent || '').includes('Manage Permissions'),
    );
    expect(manage.length).toBe(2);

    await clickText('Manage Permissions'); // first card = ADMIN
    const modal = modalByTitle('Manage Permissions: ADMIN');
    expect(modal).not.toBeNull();
    // The ADMIN role maximum is the FULL canonical registry (incl. adminOnly keys).
    expect(modal!.textContent).toContain('REPORTS_SCHEDULE');
    expect(modal!.textContent).toContain('ADMIN role maximum');
  });

  it('separates ROLE permissions from INDIVIDUAL user permissions and links to Manage Access', async () => {
    await render(<RolesPage />);
    expect(container.textContent).toContain('Role permissions');
    expect(container.textContent).toContain('Individual user permissions');
    expect(container.textContent).toContain('not a distinct role');
    expect(container.querySelector('a[href="/admin/users"]')).not.toBeNull();
  });
});

// ===========================================================================
describe('Permissions page — canonical catalogue is read-only (brief §4, §7)', () => {
  beforeEach(() => { currentUser = { role: 'ADMIN', permissions: [] }; });

  it('badges ADMIN-only permissions and marks the rest assignable', async () => {
    await render(<PermissionsPage />);
    expect(container.textContent).toContain('Admin only');
    expect(container.textContent).toContain('Assignable to Bursary');
  });

  it('renders every catalogue entry returned by the backend', async () => {
    await render(<PermissionsPage />);
    for (const p of PERMS) expect(container.textContent).toContain(p.key);
  });

  it('does not expose any editing control (catalogue is read-only)', async () => {
    await render(<PermissionsPage />);
    const editable = Array.from(container.querySelectorAll('button')).filter((b) =>
      /save|edit|assign|delete/i.test(b.textContent || ''),
    );
    expect(editable).toEqual([]);
  });
});
