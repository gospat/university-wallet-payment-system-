/**
 * SECURITY — two-factor authentication (TOTP) frontend contract.
 * =============================================================================
 * Regression guards for the second-factor surfaces added for Request M:
 *
 *   • `MfaChallengeStep`  — the shared login second-factor step. A verified code
 *     must hand the freshly minted session to the host page via `onVerified`;
 *     a REJECTED code must NOT (no session may be installed on a failed 401).
 *   • `MfaEnrollmentPanel` — self-service enrolment. Setup must render the
 *     otpauth URI as a QR + manual key; the one-time recovery codes are shown
 *     after enabling; and an account whose role REQUIRES a factor must never be
 *     offered a "Turn off" control.
 *   • `MfaEnrollmentGate` — the blocking gate fails OPEN on a probe error (the
 *     server enforces the boundary) and ONLY blocks when the API reports
 *     `required && !enabled`.
 *
 * Only the axios transport and the framework seams are mocked; the REAL
 * components and the REAL `services/api` client are exercised on top of them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// --- axios transport mock (the single network boundary) ----------------------
const h = vi.hoisted(() => {
  const get = vi.fn();
  const post = vi.fn();
  const patch = vi.fn();
  const del = vi.fn();
  const request = vi.fn();
  const instance = {
    get,
    post,
    patch,
    delete: del,
    request,
    defaults: { baseURL: 'http://localhost:3001/api/v1' },
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  // Mutable auth seam shared by the gate + login-page suites.
  const auth: {
    token: string | null;
    user: any;
    login: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  } = {
    token: null,
    user: null,
    login: vi.fn(),
    logout: vi.fn(),
  };
  const navigate = vi.fn();
  return { get, post, patch, del, request, instance, auth, navigate };
});

vi.mock('axios', () => ({
  __esModule: true,
  default: { create: () => h.instance, isAxiosError: () => false },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => h.navigate,
  useLocation: () => ({ pathname: '/login', search: '', hash: '', state: undefined }),
  Link: ({ children, to }: any) => React.createElement('a', { href: to }, children),
  Navigate: () => null,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => h.auth,
}));

vi.mock('../components/ui/UniversityLogo', () => ({
  default: () => React.createElement('div', { 'data-testid': 'logo' }),
}));

// Keep the QR renderer light while still capturing the value it was handed, so
// we can assert the real otpauth URI reaches the QR code.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: any) =>
    React.createElement('svg', { 'data-testid': 'mfa-qr', 'data-value': value }),
}));

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const out: Record<string, any> = {};
  for (const key of Object.keys(actual)) {
    if (key === 'default' || key === '__esModule') continue;
    out[key] = () => null;
  }
  return out;
});

// Real modules under test.
import MfaChallengeStep from '../components/security/MfaChallengeStep';
import MfaEnrollmentPanel from '../components/security/MfaEnrollmentPanel';
import MfaEnrollmentGate from '../components/security/MfaEnrollmentGate';
import StudentLogin from '../pages/auth/StudentLogin';

// --- DOM harness -------------------------------------------------------------
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

const text = () => container.textContent || '';

const clickButton = async (re: RegExp) => {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => re.test(b.textContent || ''));
  if (!btn) throw new Error(`button matching ${re} not found`);
  await act(async () => { (btn as HTMLButtonElement).click(); });
  await flush();
};

const findButton = (re: RegExp) =>
  Array.from(container.querySelectorAll('button')).find((b) => re.test(b.textContent || ''));

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })); });
};

const submitForm = async (form: HTMLFormElement) => {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
};

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
  h.del.mockReset();
  h.auth.token = null;
  h.auth.user = null;
  h.auth.login.mockReset();
  h.auth.logout.mockReset();
  h.navigate.mockReset();

  h.get.mockResolvedValue({ data: { data: {} } });
  h.post.mockResolvedValue({ data: { data: {} } });
});

afterEach(() => {
  teardown();
});

// ===========================================================================
describe('MfaChallengeStep — second factor mints the session only on success', () => {
  it('hands the verified session to onVerified', async () => {
    h.post.mockResolvedValue({
      data: {
        status: 'success',
        token: 'session-token-1',
        accessToken: 'session-token-1',
        expiresInMs: 900_000,
        data: { user: { id: 7, role: 'STUDENT' } },
      },
    });
    const onVerified = vi.fn();

    await render(
      React.createElement(MfaChallengeStep, {
        challengeToken: 'ct-123',
        onVerified,
        onBack: vi.fn(),
      }),
    );

    await setInputValue(
      container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement,
      '123456',
    );
    await submitForm(container.querySelector('form') as HTMLFormElement);

    expect(h.post).toHaveBeenCalledWith('/auth/mfa/challenge', {
      challengeToken: 'ct-123',
      code: '123456',
    });
    expect(onVerified).toHaveBeenCalledTimes(1);
    expect(onVerified).toHaveBeenCalledWith({
      token: 'session-token-1',
      user: { id: 7, role: 'STUDENT' },
      expiresInMs: 900_000,
    });
  });

  it('does NOT start a session when the code is rejected (401)', async () => {
    h.post.mockRejectedValue({ response: { data: { message: 'Invalid or expired code.' } } });
    const onVerified = vi.fn();

    await render(
      React.createElement(MfaChallengeStep, {
        challengeToken: 'ct-123',
        onVerified,
        onBack: vi.fn(),
      }),
    );

    await setInputValue(
      container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement,
      '000000',
    );
    await submitForm(container.querySelector('form') as HTMLFormElement);

    expect(onVerified).not.toHaveBeenCalled();
    expect(text()).toContain('Invalid or expired code.');
  });

  it('surfaces the session-mint failure when the server omits a token', async () => {
    h.post.mockResolvedValue({ data: { status: 'success', data: { user: { id: 7 } } } });
    const onVerified = vi.fn();

    await render(
      React.createElement(MfaChallengeStep, {
        challengeToken: 'ct-123',
        onVerified,
        onBack: vi.fn(),
      }),
    );

    await setInputValue(
      container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement,
      '123456',
    );
    await submitForm(container.querySelector('form') as HTMLFormElement);

    expect(onVerified).not.toHaveBeenCalled();
    expect(text()).toContain('Verification succeeded but the session could not be started.');
  });
});

// ===========================================================================
describe('MfaEnrollmentPanel — enrolment, recovery codes and required-role lock', () => {
  const status = (over: Partial<Record<string, unknown>> = {}) => ({
    data: {
      data: {
        enabled: false,
        enrolledAt: null,
        recoveryCodesRemaining: 0,
        required: true,
        enforcement: 'staff',
        ...over,
      },
    },
  });

  it('offers setup for an enforced-but-unenrolled account', async () => {
    h.get.mockResolvedValue(status());

    await render(React.createElement(MfaEnrollmentPanel));

    expect(text()).toContain('Set up two-factor authentication');
    expect(text()).toContain('Required for your role before you can continue.');
  });

  it('renders the otpauth URI as a QR + manual key during setup', async () => {
    h.get.mockResolvedValue(status());
    const otpauthUrl = 'otpauth://totp/Bells:staff?secret=ABCDEF234567&issuer=Bells';
    h.post.mockResolvedValue({
      data: {
        data: {
          secret: 'ABCDEF234567',
          otpauthUrl,
          issuer: 'Bells University Payment Portal',
          digits: 6,
          period: 30,
        },
      },
    });

    await render(React.createElement(MfaEnrollmentPanel));
    await clickButton(/Set up two-factor authentication/);

    expect(h.post).toHaveBeenCalledWith('/auth/mfa/setup', {});
    const qr = container.querySelector('[data-testid="mfa-qr"]') as HTMLElement;
    expect(qr).toBeTruthy();
    // The QR must encode the REAL otpauth URI, not a placeholder.
    expect(qr.getAttribute('data-value')).toBe(otpauthUrl);
    // Manual fallback key, grouped in fours.
    expect(text()).toContain('ABCD EF23 4567');
  });

  it('shows the one-time recovery codes after the factor is enabled', async () => {
    h.get.mockResolvedValue(status());
    h.post.mockImplementation((url: string) => {
      if (url === '/auth/mfa/setup') {
        return Promise.resolve({
          data: {
            data: {
              secret: 'AAAA1111BBBB2222',
              otpauthUrl: 'otpauth://totp/x?secret=AAAA1111BBBB2222',
              issuer: 'Bells',
              digits: 6,
              period: 30,
            },
          },
        });
      }
      if (url === '/auth/mfa/enable') {
        return Promise.resolve({
          data: { data: { recoveryCodes: ['AAAA-1111', 'BBBB-2222', 'CCCC-3333'] } },
        });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    const onEnabled = vi.fn();

    await render(React.createElement(MfaEnrollmentPanel, { onEnabled }));
    await clickButton(/Set up two-factor authentication/);

    const codeInput = container.querySelector('#mfa-enable-code') as HTMLInputElement;
    await setInputValue(codeInput, '654321');
    await submitForm(container.querySelector('form') as HTMLFormElement);

    expect(h.post).toHaveBeenCalledWith('/auth/mfa/enable', { code: '654321' });
    expect(text()).toContain('Save your recovery codes');
    expect(text()).toContain('AAAA-1111');
    expect(text()).toContain('BBBB-2222');
    expect(text()).toContain('CCCC-3333');
    expect(text()).toContain('They will not be shown again.');

    // Dismissing the one-time view acknowledges and unblocks the host.
    await clickButton(/I have saved these codes/);
    expect(onEnabled).toHaveBeenCalledTimes(1);
  });

  it('never offers "Turn off" when the role requires a factor', async () => {
    h.get.mockResolvedValue(status({ enabled: true, required: true, recoveryCodesRemaining: 8 }));

    await render(React.createElement(MfaEnrollmentPanel));

    expect(text()).toContain('Required for your role — cannot be turned off.');
    expect(findButton(/Turn off/)).toBeUndefined();
    // Regeneration stays available regardless of enforcement.
    expect(findButton(/Regenerate recovery codes/)).toBeTruthy();
  });

  it('offers "Turn off" for an unenforced account', async () => {
    h.get.mockResolvedValue(status({ enabled: true, required: false, recoveryCodesRemaining: 8 }));

    await render(React.createElement(MfaEnrollmentPanel));

    expect(findButton(/Turn off/)).toBeTruthy();
    expect(text()).not.toContain('Required for your role — cannot be turned off.');
  });
});

// ===========================================================================
describe('MfaEnrollmentGate — blocks only when the server reports required & !enabled', () => {
  const child = React.createElement('div', { 'data-testid': 'portal' }, 'portal');

  it('replaces the app with the enrolment screen when required and not enrolled', async () => {
    h.auth.token = 'access-token';
    h.auth.user = { id: 3, role: 'BURSARY' };
    h.get.mockResolvedValue({ data: { data: { enabled: false, required: true } } });

    await render(React.createElement(MfaEnrollmentGate, null, child));

    expect(container.querySelector('[data-testid="portal"]')).toBeNull();
    expect(text()).toContain('Action required — secure your account');
  });

  it('renders children once the factor is enrolled', async () => {
    h.auth.token = 'access-token';
    h.auth.user = { id: 3, role: 'BURSARY' };
    h.get.mockResolvedValue({ data: { data: { enabled: true, required: true } } });

    await render(React.createElement(MfaEnrollmentGate, null, child));

    expect(container.querySelector('[data-testid="portal"]')).toBeTruthy();
  });

  it('fails OPEN when the status probe errors (server still enforces the boundary)', async () => {
    h.auth.token = 'access-token';
    h.auth.user = { id: 3, role: 'BURSARY' };
    h.get.mockRejectedValue(new Error('network down'));

    await render(React.createElement(MfaEnrollmentGate, null, child));

    expect(container.querySelector('[data-testid="portal"]')).toBeTruthy();
  });

  it('renders children without probing when there is no session', async () => {
    h.auth.token = null;
    h.auth.user = null;

    await render(React.createElement(MfaEnrollmentGate, null, child));

    expect(container.querySelector('[data-testid="portal"]')).toBeTruthy();
    expect(h.get).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe('StudentLogin — password step swaps to the second factor, then signs in', () => {
  it('collects the TOTP code and installs the session on success', async () => {
    h.post.mockImplementation((url: string) => {
      if (url === '/auth/login') {
        return Promise.resolve({
          data: {
            status: 'success',
            mfaRequired: true,
            challengeToken: 'ct-9',
            data: { user: { id: 7, role: 'STUDENT', firstName: 'A', lastName: 'B' } },
          },
        });
      }
      if (url === '/auth/mfa/challenge') {
        return Promise.resolve({
          data: {
            status: 'success',
            token: 'session-token-9',
            accessToken: 'session-token-9',
            data: { user: { id: 7, role: 'STUDENT', firstName: 'A', lastName: 'B' } },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    await render(React.createElement(StudentLogin));

    await setInputValue(
      container.querySelector('input[autocomplete="username"]') as HTMLInputElement,
      'BU20CSC1001',
    );
    await setInputValue(
      container.querySelector('input[autocomplete="current-password"]') as HTMLInputElement,
      'correct horse battery staple',
    );
    await submitForm(container.querySelector('form') as HTMLFormElement);

    // The password form is replaced by the second-factor step in the same card.
    expect(text()).toContain('Two-factor verification');
    expect(h.auth.login).not.toHaveBeenCalled();

    await setInputValue(
      container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement,
      '246810',
    );
    await submitForm(container.querySelector('form') as HTMLFormElement);

    expect(h.post).toHaveBeenCalledWith('/auth/mfa/challenge', {
      challengeToken: 'ct-9',
      code: '246810',
    });
    expect(h.auth.login).toHaveBeenCalledWith(
      'session-token-9',
      expect.objectContaining({ id: 7, role: 'STUDENT' }),
    );
    expect(h.navigate).toHaveBeenCalledWith('/student/dashboard', { replace: true });
  });

  it('returns to the password form when the challenge fails', async () => {
    h.post.mockImplementation((url: string) => {
      if (url === '/auth/login') {
        return Promise.resolve({
          data: {
            status: 'success',
            mfaRequired: true,
            challengeToken: 'ct-9',
            data: { user: { id: 7, role: 'STUDENT' } },
          },
        });
      }
      return Promise.reject({ response: { data: { message: 'Code rejected.' } } });
    });

    await render(React.createElement(StudentLogin));

    await setInputValue(
      container.querySelector('input[autocomplete="username"]') as HTMLInputElement,
      'BU20CSC1001',
    );
    await setInputValue(
      container.querySelector('input[autocomplete="current-password"]') as HTMLInputElement,
      'correct horse battery staple',
    );
    await submitForm(container.querySelector('form') as HTMLFormElement);

    await setInputValue(
      container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement,
      '000000',
    );
    await submitForm(container.querySelector('form') as HTMLFormElement);

    expect(h.auth.login).not.toHaveBeenCalled();
    expect(text()).toContain('Code rejected.');

    // "Back to login" restores the credential form (a failed code consumes the
    // single-use challenge token, so the user must re-authenticate).
    await clickButton(/Back to login/);
    expect(text()).toContain('Student Portal');
  });
});
