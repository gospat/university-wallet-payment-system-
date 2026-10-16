/**
 * STAFF SELF-SERVICE PROFILE — ADMIN + BURSARY
 * =============================================================================
 * Proves the self-service My Profile capability:
 *   • ADMIN may reach /admin/profile (ADMIN-only route guard);
 *   • BURSARY may reach /bursary/profile (role-guarded, NO permission guard);
 *   • a BURSARY session with an EMPTY permissions array still SEES the "MY
 *     ACCOUNT → Profile" nav item and can open the page — Profile is a personal
 *     account capability, never an RBAC operational permission;
 *   • STUDENT can never reach either staff profile route;
 *   • unauthenticated sessions are redirected to the portal login;
 *   • the page reads the caller's OWN record from GET /auth/me (no userId is ever
 *     sent) and changes passwords through the EXISTING PATCH
 *     /auth/change-password endpoint (no second implementation);
 *   • no sensitive/internal field is rendered.
 *
 * The REAL PortalShell and the REAL PasswordInput are used so the assertions
 * cover genuine navigation and the genuine password control.
 *
 * No database is touched by this suite.
 */

import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// --- live session under test -------------------------------------------------
let currentUser: any = null;
let currentPath = '/admin/profile';

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: currentPath, search: '', hash: '' }),
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

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../services/api', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => apiGetMock(...a),
    patch: (...a: any[]) => apiPatchMock(...a),
    post: (...a: any[]) => apiPostMock(...a),
  },
  navCounters: vi.fn().mockResolvedValue({}),
}));

import PrivateRoute from '../components/PrivateRoute';
import PortalShell from '../components/PortalShell';
import StaffProfile from '../pages/profile/StaffProfile';

// ---------------------------------------------------------------------------
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const render = async (el: React.ReactElement) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  await flush();
};

const clickText = async (text: string) => {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent || '').trim() === text,
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  await act(async () => {
    (btn as HTMLButtonElement).click();
  });
  await flush();
};

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
};

const passwordInputs = (): HTMLInputElement[] =>
  Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];

const profilePayload = {
  status: 'success',
  data: {
    user: {
      id: 42,
      email: 'ada.admin@university.edu.ng',
      firstName: 'Ada',
      middleName: 'Ngozi',
      lastName: 'Okafor',
      phoneNumber: null,
      role: 'ADMIN',
      accountStatus: 'ACTIVE',
      lastLoginAt: '2026-10-15T08:30:00.000Z',
      createdAt: '2024-01-05T09:00:00.000Z',
      updatedAt: '2026-10-15T08:30:00.000Z',
      permissions: [],
    },
  },
};

beforeEach(() => {
  currentUser = null;
  currentPath = '/admin/profile';
  vi.clearAllMocks();
  apiGetMock.mockResolvedValue({ data: profilePayload });
  apiPatchMock.mockResolvedValue({ data: { status: 'success', message: 'Password changed successfully.' } });
  apiPostMock.mockResolvedValue({ data: { status: 'success' } });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

// ===========================================================================
describe('route protection — staff profile routes are never public', () => {
  it('ADMIN may access the ADMIN-only profile route', async () => {
    currentUser = { role: 'ADMIN', permissions: [] };
    await render(<PrivateRoute roles={['ADMIN']} />);
    expect(container.querySelector('[data-testid="outlet"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Access Denied');
  });

  it('BURSARY may access the BURSARY profile route WITHOUT any permission guard', async () => {
    currentUser = { role: 'BURSARY', permissions: [] };
    await render(<PrivateRoute roles={['BURSARY', 'ADMIN']} />);
    expect(container.querySelector('[data-testid="outlet"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Access Denied');
  });

  it('STUDENT cannot access the ADMIN staff profile route', async () => {
    currentUser = { role: 'STUDENT', permissions: [] };
    await render(<PrivateRoute roles={['ADMIN']} />);
    expect(container.textContent).toContain('Access Denied');
    expect(container.querySelector('[data-testid="outlet"]')).toBeNull();
  });

  it('STUDENT cannot access the BURSARY staff profile route', async () => {
    currentUser = { role: 'STUDENT', permissions: [] };
    await render(<PrivateRoute roles={['BURSARY', 'ADMIN']} />);
    expect(container.textContent).toContain('Access Denied');
    expect(container.querySelector('[data-testid="outlet"]')).toBeNull();
  });

  it('an unauthenticated session is redirected to the ADMIN login', async () => {
    currentUser = null;
    await render(<PrivateRoute roles={['ADMIN']} />);
    expect(container.textContent).toBe('/admin/login');
  });

  it('an unauthenticated session is redirected away from the BURSARY profile too', async () => {
    currentUser = null;
    await render(<PrivateRoute roles={['BURSARY', 'ADMIN']} />);
    expect(container.textContent).not.toContain('Access Denied');
    expect(container.textContent).toContain('/admin/login');
    expect(container.querySelector('[data-testid="outlet"]')).toBeNull();
  });
});

// ===========================================================================
describe('sidebar — MY ACCOUNT > Profile is a personal capability, not a permission', () => {
  it('ADMIN sees MY ACCOUNT → Profile pointing at /admin/profile', async () => {
    await render(
      <PortalShell
        role="ADMIN"
        activePath="/admin/profile"
        brand="Admin Portal"
        userText="Ada Okafor"
        userEmail="ada.admin@university.edu.ng"
        onLogout={vi.fn()}
        userPermissions={[]}
      >
        <div>PROFILE BODY</div>
      </PortalShell>,
    );
    expect(container.textContent).toContain('MY ACCOUNT');
    expect(container.textContent).toContain('Profile');
    expect(container.querySelector('a[href="/admin/profile"]')).not.toBeNull();
  });

  it('a BURSARY session with permissions: [] STILL sees MY ACCOUNT → Profile', async () => {
    await render(
      <PortalShell
        role="BURSARY"
        activePath="/bursary/profile"
        brand="Bursary Portal"
        userText="Bola Finance"
        userEmail="bola.finance@university.edu.ng"
        onLogout={vi.fn()}
        userPermissions={[]}
      >
        <div>PROFILE BODY</div>
      </PortalShell>,
    );
    // The empty-permission session is NOT locked out of its own account.
    expect(container.textContent).not.toContain('No menu items available');
    expect(container.textContent).toContain('MY ACCOUNT');
    expect(container.querySelector('a[href="/bursary/profile"]')).not.toBeNull();
    // …and it does NOT gain any operational capability it was not granted.
    expect(container.querySelector('a[href="/bursary/students"]')).toBeNull();
    expect(container.querySelector('a[href="/bursary/payments"]')).toBeNull();
  });

  it('the header name/avatar links to the signed-in user own profile', async () => {
    await render(
      <PortalShell
        role="BURSARY"
        activePath="/bursary/dashboard"
        brand="Bursary Portal"
        userText="Bola Finance"
        userEmail="bola.finance@university.edu.ng"
        onLogout={vi.fn()}
        userPermissions={[]}
      >
        <div>BODY</div>
      </PortalShell>,
    );
    expect(container.querySelector('a[aria-label="Open my profile"][href="/bursary/profile"]')).not.toBeNull();
  });
});

// ===========================================================================
describe('StaffProfile (ADMIN) — own record only + existing change-password endpoint', () => {
  beforeEach(() => {
    currentUser = {
      id: 42,
      role: 'ADMIN',
      email: 'ada.admin@university.edu.ng',
      firstName: 'Ada',
      lastName: 'Okafor',
      permissions: [],
    };
    currentPath = '/admin/profile';
  });

  it('renders for ADMIN and reads the authenticated current-user endpoint', async () => {
    await render(<StaffProfile />);
    expect(apiGetMock).toHaveBeenCalledWith('/auth/me');
    // Never an arbitrary user id from the browser.
    const calledWith = apiGetMock.mock.calls.map((c) => String(c[0]));
    expect(calledWith.every((u) => !/\d{1,}/.test(u) && !u.includes('userId'))).toBe(true);
  });

  it('shows the read-only account information with a friendly role label', async () => {
    await render(<StaffProfile />);
    expect(container.textContent).toContain('Account Information');
    expect(container.textContent).toContain('Full Name');
    expect(container.textContent).toContain('Ada Ngozi Okafor');
    expect(container.textContent).toContain('Middle Name');
    expect(container.textContent).toContain('ada.admin@university.edu.ng');
    expect(container.textContent).toContain('Administrator');
    expect(container.textContent).toContain('Active');
    expect(container.textContent).toContain('Last Login');
    expect(container.textContent).toContain('Account Created');
    expect(container.textContent).toContain('Last Account Update');
  });

  it('never renders sensitive or internal fields, and offers no way to edit role/status', async () => {
    await render(<StaffProfile />);
    const text = container.textContent || '';
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('refreshToken');
    expect(text).not.toContain('mustChangePassword');
    expect(text).not.toContain('lastLoginAt');
    // No internal permission keys are leaked into the page.
    expect(text).not.toMatch(/[A-Z]+_[A-Z_]{3,}/);
    // role/account status are rendered as static text, not editable controls
    expect(container.querySelector('select')).toBeNull();
  });

  it('changes the password through the EXISTING authenticated endpoint and clears the fields', async () => {
    await render(<StaffProfile />);
    const inputs = passwordInputs();
    expect(inputs.length).toBe(3);

    await setInputValue(inputs[0], 'OldPass123');
    await setInputValue(inputs[1], 'NewPass456');
    await setInputValue(inputs[2], 'NewPass456');
    await clickText('Update Password');

    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith('/auth/change-password', {
      currentPassword: 'OldPass123',
      newPassword: 'NewPass456',
    });
    expect(container.textContent).toContain('Password changed successfully.');
    passwordInputs().forEach((i) => expect(i.value).toBe(''));
  });

  it('requires the current password and never calls the endpoint without it', async () => {
    await render(<StaffProfile />);
    const inputs = passwordInputs();
    await setInputValue(inputs[1], 'NewPass456');
    await setInputValue(inputs[2], 'NewPass456');
    await clickText('Update Password');

    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('current password');
  });

  it('rejects a new password shorter than 8 characters', async () => {
    await render(<StaffProfile />);
    const inputs = passwordInputs();
    await setInputValue(inputs[0], 'OldPass123');
    await setInputValue(inputs[1], 'short1');
    await setInputValue(inputs[2], 'short1');
    await clickText('Update Password');

    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('at least 8 characters');
  });

  it('rejects a new password identical to the current one', async () => {
    await render(<StaffProfile />);
    const inputs = passwordInputs();
    await setInputValue(inputs[0], 'SamePass123');
    await setInputValue(inputs[1], 'SamePass123');
    await setInputValue(inputs[2], 'SamePass123');
    await clickText('Update Password');

    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('must differ');
  });

  it('blocks submission while the confirmation does not match', async () => {
    await render(<StaffProfile />);
    const inputs = passwordInputs();
    await setInputValue(inputs[0], 'OldPass123');
    await setInputValue(inputs[1], 'NewPass456');
    await setInputValue(inputs[2], 'Different789');

    expect(container.textContent).toContain('Passwords do not match.');

    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === 'Update Password',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => {
      btn.click();
    });
    await flush();
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it('surfaces the backend error when the current password is wrong', async () => {
    apiPatchMock.mockRejectedValueOnce({
      response: { data: { message: 'Current password is incorrect.' } },
    });
    await render(<StaffProfile />);
    const inputs = passwordInputs();
    await setInputValue(inputs[0], 'WrongOld123');
    await setInputValue(inputs[1], 'NewPass456');
    await setInputValue(inputs[2], 'NewPass456');
    await clickText('Update Password');

    expect(container.textContent).toContain('Current password is incorrect.');
    // fields are NOT cleared on failure
    expect(passwordInputs()[0].value).toBe('WrongOld123');
  });
});

// ===========================================================================
describe('StaffProfile (BURSARY) — works with an EMPTY permission set', () => {
  beforeEach(() => {
    currentUser = {
      id: 77,
      role: 'BURSARY',
      email: 'bola.finance@university.edu.ng',
      firstName: 'Bola',
      lastName: 'Adeyemi',
      permissions: [],
    };
    currentPath = '/bursary/profile';
    apiGetMock.mockResolvedValue({
      data: {
        status: 'success',
        data: {
          user: {
            id: 77,
            email: 'bola.finance@university.edu.ng',
            firstName: 'Bola',
            middleName: null,
            lastName: 'Adeyemi',
            role: 'BURSARY',
            accountStatus: 'ACTIVE',
            lastLoginAt: null,
            createdAt: '2025-03-02T11:00:00.000Z',
            updatedAt: '2026-10-14T13:20:00.000Z',
            permissions: [],
          },
        },
      },
    });
  });

  it('renders Profile with the Bursary friendly role and the /bursary/profile sidebar link', async () => {
    await render(<StaffProfile />);
    expect(container.textContent).not.toContain('No menu items available');
    expect(container.querySelector('a[href="/bursary/profile"]')).not.toBeNull();
    expect(container.textContent).toContain('Bursary');
    expect(container.textContent).toContain('Bola Adeyemi');
    // Middle name is omitted when unavailable.
    expect(container.textContent).not.toContain('Middle Name');
    // Never logged in yet.
    expect(container.textContent).toContain('Never');
  });

  it('still allows the empty-permission BURSARY user to change their own password', async () => {
    await render(<StaffProfile />);
    const inputs = passwordInputs();
    await setInputValue(inputs[0], 'OldPass123');
    await setInputValue(inputs[1], 'NewPass456');
    await setInputValue(inputs[2], 'NewPass456');
    await clickText('Update Password');

    expect(apiPatchMock).toHaveBeenCalledWith('/auth/change-password', {
      currentPassword: 'OldPass123',
      newPassword: 'NewPass456',
    });
  });
});
