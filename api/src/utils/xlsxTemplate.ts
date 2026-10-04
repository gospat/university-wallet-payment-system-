import * as XLSX from './xlsxAdapter';

export interface TwoSheetTemplate {
  filename: string;
  buffer: Buffer;
  mimeType: string;
}

export interface ColumnNote {
  header: string;
  required?: boolean;
  note: string;
}

export async function buildTwoSheetWorkbook(params: {
  title: string;
  instructionRows: string[][];
  templateHeader: string[];
  templateSamples: string[][];
  colWidths: number[];
  columnNotes?: ColumnNote[];
}): Promise<TwoSheetTemplate> {
  const { title, instructionRows, templateHeader, templateSamples, colWidths, columnNotes } = params;

  const wb = XLSX.utils.book_new();
  const generated = `Generated: ${new Date().toISOString().slice(0, 19)}Z UTC`;

  const instructionWsData: (string | number | boolean | null)[][] = [];
  instructionWsData.push([title]);
  instructionWsData.push([]);
  instructionWsData.push([generated]);
  instructionWsData.push([]);

  for (const row of instructionRows) {
    instructionWsData.push([...row]);
  }

  if (columnNotes && columnNotes.length > 0) {
    instructionWsData.push([]);
    instructionWsData.push([]);
    instructionWsData.push(['Column Name', 'Required?', 'Format / Notes']);
    for (const cn of columnNotes) {
      instructionWsData.push([
        cn.header,
        cn.required ? 'YES — Required' : 'NO — Optional',
        cn.note,
      ]);
    }
  }

  const instructionWs = XLSX.utils.aoa_to_sheet(instructionWsData);
  instructionWs['!cols'] = colWidths.map((w) => ({ wch: w }));
  instructionWs['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(colWidths.length - 1, 25) } },
  ];

  XLSX.utils.book_append_sheet(wb, instructionWs, 'Instructions');

  const templateWsData: (string | number | boolean | null)[][] = [];
  templateWsData.push([...templateHeader]);
  for (const sample of templateSamples) {
    templateWsData.push([...sample]);
  }

  const templateWs = XLSX.utils.aoa_to_sheet(templateWsData);
  templateWs['!cols'] = colWidths.map((w) => ({ wch: w }));
  templateWs['!freeze'] = { xSplit: 0, ySplit: 1 };

  XLSX.utils.book_append_sheet(wb, templateWs, 'Template');

  const buffer = (await XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })) as Buffer;

  return {
    filename: 'template.xlsx',
    buffer,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}
