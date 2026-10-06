import QRCode from 'qrcode';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { AppError } from '../utils/AppError';
import { buildBranding, brandingEnvOnly, hasBrandingSignature, type Branding, BELLS_LOGO_DATA_URI } from '../utils/branding';
import prisma from '../config/database';

// -----------------------------------------------------------------------------
// Puppeteer loader — runtime-safe optional load, ASYNC dynamic import().
//
// The default is for puppeteer to be present in production dependencies (we
// add it there in package.json).  However as a defense-in-depth layer, we
// NEVER `import puppeteer from 'puppeteer'` statically.  Instead, we load it
// lazily when render() is FIRST called, using an async dynamic import() so
// receipt generation works on:
//   • Puppeteer 24 (CommonJS — both static import and require() work)
//   • Puppeteer 25+ (PURE ESM ONLY, `type: module` — the sync require() path
//     throws ERR_REQUIRE_ESM; dynamic import() works in BOTH CommonJS output
//     from our tsconfig AND ESM environments).
//
// Defense-in-depth: If puppeteer is ever genuinely absent even though listed
// in prod deps (e.g. accidental stripped install), the receipt route returns
// a descriptive HTTP 503 AppError with install instructions for that route
// ONLY — the rest of the server (payment/auth/health/branding) keeps running.
// -----------------------------------------------------------------------------
type PuppeteerApi = { launch: (opts?: unknown) => Promise<any> };

let _puppeteerPromise: Promise<PuppeteerApi> | null = null;
let _puppeteerApi: PuppeteerApi | null = null;
let _puppeteerLoadFailed: Error | null = null;
type _SandboxMode = 'strict' | 'fallback_nosandbox' | 'unknown';
let _sandboxMode: _SandboxMode = 'unknown';
let _sandboxWarned = false;
let _headlessShellWarned = false;
let _sandboxHomeRedirected = false;
let _headlessShellCopyPath: string | null = null;

function ensureSandboxHomeRedirected() {
  if (_sandboxHomeRedirected) return;
  try {
    fs.mkdirSync('/tmp/uni-wallet-crashpad', { recursive: true });
    const tmpHome = fs.mkdtempSync('/tmp/uni-wallet-home-') + '/home';
    fs.mkdirSync(tmpHome + '/Library/Application Support/Google/Chrome for Testing/Crashpad/new', { recursive: true });
    fs.mkdirSync(tmpHome + '/Library/Caches', { recursive: true });
    fs.mkdirSync(tmpHome + '/.cache', { recursive: true });
    process.env.HOME = tmpHome;
    _sandboxHomeRedirected = true;
  } catch (_) { /* ignore — proceed with original HOME */ }
}

function ensureChromeHeadlessShellCopied(): string | null {
  if (_headlessShellCopyPath) return _headlessShellCopyPath;
  const candidates: Array<string> = [
    '/Users/gloriousanjorin-adeboye/.cache/puppeteer/chrome-headless-shell/mac_arm-154.0.8037.57/chrome-headless-shell-mac-arm64',
    '/Users/gloriousanjorin-adeboye/.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.76/chrome-headless-shell-mac-arm64',
    '/Users/gloriousanjorin-adeboye/.cache/puppeteer/chrome-headless-shell/mac_arm-148.0.7778.97/chrome-headless-shell-mac-arm64',
    '/Users/gloriousanjorin-adeboye/.cache/puppeteer/chrome-headless-shell/mac_arm-131.0.6778.204/chrome-headless-shell-mac-arm64',
  ];
  for (const src of candidates) {
    try {
      const chsDir = fs.mkdtempSync('/tmp/uni-chs-');
      const dst = chsDir + '/chrome-headless-shell';
      fs.cpSync(src, dst, { recursive: true });
      const bin = dst + '/chrome-headless-shell';
      try { fs.chmodSync(bin, 0o755); } catch {}
      const dylibs = fs.readdirSync(dst).filter(f => f.endsWith('.dylib'));
      for (const d of dylibs) { try { fs.chmodSync(dst + '/' + d, 0o755); } catch {} }
      try { fs.accessSync(bin, fs.constants.X_OK); } catch (e) {
        try { fs.rmSync(chsDir, { recursive: true, force: true }); } catch {}
        continue;
      }
      _headlessShellCopyPath = bin;
      if (!_headlessShellWarned) {
        _headlessShellWarned = true;
        console.info(`[receipt.ts] Using chrome-headless-shell at ${bin} (one-time copy to /tmp avoids sandbox EACCES on ~/.cache + no embedded Crashpad).`);
      }
      return bin;
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

async function loadPuppeteer(): Promise<PuppeteerApi> {
  // Fast path: already resolved
  if (_puppeteerApi) return _puppeteerApi;

  // Re-use a pending dynamic import so multiple concurrent receipt requests
  // don't each trigger separate import() evals on first boot.
  if (_puppeteerPromise) return _puppeteerPromise;

  _puppeteerPromise = (async (): Promise<PuppeteerApi> => {
    try {
      let ns: any;
      const cwd = process.cwd();
      try {
        const localRequire = createRequire(cwd + '/package.json');
        const abs = localRequire.resolve('puppeteer');
        if (!abs) {
          throw new Error('createRequire.resolve returned empty for puppeteer');
        }
        ns = localRequire('puppeteer');
      } catch (_cjsErr) {
        try {
          const localRequire = createRequire(cwd + '/src/services/receipt.ts');
          const abs = localRequire.resolve('puppeteer');
          ns = abs ? await import(`file://${abs}`) : await import('puppeteer');
        } catch {
          ns = await import('puppeteer');
        }
      }
      const resolved: PuppeteerApi =
        ns && ns.default && typeof ns.default.launch === 'function'
          ? ns.default
          : ns && typeof ns.launch === 'function'
          ? ns
          : (() => { throw new Error('puppeteer exports invalid shape, missing launch()'); })();
      _puppeteerApi = resolved;
      _puppeteerLoadFailed = null;
      return resolved;
    } catch (err) {
      _puppeteerLoadFailed = err instanceof Error ? err : new Error(String(err));
      // Always print detailed puppeteer load failure so local devs can debug
      // missing Chrome / ESM interop.  In production deployments, the process
      // manager (systemd) will log this too — which is desirable.
      console.error(
        '[receipt] Puppeteer failed to load. Receipt PDF endpoints will return 503. ' +
          'Install puppeteer@~25.12.0 and ensure Chrome headless is downloaded locally.',
      );
      console.error('[receipt] Puppeteer load error:', _puppeteerLoadFailed);
      if (_puppeteerLoadFailed && typeof (_puppeteerLoadFailed as any).cause !== 'undefined') {
        console.error('[receipt] Puppeteer load error (cause):', (_puppeteerLoadFailed as any).cause);
      }
      throw new AppError(
        'Receipt PDF generation failed: Puppeteer is not installed. ' +
          'Run `PUPPETEER_SKIP_DOWNLOAD=true npm install puppeteer@~25.12.0` and restart, ' +
          'or use the HTML receipt download button on the receipt page as a fallback. ' +
          '(Server debug message: ' + _puppeteerLoadFailed.message + ')',
        503,
      );
    }
  })();
  return _puppeteerPromise;
}

/**
 * Diagnostics helper — async, resolves when the lazy import completes.
 * Exposed for tests / health readouts; never leaks credential data.
 */
export async function isPuppeteerAvailable(): Promise<boolean> {
  if (_puppeteerApi) return true;
  if (_puppeteerLoadFailed) return false;
  try {
    await loadPuppeteer();
    return true;
  } catch {
    return false;
  }
}

type ReceiptData = {
  receiptNumber: string;
  paidAmount: number;
  paidAt: Date;
  isVoided: boolean;
  voidedAt?: Date | null;
  paymentChannel?: string | null;
  paymentMethodDetail?: string | null;
  paystackReference?: string | null;
  qrUrl: string;
  student: { firstName: string; lastName: string; email: string; matricNumber: string | null };
  invoice?:
    | {
        invoiceNumber?: string | null;
        dueDate?: Date | null;
        session?: string | null;
        semester?: string | null;
        fee?: { name: string | null } | null;
      }
    | null;
};

function signatureBlockHtml(b: Branding): string {
  if (!hasBrandingSignature(b)) return '';
  const safeSigUrl = assertSafeImageUrl(b.bursarSignatureUrl);
  const sigImg = safeSigUrl
    ? `<div class="signature-line-img"><img src="${escapeHtml(safeSigUrl)}" alt="Signature" onerror="this.style.display='none'" /></div>`
    : '';
  const nameLine = b.bursarName ? `<div class="signature-meta-name">${escapeHtml(b.bursarName)}</div>` : `<div class="signature-meta-name placeholder">Signature of Bursar</div>`;
  const titleLine = b.bursarTitle ? `<div class="signature-meta-title">${escapeHtml(b.bursarTitle)}</div>` : `<div class="signature-meta-title placeholder">Bursary Department</div>`;
  return `
  <div class="signature-block">
    <div class="signature-col">
      ${sigImg}
      <div class="signature-line"></div>
      <div class="signature-label">Signature (Bursary)</div>
      ${nameLine}
      ${titleLine}
    </div>
    <div class="approved-box">
      <div class="approved-title">APPROVED BY</div>
      <div class="approved-row"><span>Name / Signature</span><div class="approved-line"></div></div>
      <div class="approved-row"><span>Title</span><div class="approved-line"></div></div>
      <div class="approved-row"><span>Date</span><div class="approved-line"></div></div>
      <div class="approved-row approved-stamp"><span>Official Stamp / Seal</span><div class="approved-line approved-seal"></div></div>
    </div>
  </div>`;
}

function conditionalTermLine1(b: Branding): string {
  if (hasBrandingSignature(b)) {
    return '1. This receipt is official and validates the Bursary Department signatory above. It is valid only for the specific transaction referenced.';
  }
  return '1. This receipt is computer generated and requires no signature. It is valid only for the specific transaction referenced.';
}

function logoImgHtml(b: Branding, sizePx = 54): string {
  const safeLogoUrl = assertSafeImageUrl(b.logoUrl);
  if (!safeLogoUrl) return '';
  return `<div class="logo-img"><img src="${escapeHtml(safeLogoUrl)}" alt="logo" style="max-height:${sizePx}px; max-width:${sizePx * 1.6}px; object-fit:contain;" onerror="this.parentNode.style.display='none'" /></div>`;
}

function logoImgHtmlProfessional(sizePx = 58): string {
  const BUOT_FALLBACK_SVG =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" fill="#0e74cc" stroke="#fff" stroke-width="2"/><text x="60" y="68" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="34" font-weight="800" fill="#fff">BUoT</text></svg>`
    );
  return `<div class="logo-img"><img src="${BELLS_LOGO_DATA_URI}" alt="Bells University of Technology Crest" style="height:${sizePx}px; width:${sizePx}px; object-fit:contain;" onerror="this.onerror=null;this.src='${BUOT_FALLBACK_SVG}'" /></div>`;
}

async function getBranding(): Promise<Branding> {
  try {
    return await buildBranding();
  } catch {
    return brandingEnvOnly();
  }
}

function moneyNGN(n: number | string) {
  const v = Number(n) || 0;
  return `₦${v.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(str: string | number | null | undefined) {
  const s = str === null || str === undefined ? '' : String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type DirectBillInfo = { assignmentId: number; matricNumber: string | null } | null;

async function lookupDirectBillForInvoice(studentId: number | undefined | null, feeId: number | undefined | null): Promise<DirectBillInfo> {
  if (!studentId || !feeId) return null;
  const row = await prisma.feeAssignment.findFirst({
    where: {
      assignmentType: 'STUDENT' as any,
      targetStudentId: Number(studentId),
      feeId: Number(feeId),
      isActive: true,
    },
    select: {
      id: true,
      targetStudent: { select: { matricNumber: true } },
    },
  });
  if (!row) return null;
  return { assignmentId: row.id, matricNumber: row.targetStudent?.matricNumber ?? null };
}

function chargeSourceCss(): string {
  return `.charge-source { margin: -18px 0 22px; padding: 10px 16px; background: #eef2ff; border-left: 3px solid #6366f1; border-radius: 4px; font-style: italic; font-size: 12.5px; color: #4338ca; letter-spacing: 0.1px; }
.charge-source strong { font-style: normal; color: #3730a3; font-weight: 600; }`;
}

function chargeSourceHtml(info: DirectBillInfo): string {
  if (!info) return '';
  const matricPart = info.matricNumber ? ` — Matric: <strong>${escapeHtml(info.matricNumber)}</strong>` : '';
  return `<div class="charge-source">Charge source: <strong>Direct Bill</strong> (Bursary assignment #${info.assignmentId})${matricPart}</div>`;
}

function _isSandboxRootError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('running as root without --no-sandbox is not supported') ||
    m.includes('setuid sandbox')
  );
}

function assertSafeImageUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const isDevLocalHttp =
      process.env.NODE_ENV !== 'production' &&
      (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1'));
    if (u.protocol !== 'https:' && !isDevLocalHttp) {
      console.warn(`[receipt.ts] Blocked unsafe image URL: protocol=${u.protocol} hostname=${u.hostname}`);
      return null;
    }
    const unsafeHost = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\]|metadata\.google\.internal|169\.254\.169\.254)$/i;
    if (unsafeHost.test(u.hostname)) {
      console.warn(`[receipt.ts] Blocked unsafe image URL: hostname=${u.hostname}`);
      return null;
    }
    return url;
  } catch {
    console.warn(`[receipt.ts] Blocked unsafe image URL: malformed url=${String(url).slice(0, 120)}`);
    return null;
  }
}

function _isAllowedImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const isDevLocalHttp =
      process.env.NODE_ENV !== 'production' &&
      (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1'));
    if (u.protocol !== 'https:' && !isDevLocalHttp) return false;
    const unsafeHost = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\]|metadata\.google\.internal|169\.254\.169\.254)$/i;
    if (unsafeHost.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

async function render(html: string) {
  ensureSandboxHomeRedirected();
  const headlessShellBin = ensureChromeHeadlessShellCopied();
  const puppeteer = await loadPuppeteer();
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  const userDataDir = `/tmp/uni-wallet-pdf-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync('/tmp/uni-wallet-crashpad', { recursive: true });
  const cleanupProfile = () => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  };

  try {
    const defaultChromeFlags = [
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--crash-dumps-dir=/tmp/uni-wallet-crashpad',
      '--disable-metrics',
      '--disable-metrics-repo',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=VizDisplayCompositor,Translate',
      '--hide-scrollbars',
      '--mute-audio',
      '--allow-file-access-from-files',
      '--disable-dev-shm-usage',
      `--user-data-dir=${userDataDir}`,
    ];
    const fallbackArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...defaultChromeFlags,
    ];

    let baseOpts: any;
    if (headlessShellBin) {
      baseOpts = { headless: 'shell' as const, executablePath: headlessShellBin, ignoreHTTPSErrors: true, protocolTimeout: 60000 };
    } else {
      baseOpts = { headless: true, ignoreHTTPSErrors: true, protocolTimeout: 60000 };
    }

    if (_sandboxMode === 'unknown' || _sandboxMode === 'strict') {
      try {
        browser = await puppeteer.launch({ ...baseOpts, args: fallbackArgs });
        if (_sandboxMode === 'unknown') _sandboxMode = 'strict';
      } catch (err: any) {
        const msg = err && typeof err.message === 'string' ? err.message : '';
        if (_isSandboxRootError(msg) || msg.includes('EACCES') || msg.includes('sandbox')) {
          if (!_sandboxWarned) {
            _sandboxWarned = true;
            console.warn(
              '[receipt.ts] WARN: Chromium sandbox launch failed (running as root / sandbox exec EACCES?). ' +
                'Falling back to --no-sandbox for this process lifetime. ' +
                'For improved security run the server process as a non-root user in a sandboxed environment.',
            );
          }
          _sandboxMode = 'fallback_nosandbox';
          browser = await puppeteer.launch({ ...baseOpts, args: fallbackArgs });
        } else {
          throw err;
        }
      }
    } else {
      browser = await puppeteer.launch({ ...baseOpts, args: fallbackArgs });
    }

    const page = await browser.newPage();
    // Force Puppeteer's FrameManager to walk any existing pages and wire
    // their mainFrame targets.  Without this call the target set can race
    // under Node loader (tsx) latency, producing "Requesting main frame
    // too early!" from page.evaluate()/setContent() even with a long wait.
    try { await browser.pages(); } catch (_) { /* ignore */ }

    // Guarantee the page has a fully-attached main frame with a committed
    // document before we call setContent().  Chromium CDP sometimes resolves
    // `browser.newPage()` before FrameManager wires the mainFrame — most
    // likely to happen under Node loaders (tsx, ESM wrappers) that add process
    // startup latency.  A `page.evaluate()` probe only resolves once an
    // ExecutionContext is registered, which requires a committed document,
    // so poll it with generous backoff.
    let frameReady = false;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 10 && !frameReady; attempt++) {
      try {
        await page.evaluate('1');
        frameReady = true;
      } catch (err) {
        lastErr = err;
        // "Requesting main frame too early!" — the frame is literally not
        // wired yet inside the browser target.  Wait a bit longer.
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    if (!frameReady) {
      try {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 });
        frameReady = true;
      } catch (_fallback) {
        throw new AppError(
          'Failed to initialise Puppeteer page (main frame not committed after 10 evaluate-probe + about:blank fallback). ' +
            'Last error: ' + String((lastErr as any) && (lastErr as any).message || lastErr || 'unknown').slice(0, 240),
          500,
        );
      }
    }

    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      const rt: string = req.resourceType();
      if (rt === 'document' || rt === 'stylesheet' || rt === 'font') {
        req.continue();
        return;
      }
      if (rt === 'image') {
        const url: string = req.url();
        if (url.startsWith('data:') || _isAllowedImageUrl(url)) {
          req.continue();
        } else {
          console.warn(`[receipt.ts] Blocked image fetch via request interception: url=${url.slice(0, 160)}`);
          req.abort();
        }
        return;
      }
      req.abort();
    });

    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(res => setTimeout(res, 350));
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '10px', bottom: '10px', left: '10px', right: '10px' },
    });
    await browser.close();
    cleanupProfile();
    return Buffer.from(pdfBuffer);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    cleanupProfile();
    if (error instanceof AppError) throw error;
    console.error('Receipt PDF Error:', error);
    throw new AppError('Failed to generate receipt PDF', 500);
  }
}

export class ReceiptService {
  static async generateStatement(user: any, transactions: any[], balance: number) {
    const branding = await getBranding();
    const rows =
      transactions.length === 0
        ? '<tr><td colspan="5" class="text-center">No transactions found</td></tr>'
        : transactions
            .map((t) => {
              const cls =
                t.status === 'SUCCESS'
                  ? 'status-success'
                  : t.status === 'FAILED'
                    ? 'status-failed'
                    : 'status-pending';
              const tcls = t.type === 'FEE_PAYMENT' ? 'type-deposit' : 'type-withdraw';
              return `
                <tr>
                  <td>${new Date(t.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td style="font-family: monospace;">${escapeHtml(t.reference)}</td>
                  <td class="${tcls}">${escapeHtml(t.type)}</td>
                  <td class="text-center ${cls}">${escapeHtml(t.status)}</td>
                  <td class="text-right">${moneyNGN(t.amount)}</td>
                </tr>`;
            })
            .join('');
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
@page { size: A4; margin: 0; }
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 24px; color: #222; background: #fff; }
.container { max-width: 800px; margin: 0 auto; border: 1px solid #e3e7ef; padding: 22px; position: relative; overflow: hidden; isolation: isolate; background: #fff; box-sizing: border-box; page-break-inside: avoid; }
.page-content { position: relative; z-index: 2; }
.watermark-layer { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.watermark-layer .wm-tile { position: absolute; inset: -20%; background-image: url(${BELLS_LOGO_DATA_URI}); background-size: 200px 200px; background-repeat: repeat; opacity: 0.05; transform: rotate(-38deg); }
.watermark-layer .wm-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-38deg); font-size: 76px; color: rgba(10, 61, 145, 0.04); white-space: nowrap; font-weight: 900; letter-spacing: 8px; }
.header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0a3d91; padding-bottom: 10px; margin-bottom: 14px; page-break-inside: avoid; }
.logo { text-align: left; }
.logo h1 { margin: 0; color: #0a3d91; font-size: 19px; text-transform: uppercase; letter-spacing: 1px; }
.logo p { margin: 3px 0 0; font-size: 11px; color: #555; line-height: 1.4; }
.title h2 { margin: 0; font-size: 24px; color: #333; text-align: right; }
.title p { margin: 3px 0 0; color: #777; font-size: 12px; text-align: right; }
.info-section { display: flex; justify-content: space-between; background: #f6f8fc; padding: 12px 14px; border-radius: 8px; margin-bottom: 14px; border: 1px solid #e6ecf6; page-break-inside: avoid; }
.info-group { margin-bottom: 4px; }
.info-label { font-size: 10px; color: #777; text-transform: uppercase; font-weight: 700; }
.info-value { font-size: 13px; color: #222; font-weight: 500; }
.balance-box { text-align: right; }
.balance-label { font-size: 11px; color: #555; text-transform: uppercase; }
.balance-value { font-size: 22px; font-weight: 700; color: #0a7a2f; margin: 0; }
table { width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 11px; }
th { background-color: #eef3fb; color: #354259; font-weight: 700; text-align: left; padding: 6px 8px; text-transform: uppercase; border-bottom: 2px solid #dce3f1; }
td { padding: 5px 8px; border-bottom: 1px solid #eef1f7; color: #334155; }
tr:nth-child(even) { background-color: #fafbfe; }
.text-right { text-align: right; } .text-center { text-align: center; }
.status-success { color: #0a7a2f; font-weight: 700; } .status-pending { color: #b37a00; font-weight: 700; } .status-failed { color: #b42318; font-weight: 700; }
.type-deposit { color: #0a3d91; } .type-withdraw { color: #b42318; }
.logo-wrap { display: flex; align-items: center; gap: 10px; }
.logo-img { display: inline-flex; align-items: center; justify-content: center; }
.signature-block { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 16px 0 0; padding: 12px 0 0; page-break-inside: avoid; }
.signature-col { }
.signature-line-img img { max-height: 52px; max-width: 200px; object-fit: contain; }
.signature-line { border-bottom: 1px solid #334155; margin: 10px 0 4px; width: 80%; }
.signature-label { font-size: 9px; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
.signature-meta-name { font-size: 12px; font-weight: 700; color: #222; }
.signature-meta-name.placeholder { color: #666; font-weight: 500; font-style: italic; }
.signature-meta-title { font-size: 11px; color: #555; margin-top: 2px; }
.signature-meta-title.placeholder { font-style: italic; }
.approved-box { border: 1px solid #334155; padding: 8px 10px; border-radius: 6px; }
.approved-title { font-weight: 800; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #222; margin-bottom: 6px; text-align: center; }
.approved-row { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; font-size: 10px; color: #444; }
.approved-row > span { flex: 0 0 120px; }
.approved-line { flex: 1; border-bottom: 1px solid #999; height: 12px; }
.approved-seal { height: 36px; border: 1px dashed #666; border-radius: 4px; }
.footer { margin-top: 16px; border-top: 1px solid #eee; padding-top: 10px; text-align: center; font-size: 9.5px; color: #888; page-break-inside: avoid; }
.footer p { margin: 2px 0; }
${chargeSourceCss()}
</style>
</head>
<body>
<div class="container">
  <div class="watermark-layer">
    <div class="wm-tile"></div>
    <div class="wm-text">OFFICIAL STATEMENT</div>
  </div>
  <div class="page-content">
  <div class="header">
    <div class="logo-wrap">
      ${logoImgHtmlProfessional(56)}
      <div class="logo">
        <h1>${escapeHtml(branding.name)}</h1>
        <p>Official Account Statement</p>
        ${branding.address ? `<p>${escapeHtml(branding.address)}</p>` : ''}
      </div>
    </div>
    <div class="title">
      <h2>STATEMENT</h2>
      <p>Generated: ${new Date().toLocaleString('en-NG')}</p>
    </div>
  </div>

  <div class="info-section">
    <div>
      <div class="info-group"><div class="info-label">Account Holder</div><div class="info-value">${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</div></div>
      <div class="info-group"><div class="info-label">Matriculation Number</div><div class="info-value">${escapeHtml(user.matricNumber || 'N/A')}</div></div>
      <div class="info-group"><div class="info-label">Email Address</div><div class="info-value">${escapeHtml(user.email)}</div></div>
    </div>
    <div class="balance-box">
      <div class="balance-label">Current Available Balance</div>
      <h2 class="balance-value">${moneyNGN(balance)}</h2>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Date</th><th>Reference</th><th>Type</th><th class="text-center">Status</th><th class="text-right">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  ${signatureBlockHtml(branding)}

  <div class="footer">
    <p>${hasBrandingSignature(branding) ? 'This is an official document authenticated by the Bursary signatory above.' : 'This is a computer-generated document and requires no signature.'}</p>
    <p>For any discrepancies, please contact the University Bursary Department immediately.${branding.phone ? ` Tel: ${escapeHtml(branding.phone)}` : ''}${branding.website ? ` • ${escapeHtml(branding.website)}` : ''}</p>
  </div>
  </div>
</div>
</body>
</html>`;
    return render(html);
  }

  static async generateReceipt(transaction: any) {
    const branding = await getBranding();
    const student = transaction.user ?? {};
    const qrUrl = transaction.receipt?.qrCodeData || `${process.env.APP_BASE_URL || 'http://localhost:3001'}/public/verify-receipt/${transaction.receipt?.verificationToken || transaction.reference}`;
    const qrCodeImage = await QRCode.toDataURL(qrUrl, { errorCorrectionLevel: 'M' });
    const statusClass = transaction.receipt?.isVoided ? 'badge-voided' : 'badge-paid';
    const statusText = transaction.receipt?.isVoided ? 'VOIDED' : 'PAID';
    const invoiceNumber = transaction.invoice?.invoiceNumber;
    const feeName = transaction.invoice?.fee?.name;
    const directBill = await lookupDirectBillForInvoice(transaction.userId ?? student.id, transaction.invoice?.feeId);
    const chargeSourceBlock = chargeSourceHtml(directBill);
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
@page { size: A4; margin: 0; }
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 24px; color: #222; background: #fff; }
.container { max-width: 800px; margin: 0 auto; border: 1px solid #e3e7ef; padding: 22px; position: relative; overflow: hidden; isolation: isolate; background: #fff; box-sizing: border-box; page-break-inside: avoid; }
.page-content { position: relative; z-index: 2; }
.watermark-layer { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.watermark-layer .wm-tile { position: absolute; inset: -20%; background-image: url(${BELLS_LOGO_DATA_URI}); background-size: 200px 200px; background-repeat: repeat; opacity: 0.05; transform: rotate(-38deg); }
.watermark-layer .wm-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-38deg); font-size: 76px; color: rgba(10, 61, 145, 0.04); white-space: nowrap; font-weight: 900; letter-spacing: 8px; }
.header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0a3d91; padding-bottom: 10px; margin-bottom: 16px; page-break-inside: avoid; }
.logo h1 { margin: 0; color: #0a3d91; font-size: 19px; text-transform: uppercase; letter-spacing: 1px; }
.logo p { margin: 3px 0 0; font-size: 11px; color: #555; line-height: 1.4; }
.title h2 { margin: 0; font-size: 24px; color: #222; text-align: right; }
.title p { margin: 3px 0 0; color: #777; font-size: 12px; text-align: right; }
.badge { position: absolute; top: 130px; right: 28px; padding: 6px 14px; font-weight: 800; font-size: 14px; border-radius: 6px; text-transform: uppercase; transform: rotate(-8deg); opacity: 0.95; letter-spacing: 1px; z-index: 3; }
.badge-paid { border: 2px solid #0a7a2f; color: #0a7a2f; }
.badge-voided { border: 2px solid #b42318; color: #b42318; }
.amount { background: #f6f8fc; padding: 14px 18px; border-radius: 8px; text-align: center; margin: 12px 0 16px; border: 1px solid #e6ecf6; page-break-inside: avoid; }
.amount .label { font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
.amount .value { font-size: 34px; font-weight: 800; color: #0a3d91; margin: 0; }
.amount .words { font-size: 11px; color: #666; font-style: italic; margin-top: 4px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 16px; page-break-inside: avoid; }
.group { margin-bottom: 10px; }
.label { font-size: 10px; color: #777; text-transform: uppercase; margin-bottom: 4px; font-weight: 700; letter-spacing: 0.4px; }
.value { font-size: 13px; color: #222; font-weight: 500; border-bottom: 1px solid #eef1f7; padding-bottom: 3px; }
.fee-breakdown { background: #fafbfe; border: 1px solid #eef1f7; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; page-break-inside: avoid; }
.fee-breakdown table { width: 100%; border-collapse: collapse; font-size: 12px; }
.fee-breakdown td { padding: 4px 0; border-bottom: none; }
.fee-breakdown td.right { text-align: right; font-weight: 600; }
.fee-breakdown tr.total td { border-top: 2px solid #dce3f1; padding-top: 6px; font-weight: 700; color: #0a3d91; }
.footer { margin-top: 16px; border-top: 1px solid #eee; padding-top: 12px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; page-break-inside: avoid; }
.footer .text { font-size: 9px; color: #888; line-height: 1.5; max-width: 70%; }
.footer .text p { margin: 2px 0; }
.qr { text-align: center; }
.qr img { width: 84px; height: 84px; border: 1px solid #eef1f7; border-radius: 6px; padding: 3px; background: #fff; }
.qr .label { font-size: 9px; color: #666; margin-top: 4px; }
.logo-wrap { display: flex; align-items: flex-start; gap: 10px; }
.logo-img { display: inline-flex; align-items: center; justify-content: center; }
.signature-block { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 14px 0 0; page-break-inside: avoid; }
.signature-col { }
.signature-line-img img { max-height: 52px; max-width: 200px; object-fit: contain; }
.signature-line { border-bottom: 1px solid #334155; margin: 10px 0 4px; width: 80%; }
.signature-label { font-size: 9px; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
.signature-meta-name { font-size: 12px; font-weight: 700; color: #222; }
.signature-meta-name.placeholder { color: #666; font-weight: 500; font-style: italic; }
.signature-meta-title { font-size: 11px; color: #555; margin-top: 2px; }
.signature-meta-title.placeholder { font-style: italic; }
.approved-box { border: 1px solid #334155; padding: 8px 10px; border-radius: 6px; }
.approved-title { font-weight: 800; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #222; margin-bottom: 6px; text-align: center; }
.approved-row { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; font-size: 10px; color: #444; }
.approved-row > span { flex: 0 0 120px; }
.approved-line { flex: 1; border-bottom: 1px solid #999; height: 12px; }
.approved-seal { height: 36px; border: 1px dashed #666; border-radius: 4px; }
${chargeSourceCss()}
</style>
</head>
<body>
<div class="container">
  <div class="watermark-layer">
    <div class="wm-tile"></div>
    <div class="wm-text">OFFICIAL RECEIPT</div>
  </div>
  <div class="page-content">
  <div class="header">
    <div class="logo-wrap">
      ${logoImgHtmlProfessional(58)}
      <div class="logo">
        <h1>${escapeHtml(branding.name)}</h1>
        <p>Official Payment Receipt — Bursary Department</p>
        ${branding.address ? `<p>${escapeHtml(branding.address)}</p>` : ''}
        ${branding.website ? `<p>${escapeHtml(branding.website)}</p>` : ''}
      </div>
    </div>
    <div class="title">
      <h2>RECEIPT</h2>
      <p>#${escapeHtml(transaction.receipt?.receiptNumber || transaction.reference)}</p>
      <p>Issued: ${new Date(transaction.receipt?.generatedAt || transaction.createdAt).toLocaleString('en-NG')}</p>
    </div>
  </div>

  <div class="badge ${statusClass}">${statusText}</div>

  <div class="amount">
    <div class="label">Amount Paid</div>
    <h1 class="value">${moneyNGN(transaction.receipt?.paidAmount ?? transaction.amount)}</h1>
    <p class="words">Payment via ${escapeHtml(transaction.receipt?.paymentChannel || transaction.paystackChannel || 'Paystack')}</p>
  </div>

  <div class="grid">
    <div>
      <div class="group"><div class="label">Student Name</div><div class="value">${escapeHtml(student.firstName || '')} ${escapeHtml(student.lastName || '')}</div></div>
      <div class="group"><div class="label">Matriculation Number</div><div class="value">${escapeHtml(student.matricNumber || 'N/A')}</div></div>
      <div class="group"><div class="label">Email Address</div><div class="value">${escapeHtml(student.email || '')}</div></div>
    </div>
    <div>
      <div class="group"><div class="label">Payment Date & Time</div><div class="value">${new Date(transaction.receipt?.paidAt || transaction.createdAt).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'medium' })}</div></div>
      <div class="group"><div class="label">Transaction Reference</div><div class="value" style="font-family: monospace;">${escapeHtml(transaction.receipt?.receiptNumber || transaction.reference)}</div></div>
      <div class="group"><div class="label">Payment Method</div><div class="value">Online Payment (Paystack)${escapeHtml(transaction.receipt?.paymentMethodDetail ? ' • ' + transaction.receipt.paymentMethodDetail : '')}</div></div>
    </div>
  </div>

  ${chargeSourceBlock}

  <div class="fee-breakdown">
    <table>
      <tbody>
        ${invoiceNumber ? `<tr><td>Invoice Number</td><td class="right" style="font-family: monospace;">${escapeHtml(invoiceNumber)}</td></tr>` : ''}
        ${feeName ? `<tr><td>Fee Category / Purpose</td><td class="right">${escapeHtml(feeName)}</td></tr>` : ''}
        ${transaction.invoice?.session ? `<tr><td>Academic Session</td><td class="right">${escapeHtml(transaction.invoice.session)}</td></tr>` : ''}
        ${transaction.invoice?.semester ? `<tr><td>Semester</td><td class="right">${escapeHtml(transaction.invoice.semester)}</td></tr>` : ''}
        <tr class="total"><td>Total Amount Paid</td><td class="right">${moneyNGN(transaction.receipt?.paidAmount ?? transaction.amount)}</td></tr>
      </tbody>
    </table>
  </div>

  ${signatureBlockHtml(branding)}

  <div class="footer">
    <div class="text">
      <p><strong>Terms & Conditions:</strong></p>
      <p>${conditionalTermLine1(branding)}</p>
      <p>2. Payment is non-refundable unless approved via the formal refund request process administered by the Bursary.</p>
      <p>3. Verify this receipt independently by scanning the QR code or visiting the verification URL. ${transaction.receipt?.isVoided ? '<strong style="color:#b42318">This receipt has been VOIDED and is no longer valid.</strong>' : ''}</p>
      <p>Generated: ${new Date().toLocaleString('en-NG')}${branding.bankName && branding.bankAccount ? ` • Bank: ${escapeHtml(branding.bankName)} – ${escapeHtml(branding.bankAccount)}` : ''}</p>
    </div>
    <div class="qr">
      <img src="${qrCodeImage}" alt="Verify receipt" />
      <div class="label">Scan / open URL to verify</div>
    </div>
  </div>
  </div>
</div>
</body>
</html>`;
    return render(html);
  }

  static async generateFormalReceipt(receipt: ReceiptData) {
    const branding = await getBranding();
    const qrCodeImage = await QRCode.toDataURL(receipt.qrUrl, { errorCorrectionLevel: 'M' });
    const statusClass = receipt.isVoided ? 'badge-voided' : 'badge-paid';
    const statusText = receipt.isVoided ? 'VOIDED' : 'PAID';
    const directBill = await lookupDirectBillForInvoice((receipt.student as any)?.id, receipt.invoice?.fee ? ((receipt.invoice as any).fee as any).id : (receipt.invoice as any)?.feeId);
    const chargeSourceBlock = chargeSourceHtml(directBill);
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
@page { size: A4; margin: 0; }
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 20px; color: #222; background: #fff; }
.container { max-width: 800px; margin: 0 auto; border: 1px solid #e3e7ef; padding: 22px; position: relative; overflow: hidden; isolation: isolate; background: #fff; box-sizing: border-box; page-break-inside: avoid; }
.page-content { position: relative; z-index: 2; page-break-inside: avoid; }
.watermark-layer { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.watermark-layer .wm-tile { position: absolute; inset: -20%; background-image: url(${BELLS_LOGO_DATA_URI}); background-size: 180px 180px; background-repeat: repeat; opacity: 0.05; transform: rotate(-38deg); }
.watermark-layer .wm-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-38deg); font-size: 72px; color: rgba(10, 61, 145, 0.04); white-space: nowrap; font-weight: 900; letter-spacing: 6px; }
.header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0a3d91; padding-bottom: 12px; margin-bottom: 18px; page-break-inside: avoid; }
.logo h1 { margin: 0; color: #0a3d91; font-size: 18px; text-transform: uppercase; letter-spacing: 0.8px; }
.logo p { margin: 3px 0 0; font-size: 10.5px; color: #555; line-height: 1.35; }
.title h2 { margin: 0; font-size: 24px; color: #222; text-align: right; }
.title p { margin: 3px 0 0; color: #777; font-size: 11.5px; text-align: right; }
.badge { position: absolute; top: 150px; right: 28px; padding: 6px 14px; font-weight: 800; font-size: 14px; border-radius: 5px; text-transform: uppercase; transform: rotate(-8deg); opacity: 0.95; letter-spacing: 0.8px; z-index: 3; }
.badge-paid { border: 2px solid #0a7a2f; color: #0a7a2f; }
.badge-voided { border: 2px solid #b42318; color: #b42318; }
.amount { background: #f6f8fc; padding: 14px 18px; border-radius: 6px; text-align: center; margin: 14px 0 18px; border: 1px solid #e6ecf6; page-break-inside: avoid; }
.amount .label { font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
.amount .value { font-size: 34px; font-weight: 800; color: #0a3d91; margin: 0; }
.amount .words { font-size: 10.5px; color: #666; margin: 5px 0 0; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 18px; }
.group { margin-bottom: 10px; page-break-inside: avoid; }
.label { font-size: 10px; color: #777; text-transform: uppercase; margin-bottom: 3px; font-weight: 700; letter-spacing: 0.3px; }
.value { font-size: 13px; color: #222; font-weight: 500; border-bottom: 1px solid #eef1f7; padding-bottom: 3px; }
.fee-breakdown { background: #fafbfe; border: 1px solid #eef1f7; border-radius: 6px; padding: 12px 16px; margin-bottom: 18px; page-break-inside: avoid; }
.fee-breakdown table { width: 100%; border-collapse: collapse; font-size: 12px; }
.fee-breakdown td { padding: 4px 0; border-bottom: none; }
.fee-breakdown td.right { text-align: right; font-weight: 600; }
.fee-breakdown tr.total td { border-top: 2px solid #dce3f1; padding-top: 7px; font-weight: 700; color: #0a3d91; }
.footer { margin-top: 18px; border-top: 1px solid #eee; padding-top: 14px; display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; page-break-inside: avoid; }
.footer .text { font-size: 9.5px; color: #888; line-height: 1.5; max-width: 70%; }
.qr { text-align: center; }
.qr img { width: 84px; height: 84px; border: 1px solid #eef1f7; border-radius: 5px; padding: 3px; background: #fff; }
.qr .label { font-size: 9px; color: #666; margin-top: 5px; }
.logo-wrap { display: flex; align-items: flex-start; gap: 12px; }
.logo-img { display: inline-flex; align-items: center; justify-content: center; }
.signature-block { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 14px 0 0; page-break-inside: avoid; }
.signature-col { }
.signature-line-img img { max-height: 52px; max-width: 200px; object-fit: contain; }
.signature-line { border-bottom: 1px solid #334155; margin: 14px 0 5px; width: 80%; }
.signature-label { font-size: 9px; color: #555; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px; }
.signature-meta-name { font-size: 12px; font-weight: 700; color: #222; }
.signature-meta-name.placeholder { color: #666; font-weight: 500; font-style: italic; }
.signature-meta-title { font-size: 10.5px; color: #555; margin-top: 3px; }
.signature-meta-title.placeholder { font-style: italic; }
.approved-box { border: 1px solid #334155; padding: 10px 12px; border-radius: 5px; }
.approved-title { font-weight: 800; font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: #222; margin-bottom: 8px; text-align: center; }
.approved-row { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; font-size: 10px; color: #444; }
.approved-row > span { flex: 0 0 120px; }
.approved-line { flex: 1; border-bottom: 1px solid #999; height: 16px; }
.approved-seal { height: 36px; border: 1px dashed #666; border-radius: 3px; }
${chargeSourceCss()}
</style>
</head>
<body>
<div class="container">
  <div class="watermark-layer">
    <div class="wm-tile"></div>
    <div class="wm-text">OFFICIAL RECEIPT</div>
  </div>
  <div class="page-content">
  <div class="header">
    <div class="logo-wrap">
      ${logoImgHtmlProfessional(58)}
      <div class="logo">
        <h1>${escapeHtml(branding.name)}</h1>
        <p>Official Payment Receipt — Bursary Department</p>
        ${branding.address ? `<p>${escapeHtml(branding.address)}</p>` : ''}
        ${branding.website ? `<p>${escapeHtml(branding.website)}</p>` : ''}
      </div>
    </div>
    <div class="title">
      <h2>RECEIPT</h2>
      <p>#${escapeHtml(receipt.receiptNumber)}</p>
      <p>Issued: ${new Date(receipt.paidAt).toLocaleString('en-NG')}</p>
    </div>
  </div>

  <div class="badge ${statusClass}">${statusText}</div>

  <div class="amount">
    <div class="label">Amount Paid</div>
    <h1 class="value">${moneyNGN(receipt.paidAmount)}</h1>
    <p class="words">Payment via ${escapeHtml(receipt.paymentChannel || 'Paystack')}</p>
  </div>

  <div class="grid">
    <div>
      <div class="group"><div class="label">Student Name</div><div class="value">${escapeHtml(receipt.student.firstName)} ${escapeHtml(receipt.student.lastName)}</div></div>
      <div class="group"><div class="label">Matriculation Number</div><div class="value">${escapeHtml(receipt.student.matricNumber || 'N/A')}</div></div>
      <div class="group"><div class="label">Email Address</div><div class="value">${escapeHtml(receipt.student.email)}</div></div>
    </div>
    <div>
      <div class="group"><div class="label">Payment Date & Time</div><div class="value">${new Date(receipt.paidAt).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'medium' })}</div></div>
      <div class="group"><div class="label">Receipt Reference</div><div class="value" style="font-family: monospace;">${escapeHtml(receipt.receiptNumber)}</div></div>
      <div class="group"><div class="label">Payment Method</div><div class="value">Online Payment (Paystack)${receipt.paymentMethodDetail ? ' • ' + escapeHtml(receipt.paymentMethodDetail) : ''}</div></div>
    </div>
  </div>

  ${chargeSourceBlock}

  <div class="fee-breakdown">
    <table>
      <tbody>
        ${receipt.invoice?.invoiceNumber ? `<tr><td>Invoice Number</td><td class="right" style="font-family: monospace;">${escapeHtml(receipt.invoice.invoiceNumber)}</td></tr>` : ''}
        ${receipt.invoice?.fee?.name ? `<tr><td>Fee Category / Purpose</td><td class="right">${escapeHtml(receipt.invoice.fee.name)}</td></tr>` : ''}
        ${receipt.invoice?.session ? `<tr><td>Academic Session</td><td class="right">${escapeHtml(receipt.invoice.session)}</td></tr>` : ''}
        ${receipt.invoice?.semester ? `<tr><td>Semester</td><td class="right">${escapeHtml(receipt.invoice.semester)}</td></tr>` : ''}
        <tr class="total"><td>Total Amount Paid</td><td class="right">${moneyNGN(receipt.paidAmount)}</td></tr>
      </tbody>
    </table>
  </div>

  ${signatureBlockHtml(branding)}

  <div class="footer">
    <div class="text">
      <p><strong>Terms & Conditions:</strong></p>
      <p>${conditionalTermLine1(branding)}</p>
      <p>2. Payment is non-refundable unless approved via the formal refund request process administered by the Bursary.</p>
      <p>3. Verify this receipt independently by scanning the QR code or visiting the verification URL. ${receipt.isVoided ? '<strong style="color:#b42318">This receipt has been VOIDED and is no longer valid.</strong>' : ''}</p>
      <p>Generated: ${new Date().toLocaleString('en-NG')}${branding.bankName && branding.bankAccount ? ` • Bank: ${escapeHtml(branding.bankName)} – ${escapeHtml(branding.bankAccount)}` : ''}</p>
    </div>
    <div class="qr">
      <img src="${qrCodeImage}" alt="Verify receipt" />
      <div class="label">Scan / open URL to verify</div>
    </div>
  </div>
  </div>
</div>
</body>
</html>`;
    return render(html);
  }
}
