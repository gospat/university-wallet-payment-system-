import ExcelJS from 'exceljs';

type CellValue = ExcelJS.CellValue;
type SheetJsonRow = Record<string, CellValue | number | string | boolean | null | Date>;

export interface AoASheet {
  [key: string]: any;
  '!cols'?: Array<{ wch: number }>;
  '!merges'?: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>;
  '!freeze'?: { xSplit?: number; ySplit?: number };
  __rows?: CellValue[][];
  __header?: string[];
}

export interface Workbook {
  SheetNames: string[];
  Sheets: Record<string, AoASheet>;
  __wb?: ExcelJS.Workbook;
}

export const utils = {
  book_new(): Workbook {
    return { SheetNames: [], Sheets: {} };
  },

  aoa_to_sheet(data: (string | number | boolean | null | undefined)[][]): AoASheet {
    return { __rows: data as CellValue[][] };
  },

  book_append_sheet(wb: Workbook, sheet: AoASheet, name: string): void {
    let safeName = name.slice(0, 31);
    let suffix = 1;
    while (wb.SheetNames.includes(safeName)) {
      const base = name.slice(0, 30 - String(suffix).length);
      safeName = `${base}${suffix}`;
      suffix += 1;
    }
    wb.SheetNames.push(safeName);
    wb.Sheets[safeName] = sheet;
  },

  sheet_to_json<T = Record<string, any>>(
    sheet: AoASheet,
    opts?: { defval?: any; raw?: boolean },
  ): T[] {
    const rows = sheet.__rows ?? [];
    if (rows.length === 0) return [] as T[];
    const headers = (rows[0] as any[]).map((h) =>
      h === null || h === undefined ? '' : String(h).trim(),
    );
    const out: T[] = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] as any[];
      if (!row || row.every((v) => v === null || v === undefined || v === '')) continue;
      const record: Record<string, any> = {};
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c] || `__col_${c}`;
        let val = row[c];
        if (val === undefined || val === null) {
          if (opts && 'defval' in opts) val = opts.defval;
          else val = '';
        }
        if (opts && opts.raw && val instanceof Date) {
          // no-op; keep raw date as-is
        }
        record[key] = val;
      }
      out.push(record as T);
    }
    return out;
  },
};

export async function read(
  input: ArrayBuffer | Buffer | Uint8Array,
  opts?: { type?: 'buffer' | 'file'; cellDates?: boolean },
): Promise<Workbook> {
  const wb = new ExcelJS.Workbook();
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(ArrayBuffer.isView(input) ? input.buffer : (input as any));
  await wb.xlsx.load(u8 as any);
  const out: Workbook = { SheetNames: [], Sheets: {}, __wb: wb };
  wb.eachSheet((ws) => {
    const rows: CellValue[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const rowArr: CellValue[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        while (rowArr.length < colNumber - 1) rowArr.push(null);
        let value: CellValue = cell.value ?? null;
        if (opts && opts.cellDates && cell.type === ExcelJS.ValueType.Date) {
          value = cell.value as any;
        }
        // Extract rich text to plain string
        if (value && typeof value === 'object' && 'richText' in (value as any)) {
          const rt = (value as any).richText as Array<{ text?: string }>;
          value = rt.map((r) => r.text ?? '').join('') as any;
        }
        if (
          value &&
          typeof value === 'object' &&
          'result' in (value as any) &&
          typeof (value as any).result !== 'undefined'
        ) {
          value = (value as any).result;
        }
        if (
          value &&
          typeof value === 'object' &&
          'text' in (value as any) &&
          'hyperlink' in (value as any)
        ) {
          value = (value as any).text;
        }
        if (
          value &&
          typeof value === 'object' &&
          'formula' in (value as any) &&
          'result' in (value as any)
        ) {
          value = (value as any).result ?? value;
        }
        rowArr.push(value);
      });
      if (rowArr.length > 0) rows.push(rowArr);
    });
    const sheet: AoASheet = { __rows: rows };
    out.SheetNames.push(ws.name);
    out.Sheets[ws.name] = sheet;
  });
  return out;
}

export async function write(
  wbIn: Workbook,
  opts: { type: 'buffer' | 'file'; bookType: 'xlsx' },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const sheetName of wbIn.SheetNames) {
    const sheet = wbIn.Sheets[sheetName];
    const ws = wb.addWorksheet(sheetName);
    const rows = sheet.__rows ?? [];
    let maxCols = 0;
    for (const r of rows) if (r.length > maxCols) maxCols = r.length;
    if (sheet['!cols']) {
      ws.columns = sheet['!cols'].map((c, i) => ({
        width: c?.wch ?? 15,
        key: String(i),
      }));
    } else if (maxCols > 0) {
      ws.columns = Array.from({ length: maxCols }, (_, i) => ({ width: 15, key: String(i) }));
    }
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const cells: any[] = [];
      for (let c = 0; c < maxCols; c++) {
        const v = row[c];
        cells.push(v === undefined ? null : v);
      }
      ws.addRow(cells);
    }
    if (sheet['!merges']) {
      for (const merge of sheet['!merges']) {
        ws.mergeCells(merge.s.r + 1, merge.s.c + 1, merge.e.r + 1, merge.e.c + 1);
        const topLeftCell = ws.getCell(merge.s.r + 1, merge.s.c + 1);
        if (merge.s.r === 0) {
          topLeftCell.font = { bold: true, size: 14 };
          topLeftCell.alignment = { vertical: 'middle', wrapText: true };
        }
      }
    }
    if (sheet['!freeze']) {
      const fr = sheet['!freeze'];
      if (fr.xSplit || fr.ySplit) {
        ws.views = [
          {
            state: 'frozen',
            xSplit: fr.xSplit,
            ySplit: fr.ySplit,
          },
        ];
      }
    }
    // Bold first row for Template sheet + first column header of Instructions
    if (rows.length > 0) {
      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true };
      headerRow.height = 24;
    }
  }
  if (opts.type === 'buffer') {
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  throw new Error('xlsxAdapter only supports buffer write');
}

export default { read, write, utils };
