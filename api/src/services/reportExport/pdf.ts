import path from 'node:path';
import fs from 'node:fs';

type ReportExportFormat = 'XLSX' | 'PDF';
type ReportType = string;

export interface PdfReportInput {
  reportName: string;
  reportType?: ReportType;
  reportUuid?: string;
  generatedBy: { name: string; email: string };
  dateRange: { start?: Date | string | null; end?: Date | string | null };
  filtersSummary: string;
  filtersRaw?: Record<string, any>;
  summaryHtml: string;
  detailedHtml: string;
  localeTz?: string;
}

export interface PdfExportResult {
  buffer: Buffer;
  reportUuid: string;
  fileSizeBytes: number;
  pageCount: number;
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-NG', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function escapeHtml(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveLogoDataUri(): string {
  try {
    const logoPath = path.resolve(__dirname, '..', '..', '..', 'public', 'branding', 'logo.png');
    if (fs.existsSync(logoPath)) {
      const bytes = fs.readFileSync(logoPath);
      return `data:image/png;base64,${bytes.toString('base64')}`;
    }
  } catch {
    // fall through to empty
  }
  return '';
}

export async function generatePdfReport(input: PdfReportInput): Promise<PdfExportResult> {
  const reportUuid = input.reportUuid ?? '';
  const generatedAt = new Date();
  const generatedAtIso = generatedAt.toISOString();
  const rangeStr = [fmtDate(input.dateRange.start), fmtDate(input.dateRange.end)].join('  →  ');
  const logoDataUri = resolveLogoDataUri();

  const headerLine = `BELLS UNIVERSITY OF TECHNOLOGY | BURSARY DEPARTMENT | ${input.reportName}`;

  let signatureBlockHtml = '';
  if (input.reportType === 'STUDENT_STATEMENT') {
    signatureBlockHtml = `
<div style="page-break-inside: avoid; margin-top: 80pt;">
  <div style="margin-top: 48pt; border-top: 1px solid #666; width: 42%; padding-top: 4pt; font-size: 10pt; color: #333;">
    <div><strong>BURSAR SIGNATURE:</strong> ______________________________</div>
    <div style="margin-top: 12pt; font-size: 9pt; color: #555;">
      Name: ______________________________ &nbsp;&nbsp; Title: ______________________________
    </div>
    <div style="margin-top: 10pt; font-size: 9pt; color: #555;">
      Date: ______________________________ &nbsp;&nbsp; Seal: ▢ Official Bursary Seal
    </div>
    <div style="margin-top: 10pt; font-size: 8pt; color: #777; font-style: italic;">
      This is an official Bells University of Technology Bursary Department statement.
      For enquiries, contact bursary@bellsuniversity.edu.ng.
    </div>
  </div>
</div>`;
  }

  const importPuppeteer = new Function('spec', 'return import(spec)') as any as (spec: string) => Promise<any>;
  const puppeteer = await importPuppeteer('puppeteer');
  const launchArgs: any = {
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--single-process',
    ],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchArgs.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const browser = await puppeteer.launch(launchArgs);
  try {
    const page = await browser.newPage();
    await page.setUserAgent('BellsBursaryReports/1.0 (Puppeteer 25; secure server-side rendering)');

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(input.reportName)} | Bells University Bursary</title>
<style>
  :root { color:#1a1a1a; font-family: 'Times New Roman', Georgia, serif; }
  html, body { background: #fff; color: #111; }
  body { margin: 40pt 36pt 60pt 36pt; font-size: 11pt; line-height: 1.35; color:#111; }

  .brand-row { display: flex; align-items: center; gap: 18pt; margin-bottom: 10pt; border-bottom: 2px solid #0a3d0a; padding-bottom: 12pt; }
  .brand-row .crest { flex: 0 0 auto; width: 64pt; height: 64pt; object-fit: contain; }
  .brand-row .text { flex: 1 1 auto; text-align: center; }
  .brand-row .uni { font-size: 16pt; font-weight: 700; letter-spacing: 0.3pt; color:#0a3d0a; }
  .brand-row .dept { font-size: 13pt; font-weight: 600; color:#111; margin-top: 4pt; }
  .brand-row .motto { font-size: 9pt; color:#555; margin-top: 6pt; font-style: italic; }

  .report-title { font-size: 13pt; text-align: center; margin: 6pt 0 10pt 0; color:#0a3d0a; font-weight: 700; letter-spacing: 0.2pt; }

  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4pt 12pt; margin: 10pt 0 16pt 0; padding: 10pt 14pt; background:#f8f8f6; border:1px solid #ddd; font-size: 10pt; }
  .meta .k { color:#555; font-weight:600; }
  .meta .v { color:#111; word-break: break-word; }

  .section-title { font-size: 12pt; font-weight: 700; color:#0a3d0a; border-bottom: 1px solid #999; padding-bottom: 4pt; margin: 16pt 0 10pt 0; }
  .watermark { position: fixed; right: 20pt; top: 16pt; font-size: 8pt; color:#999; font-family: monospace; z-index: 9999; text-align: right; line-height: 1.3; }
  .watermark strong { color: #b00020; display: block; letter-spacing: 0.5pt; }
  .footer-meta { position: fixed; left: 36pt; bottom: 22pt; right: 36pt; font-size: 8pt; color:#666; display:flex; justify-content: space-between; font-family: monospace; z-index: 9998; }

  table { width: 100%; border-collapse: collapse; margin-top: 6pt; font-size: 10pt; }
  th, td { border: 1px solid #bbb; padding: 4pt 6pt; vertical-align: top; }
  th { background: #0a3d0a; color: #fff; font-weight: 600; text-align: left; }
  tr:nth-child(even) td { background: #f6f7f4; }
  .mono { font-family: monospace; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .money::before { content: '₦'; }
  .page-break { page-break-before: always; }
  .badge { display: inline-block; padding: 2pt 6pt; border-radius: 4pt; background:#0a3d0a; color:#fff; font-size: 9pt; }
  .empty { color:#666; font-style:italic; }

  .filters-list { font-size: 9.5pt; color: #222; }
  .filters-list span.item { display: inline-block; margin: 1pt 6pt 1pt 0; padding: 2pt 6pt; background: #eef3ee; border: 1px solid #c9d6c9; border-radius: 3pt; }
</style>
</head>
<body>
<div class="watermark" title="CONFIDENTIAL — Bursary Department">
  <strong>CONFIDENTIAL</strong>
  BURSARY DEPT
  <span>REPORT-ID: ${escapeHtml(reportUuid)}</span>
</div>

<div class="brand-row">
  ${logoDataUri ? `<img class="crest" src="${logoDataUri}" alt="Bells University Crest" />` : `<div class="crest" style="display:flex;align-items:center;justify-content:center;background:#0a3d0a;color:#fff;font-weight:700;font-size:9pt;text-align:center;border-radius:4pt;">BELLS<br/>CREST</div>`}
  <div class="text">
    <div class="uni">BELLS UNIVERSITY OF TECHNOLOGY</div>
    <div class="dept">BURSARY DEPARTMENT</div>
    <div class="motto">— Excellence in Stewardship —</div>
  </div>
</div>

<div class="report-title">${escapeHtml(headerLine)}</div>

<div class="meta">
  <div><span class="k">Reporting Period:</span> <span class="v">${escapeHtml(rangeStr)}</span></div>
  <div><span class="k">Generated At (ISO):</span> <span class="v mono">${escapeHtml(generatedAtIso)}</span></div>
  <div><span class="k">Generated By:</span> <span class="v">${escapeHtml(input.generatedBy.name)} &lt;${escapeHtml(input.generatedBy.email)}&gt;</span></div>
  <div>
    <span class="k">Applied Filters:</span>
    <span class="v filters-list">
      ${input.filtersSummary
        ? input.filtersSummary.split(' · ').map(part => `<span class="item">${escapeHtml(part)}</span>`).join('')
        : '<em>None (full dataset)</em>'}
    </span>
  </div>
  <div><span class="k">Report UUID:</span> <span class="v mono">${escapeHtml(reportUuid)}</span></div>
  <div><span class="k">Format:</span> <span class="v">PDF · Bells Bursary Reports v1</span></div>
</div>

<div class="section-title">Summary</div>
${input.summaryHtml || '<div class="empty">No summary metrics.</div>'}

<div class="section-title page-break">Detailed</div>
${input.detailedHtml || '<div class="empty">No rows.</div>'}

${signatureBlockHtml}

<div class="footer-meta">
  <span>Bells Bursary Reports  •  Report UUID: ${escapeHtml(reportUuid)}</span>
  <span>Confidential — Authorized Bursary Personnel Only</span>
</div>
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 90_000 });

    const pdfOpts = {
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '56pt', right: '36pt', bottom: '56pt', left: '36pt' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:7pt; color:#666; width:100%; padding: 4pt 36pt; font-family:monospace; border-bottom: 1px solid #ddd;">BELLS UNIVERSITY OF TECHNOLOGY  •  BURSARY DEPARTMENT  •  ${escapeHtml(input.reportName)}  •  Report-ID: ${escapeHtml(reportUuid)}</div>`,
      footerTemplate: `<div style="font-size:7pt; color:#666; width:100%; padding: 4pt 36pt; display:flex; justify-content:space-between; font-family:monospace; border-top: 1px solid #ddd;"><span>Generated ${escapeHtml(generatedAtIso.slice(0, 10))} • UUID ${escapeHtml(reportUuid.slice(0, 12))}…</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    };
    const buf = await page.pdf(pdfOpts);
    await page.close();

    const buffer: Buffer = 'buffer' in buf ? buf : Buffer.from(buf as any);
    return {
      buffer,
      reportUuid,
      fileSizeBytes: buffer.length,
      pageCount: Math.max(1, Math.ceil(buffer.length / 28000)),
    };
  } finally {
    try { await browser.close(); } catch { /* noop */ }
  }
}

export function pdfContentType(): {
  type: ReportExportFormat;
  contentType: string;
  filename: (reportName: string, uuid: string) => string;
} {
  return {
    type: 'PDF' as ReportExportFormat,
    contentType: 'application/pdf',
    filename: (n, u) => `${n.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_')}_${u.slice(0, 8)}.pdf`,
  };
}

export function rowsToTableHtml(
  rows: any[],
  columns: Array<{ key: string; header: string; isNum?: boolean; isMoney?: boolean; isMonospace?: boolean }>,
  opts?: { maxRows?: number; emptyMsg?: string },
): string {
  const cap = opts?.maxRows ?? 15000;
  const safeRows = rows.slice(0, cap);
  const head = `<thead><tr>${columns.map((c) => `<th>${escapeHtml(c.header)}</th>`).join('')}</tr></thead>`;
  if (safeRows.length === 0) {
    return `<table>${head}<tbody><tr><td colspan="${columns.length}" class="empty">${escapeHtml(opts?.emptyMsg || 'No rows in filtered dataset.')}</td></tr></tbody></table>`;
  }
  const body = `<tbody>${safeRows.map((r) => {
    return `<tr>${columns.map((c) => {
      const raw = r?.[c.key];
      let display = '';
      if (raw === null || raw === undefined) display = '';
      else if (raw instanceof Date) display = raw.toISOString().slice(0, 10);
      else if (c.isMoney && typeof raw === 'number') {
        const formatted = Number(raw).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        display = `₦${formatted}`;
      } else if (c.isNum && typeof raw === 'number') {
        display = Number.isInteger(raw) ? String(raw) : Number(raw).toFixed(2);
      } else display = String(raw);
      const isMoneyCls = c.isMoney ? ' money' : '';
      const isNumCls = (c.isMoney || c.isNum) ? ' num' : '';
      const isMonoCls = c.isMonospace ? ' mono' : '';
      const cls = [isMoneyCls, isNumCls, isMonoCls].map(s => s.trim()).filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${escapeHtml(display)}</td>`;
    }).join('')}</tr>`;
  }).join('')}</tbody>`;
  const capNote = rows.length > cap
    ? `<div class="empty" style="margin-top:4pt; font-size:9pt;">Only first ${cap.toLocaleString()} of ${rows.length.toLocaleString()} rows shown in PDF detailed section. Export XLSX for full dataset.</div>`
    : '';
  return `<table>${head}${body}</table>${capNote}`;
}

export function summaryToHtml(summary: Record<string, number | string | undefined | null>): string {
  const entries = Object.entries(summary).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  const rows = entries.map(([k, v]) => {
    const kStr = String(k);
    const isMoney = /(amount|fee|charge|balance|refund|net|gross|billed|paid|outstanding|wallet|collected|expected|due|revenue|debit|credit|variance)$/i.test(kStr) && typeof v === 'number';
    const isNum = typeof v === 'number';
    let displayV: string;
    if (isMoney) {
      displayV = '₦' + Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (isNum && !Number.isInteger(v as number)) {
      displayV = Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else {
      displayV = String(v);
    }
    return `<tr><td style="width:60%;">${escapeHtml(k)}</td><td class="${isNum || isMoney ? 'num' : ''}">${escapeHtml(displayV)}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function buildFiltersSummaryString(f: Record<string, any>): string {
  const parts: string[] = [];
  const keys = ['dateFrom', 'dateTo', 'provider', 'session', 'semester', 'level', 'collegeId', 'departmentId', 'programmeId', 'feeCategoryId', 'feeId', 'studentId', 'paymentStatus', 'reconciliationStatus'];
  const labels: Record<string, string> = {
    dateFrom: 'From', dateTo: 'To', provider: 'Provider', session: 'Session',
    semester: 'Semester', level: 'Level', collegeId: 'College', departmentId: 'Dept',
    programmeId: 'Programme', feeCategoryId: 'Category', feeId: 'Bill', studentId: 'Student',
    paymentStatus: 'Tx Status', reconciliationStatus: 'Recon Status',
  };
  for (const k of keys) {
    if (f[k] === undefined || f[k] === null || f[k] === '') continue;
    const v = f[k] instanceof Date ? fmtDate(f[k]) : String(f[k]);
    parts.push(`${labels[k] ?? k}=${v}`);
  }
  return parts.join(' · ');
}
