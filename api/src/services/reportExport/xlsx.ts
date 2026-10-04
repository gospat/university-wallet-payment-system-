import { MAX_EXPORT_ROWS } from '../reports/aggregates';
import { buildFiltersSummaryString } from './pdf';

type ReportExportFormat = 'XLSX' | 'PDF';
type ReportType = string;

const ExcelJS: any = require('exceljs');

export interface XlsxSheetConfig {
  sheetName: string;
  columns: Array<{ header: string; key: string; width?: number; numFmt?: string; isDate?: boolean; isMoney?: boolean }>;
  summary?: Record<string, number | string>;
  filters?: Record<string, any>;
  rowsPromise: (yieldCap: number) => Promise<Array<Record<string, any>>>;
}

export interface XlsxExportResult {
  buffer: Buffer;
  rowCount: number;
  fileSizeBytes: number;
  reportUuid: string;
}

const MONEY_FMT = '₦#,##0.00;[Red]-₦#,##0.00';
const DATE_FMT = 'yyyy-mm-dd hh:mm';
const NUMBER_FMT = '#,##0.00';

function sanitizeCellValue(raw: any): any {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'bigint') return Number(raw);
  if (raw instanceof Date) return raw;
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  if (typeof raw === 'number') {
    if (Number.isFinite(raw)) return raw;
    return Number(raw) || 0;
  }
  return raw;
}

function isMoneyKey(k: string): boolean {
  return /(_amt|_pct|amount|fee|charge|balance|refund|net|gross|collectionPct|paid|due|outstanding|collected|expected|debit|credit|variance)$/i.test(k);
}
function isDateKey(k: string): boolean {
  return /(date|at|time)$/i.test(k);
}

export async function generateXlsxReport(
  reportName: string,
  sheets: XlsxSheetConfig[],
  opts?: { reportUuid?: string; reportType?: ReportType },
): Promise<XlsxExportResult> {
  const reportUuid = opts?.reportUuid ?? '';
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'University Payment Platform';
  workbook.created = new Date();
  workbook.modified = new Date();
  let totalRows = 0;
  const firstSheet = sheets[0];

  // =========================================================================
  // SHEET 1 — Summary (header metrics + filter snapshot)
  // =========================================================================
  const summaryWs = workbook.addWorksheet('Summary', {
    properties: { defaultRowHeight: 18, defaultColWidth: 36 },
  });
  summaryWs.columns = [
    { header: 'Field', key: 'k', width: 42, style: { font: { name: 'Calibri', size: 11, bold: true } } },
    { header: 'Value', key: 'v', width: 60, style: { font: { name: 'Calibri', size: 11 } } },
  ];
  summaryWs.getRow(1).font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  summaryWs.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A3D0A' } };
  summaryWs.getRow(1).height = 30;

  const headerBlock: Array<{ k: string; v: any }> = [
    { k: 'Institution', v: 'BELLS UNIVERSITY OF TECHNOLOGY' },
    { k: 'Department', v: 'BURSARY DEPARTMENT' },
    { k: 'Report Name', v: reportName },
    { k: 'Report Type', v: opts?.reportType ?? '' },
    { k: 'Report UUID', v: reportUuid },
    { k: 'Generated At', v: new Date() },
    { k: 'Row Cap Applied', v: `MAX_EXPORT_ROWS = ${MAX_EXPORT_ROWS.toLocaleString()}` },
  ];
  for (const row of headerBlock) {
    const safeRow = { k: sanitizeCellValue(row.k), v: sanitizeCellValue(row.v) };
    const excelRow = summaryWs.addRow(safeRow);
    if (row.k === 'Generated At') {
      excelRow.getCell(2).numFmt = DATE_FMT;
    }
  }

  summaryWs.addRow({ k: '── Applied Filters ──', v: '' });
  const filters = firstSheet?.filters ?? {};
  const filtersStr = buildFiltersSummaryString(filters);
  if (filtersStr) {
    const pairs = filtersStr.split(' · ');
    for (const p of pairs) {
      const [eqL, eqR] = p.split('=');
      summaryWs.addRow({
        k: sanitizeCellValue(`  Filter · ${eqL ?? ''}`),
        v: sanitizeCellValue(eqR ?? ''),
      });
    }
  } else {
    summaryWs.addRow({
      k: sanitizeCellValue('  Filter Set'),
      v: sanitizeCellValue('No filters applied (full dataset)'),
    });
  }

  if (firstSheet?.summary && Object.keys(firstSheet.summary).length > 0) {
    summaryWs.addRow({ k: '', v: '' });
    summaryWs.addRow({
      k: sanitizeCellValue('── Summary Metrics ──'),
      v: sanitizeCellValue(''),
    });
    const titleRowIdx = summaryWs.rowCount;
    const titleRow = summaryWs.getRow(titleRowIdx);
    titleRow.font = { bold: true, color: { argb: 'FF0A3D0A' } };

    for (const [k, v] of Object.entries(firstSheet.summary)) {
      let displayV = typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(2)) : v;
      displayV = sanitizeCellValue(displayV);
      const r = summaryWs.addRow({ k: sanitizeCellValue(`  ${k}`), v: displayV });
      if (typeof v === 'number') {
        const cell = r.getCell(2);
        cell.numFmt = isMoneyKey(k) ? MONEY_FMT : NUMBER_FMT;
        cell.alignment = { horizontal: 'right' };
      }
    }
  }

  // =========================================================================
  // SHEET 2 — Detailed (data rows)
  // =========================================================================
  for (const sheetCfg of sheets) {
    const ws = workbook.addWorksheet('Detailed', {
      properties: { defaultRowHeight: 18, defaultColWidth: 20 },
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    const columns = sheetCfg.columns.map((c) => {
      const hasMoney = c.isMoney === true || isMoneyKey(c.key);
      const hasDate = c.isDate === true || isDateKey(c.key);
      const numFmt = c.numFmt ?? (hasMoney ? MONEY_FMT : hasDate ? DATE_FMT : undefined);
      const alignment = hasMoney || /(count|pct|percent|ratio|id)$/i.test(c.key)
        ? { horizontal: 'right' }
        : { vertical: 'middle', wrapText: true };
      return {
        header: c.header,
        key: c.key,
        width: c.width ?? (hasMoney ? 18 : 22),
        style: {
          font: { name: 'Calibri', size: 11 },
          numFmt,
          alignment,
        },
      };
    });
    ws.columns = columns;

    const headerRow = ws.getRow(1);
    headerRow.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A3D0A' } };
    headerRow.height = 28;
    headerRow.alignment = { vertical: 'middle', wrapText: true };

    const cap = MAX_EXPORT_ROWS;
    const rows = await sheetCfg.rowsPromise(cap);
    const cappedRows = rows.slice(0, cap);

    for (const row of cappedRows) {
      const typedRow: Record<string, any> = {};
      for (const c of columns) {
        const raw = row?.[c.key];
        typedRow[c.key] = sanitizeCellValue(raw);
      }
      ws.addRow(typedRow);
      totalRows += 1;
    }
  }

  // Standard Workbook.writeBuffer() — no StreamBuf/pipe API issues.
  const buffer: Buffer = await workbook.xlsx.writeBuffer();
  return {
    buffer,
    rowCount: totalRows,
    fileSizeBytes: buffer.length,
    reportUuid,
  };
}

export function xlsxContentType(): {
  type: ReportExportFormat;
  contentType: string;
  filename: (reportName: string, uuid: string) => string;
} {
  return {
    type: 'XLSX' as ReportExportFormat,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: (n, u) => `${n.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_')}_${u.slice(0, 8)}.xlsx`,
  };
}
