/**
 * SECURITY — authenticated downloads must NEVER carry the JWT in the URL.
 * =============================================================================
 * Regression guard for a token-leak class: several download flows built URLs
 * like `.../export.csv?access_token=<jwt>` and assigned them to an <a href>,
 * which leaks the bearer token into browser history, proxy logs and the
 * Referer header. Every download now goes through the shared authenticated
 * axios client (`services/api.ts`), which attaches `Authorization: Bearer …`
 * and never a query-string token.
 *
 * This suite mocks ONLY the axios transport. The REAL `services/api` client
 * (baseURL + request interceptor + `downloadBlob`), the REAL service modules
 * and the REAL components are exercised on top of it, then asserts:
 *   • every download request URL is free of `access_token=` / `token=`;
 *   • the request interceptor still attaches the Authorization header;
 *   • the response Blob is turned into an object URL and downloaded.
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
  const requestUse = vi.fn();
  const responseUse = vi.fn();
  const instance = {
    get,
    post,
    patch,
    delete: del,
    request,
    defaults: { baseURL: 'http://localhost:3001/api/v1' },
    interceptors: {
      request: { use: requestUse },
      response: { use: responseUse },
    },
  };
  return { get, post, patch, del, request, requestUse, responseUse, instance };
});

vi.mock('axios', () => ({
  __esModule: true,
  default: { create: () => h.instance, isAxiosError: () => false },
}));

// --- framework seams ---------------------------------------------------------
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useLocation: () => ({ pathname: '/admin/receipts', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: any) => React.createElement('a', { href: to }, children),
  Navigate: () => null,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, role: 'ADMIN', permissions: [], firstName: 'A', lastName: 'B' },
    logout: vi.fn(),
  }),
}));

vi.mock('../components/PortalShell', () => ({
  default: ({ children }: any) => React.createElement('div', { 'data-testid': 'portal-shell' }, children),
}));

vi.mock('../components/Modal', () => ({
  default: ({ isOpen, children, footer }: any) =>
    isOpen
      ? React.createElement(
          'div',
          { 'data-testid': 'modal' },
          children,
          React.createElement('div', { 'data-testid': 'modal-footer' }, footer),
        )
      : null,
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

// Real modules under test (axios is the only mocked boundary).
import { downloadBlob } from '../services/api';
import { setAccessToken } from '../utils/tokenStore';
import { downloadAcademicTemplate } from '../services/academicApi';
import { auditApi } from '../services/audit';
import { feeApi } from '../services/adminFees';
import BulkImportModal from '../components/academic/BulkImportModal';
import ReceiptsPage from '../pages/admin/Receipts';

// Captured before any `mockReset`, because the interceptor is registered once at
// module-import time.
const attachToken = h.requestUse.mock.calls[0]?.[0] as ((config: any) => any) | undefined;

const TOKEN = 'test-jwt-token-ABC123';

const blobResponse = () => ({
  data: new Blob(['file-bytes']),
  headers: { 'content-disposition': 'attachment; filename="server.csv"' },
});

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

const clickButton = async (re: RegExp) => {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => re.test(b.textContent || ''));
  if (!btn) throw new Error(`button matching ${re} not found`);
  await act(async () => { (btn as HTMLButtonElement).click(); });
  await flush();
};

/** The URLs actually dispatched to the shared axios client. */
const requestedUrls = (): string[] => h.get.mock.calls.map((c) => String(c[0]));

/** Every request must be free of a JWT embedded in the query string. */
const expectNoTokenInAnyUrl = () => {
  for (const url of requestedUrls()) {
    expect(url).not.toContain('access_token=');
    expect(url).not.toMatch(/(^|[?&])token=/i);
  }
};

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
  h.del.mockReset();

  localStorage.clear();
  // The access token now lives ONLY in the in-memory store — never localStorage.
  setAccessToken(TOKEN);

  h.get.mockImplementation((_url: string, opts?: any) => {
    if (opts?.responseType === 'blob') return Promise.resolve(blobResponse());
    return Promise.resolve({
      data: { status: 'success', data: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 } },
    });
  });
  h.post.mockResolvedValue({ data: { data: {} } });
  h.patch.mockResolvedValue({ data: { data: {} } });
  h.del.mockResolvedValue({ data: { data: {} } });

  (URL as any).createObjectURL = vi.fn(() => 'blob:mock-url');
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  teardown();
});

// ===========================================================================
describe('shared downloadBlob — authenticated, token-free', () => {
  it('uses the shared api client + Authorization header and never a query token', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await downloadBlob('/admin/audit-logs/export.csv', 'fallback.csv');

    // Fetched via the shared client with responseType blob (relative path → baseURL).
    expect(h.get).toHaveBeenCalledWith('/admin/audit-logs/export.csv', { responseType: 'blob' });
    expectNoTokenInAnyUrl();

    // The request interceptor (shared client) attaches the bearer header.
    expect(attachToken).toBeTypeOf('function');
    const set = vi.fn();
    attachToken!({ headers: { set } });
    expect(set).toHaveBeenCalledWith('Authorization', `Bearer ${TOKEN}`);

    // The response Blob is downloaded via a temporary object URL.
    expect((URL as any).createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
  });
});

// ===========================================================================
describe('service download helpers never embed the token', () => {
  it('academic template downloads', async () => {
    await downloadAcademicTemplate('college', 'csv');
    await downloadAcademicTemplate('department', 'xlsx');
    await downloadAcademicTemplate('programme', 'csv');

    expect(h.get).toHaveBeenCalledWith('/academic/faculties/template.csv', { responseType: 'blob' });
    expect(h.get).toHaveBeenCalledWith('/academic/departments/template.xlsx', { responseType: 'blob' });
    expect(h.get).toHaveBeenCalledWith('/academic/programmes/template.csv', { responseType: 'blob' });
    expectNoTokenInAnyUrl();
  });

  it('audit-logs export', async () => {
    await auditApi.exportDownload({ page: 2, limit: 10, action: 'CREATE' });

    expect(h.get).toHaveBeenCalledWith(
      '/admin/audit-logs/export.csv?page=2&limit=10&action=CREATE',
      { responseType: 'blob' },
    );
    expectNoTokenInAnyUrl();
  });

  it('fees bulk-upload errors', async () => {
    await feeApi.downloadUploadErrors('stage-42');

    expect(h.get).toHaveBeenCalledWith('/fees/bulk-upload/stage-42/errors.csv', { responseType: 'blob' });
    expectNoTokenInAnyUrl();
  });
});

// ===========================================================================
describe('component download flows never embed the token', () => {
  it('BulkImportModal downloads errors.csv through the authenticated client', async () => {
    h.post.mockResolvedValue({
      data: {
        data: {
          created: 0,
          skipped: 0,
          errors: [{ row: 1, record: 'BAD', message: 'boom' }],
          ids: [],
          createdItems: [],
          errorsCsvUrl: '/api/v1/academic/_errors/err-1.csv',
        },
      },
    });

    await render(
      React.createElement(BulkImportModal, { kind: 'college', isOpen: true, onClose: vi.fn(), onSuccess: vi.fn() }),
    );

    const input = container.querySelector('#bulk-upload-college') as HTMLInputElement;
    const file = new File(['code,name\nA,B'], 'colleges.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();

    await clickButton(/Import Colleges/);
    await clickButton(/Download errors\.csv/);

    // Base prefix stripped; resolved against the shared client's baseURL.
    expect(h.get).toHaveBeenCalledWith('/academic/_errors/err-1.csv', { responseType: 'blob' });
    expectNoTokenInAnyUrl();
  });

  it('Receipts CSV export uses the authenticated client', async () => {
    await render(
      React.createElement(ReceiptsPage, {
        role: 'ADMIN',
        brand: 'B',
        userText: 'U',
        onLogout: vi.fn(),
      }),
    );

    await clickButton(/CSV export/);

    const exportCall = h.get.mock.calls.find((c) => String(c[0]).startsWith('/admin/receipts/export.csv'));
    expect(exportCall).toBeTruthy();
    expect(exportCall![1]).toEqual({ responseType: 'blob' });
    expectNoTokenInAnyUrl();
  });
});
