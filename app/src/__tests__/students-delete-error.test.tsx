import { it, expect, beforeEach, afterEach, vi, describe } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/admin/students', search: '' }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Link: ({ children, to }: any) => React.createElement('a', { href: to }, children),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, email: 'admin@uni.edu.ng', firstName: 'Admin', lastName: 'User', permissions: ['MANAGE_USERS'] },
    logout: vi.fn(),
  }),
}));

vi.mock('../i18n/en', () => ({
  i18n: {
    errors: { generic: 'Something went wrong.' },
    dashboard: {
      admin: {
        addStudentSuccess: 'Student created',
        addStudentFailed: 'Failed to add student',
        collegePlaceholder: 'College',
        departmentPlaceholder: 'Department',
      },
      bursary: {},
    },
    portals: {
      admin: { dashboardBrand: 'Admin Portal', dashboardGreeting: (n: string) => `Admin: ${n}` },
      bursary: { dashboardBrand: 'Bursary Portal', dashboardGreeting: (n: string) => `Bursary: ${n}` },
    },
  },
  students: {
    filterCollege: 'College',
    filterDepartment: 'Department',
    uploadParseError: 'Upload parse error',
  },
  statusLabels: { ACTIVE: 'Active', SUSPENDED: 'Suspended', WITHDRAWN: 'Withdrawn', GRADUATED: 'Graduated', PENDING: 'Pending' },
  studentTypes: {},
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

// ConfirmAction mock: immediately invokes onConfirm when isOpen is true,
// so we don't need to simulate button clicks inside the modal.
vi.mock('../components/ConfirmAction', () => ({
  default: ({ isOpen, onConfirm }: any) => {
    React.useEffect(() => {
      if (isOpen && onConfirm) {
        act(() => { onConfirm({}); });
      }
    }, [isOpen, onConfirm]);
    return isOpen ? React.createElement('div', { 'data-testid': 'confirm-action' }) : null;
  },
}));

vi.mock('lucide-react', () => {
  const icons = [
    'Copy', 'Eye', 'EyeOff', 'RefreshCw', 'CheckCircle2', 'Loader2', 'XCircle',
    'AlertTriangle', 'GraduationCap', 'ShieldAlert', 'Key', 'Lock', 'Send', 'Trash2',
  ];
  const out: any = {};
  icons.forEach((n) => { out[n] = () => null; });
  return out;
});

const apiDeleteMock = vi.fn();
const apiGetMock = vi.fn();

vi.mock('../services/api', () => ({
  __esModule: true,
  default: {
    get: (...args: any[]) => apiGetMock(...args),
    delete: (...args: any[]) => apiDeleteMock(...args),
  },
  navCounters: vi.fn().mockResolvedValue({}),
  downloadBlob: vi.fn(),
}));

vi.mock('../services/academicApi', () => ({
  programmesApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../services/adminApi', () => ({
  emailResendCredentialsApi: { resend: vi.fn() },
}));

import StudentsPage from '../pages/admin/Students';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(StudentsPage, {
        role: 'ADMIN',
        brand: 'Admin Portal',
        userText: 'Admin: Test',
        onLogout: vi.fn(),
        goBack: vi.fn(),
        dashboardTo: '/admin/dashboard',
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

const sampleStudents = [
  {
    id: 500,
    email: 'student500@uni.edu.ng',
    firstName: 'Test',
    lastName: 'Student500',
    matricNumber: 'MAT500',
    accountStatus: 'ACTIVE',
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  apiGetMock.mockReset();
  apiDeleteMock.mockReset();
  apiGetMock.mockResolvedValue({
    data: { data: { items: sampleStudents, total: 1, page: 1, pageSize: 50, pageCount: 1 } },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Admin Students — delete error handling (normalized payload)', () => {
  it('renders the students table with a Delete button', async () => {
    render();
    await flush();
    const text = container.textContent || '';
    expect(text).toContain('MAT500');
    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Delete'),
    );
    expect(deleteBtn).toBeTruthy();
  });

  it('shows the dedicated financial-records message + breakdown for STUDENT_HAS_FINANCIAL_RECORDS', async () => {
    // Simulate the shared api client's normalized error contract:
    // err.payload holds the original backend response body.
    apiDeleteMock.mockRejectedValue({
      message: 'Request failed with status code 409',
      statusCode: 409,
      payload: {
        status: 'fail',
        code: 'STUDENT_HAS_FINANCIAL_RECORDS',
        error: 'This student cannot be permanently deleted because financial or billing records exist.',
        breakdown: ['3 invoice(s)', '1 receipt(s)'],
      },
    });
    render();
    await flush();
    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Delete'),
    );
    act(() => { deleteBtn!.click(); });
    await flush();
    const text = container.textContent || '';
    expect(text).toContain('Cannot delete — financial records exist');
    expect(text).toContain('Suspend or withdraw the student account instead.');
    // Breakdown from the normalized payload must be surfaced.
    expect(text).toContain('3 invoice(s)');
    expect(text).toContain('1 receipt(s)');
  });

  it('falls back to err.response.data when payload is absent (non-normalized client)', async () => {
    apiDeleteMock.mockRejectedValue({
      message: 'Request failed with status code 409',
      response: {
        status: 409,
        data: {
          status: 'fail',
          code: 'STUDENT_HAS_FINANCIAL_RECORDS',
          error: 'This student cannot be permanently deleted because financial or billing records exist.',
          breakdown: ['2 transaction(s)'],
        },
      },
    });
    render();
    await flush();
    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Delete'),
    );
    act(() => { deleteBtn!.click(); });
    await flush();
    const text = container.textContent || '';
    expect(text).toContain('Cannot delete — financial records exist');
    expect(text).toContain('2 transaction(s)');
  });

  it('shows a generic delete-failed message for non-financial errors', async () => {
    apiDeleteMock.mockRejectedValue({
      message: 'Request failed with status code 500',
      payload: { status: 'error', error: 'Internal server error' },
    });
    render();
    await flush();
    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Delete'),
    );
    act(() => { deleteBtn!.click(); });
    await flush();
    const text = container.textContent || '';
    expect(text).toContain('Delete failed');
    expect(text).toContain('Internal server error');
    expect(text).not.toContain('Cannot delete — financial records exist');
  });

  it('does NOT disable Delete for students with numeric IDs 1 or 2', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        data: {
          items: [
            { id: 1, email: 's1@uni.edu.ng', firstName: 'One', lastName: 'Student', matricNumber: 'MAT001', accountStatus: 'ACTIVE' },
            { id: 2, email: 's2@uni.edu.ng', firstName: 'Two', lastName: 'Student', matricNumber: 'MAT002', accountStatus: 'ACTIVE' },
          ],
          total: 2, page: 1, pageSize: 50, pageCount: 1,
        },
      },
    });
    render();
    await flush();
    const deleteBtns = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent?.includes('Delete'),
    );
    // Both students (IDs 1 and 2) must have an enabled Delete button.
    expect(deleteBtns.length).toBe(2);
    deleteBtns.forEach((b) => expect(b.disabled).toBe(false));
  });
});
