import ExcelJS from 'exceljs';

// Lectura de hojas de cálculo subidas por el personal (cobranza, garantías). Reemplaza a la
// librería xlsx 0.18, que tiene vulnerabilidades sin arreglo en npm (contaminación de
// prototipos y ReDoS con archivos manipulados). Devuelve filas como arreglos de valores
// primitivos, igual que hacía sheet_to_json con header: 1.
export class SpreadsheetError extends Error {}

function cellToPrimitive(value: ExcelJS.CellValue): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v: any = value;
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text).join('');
    if (v.result !== undefined) return cellToPrimitive(v.result);
    if (v.text !== undefined) return cellToPrimitive(v.text);
    if (v.hyperlink !== undefined) return String(v.hyperlink);
    if (v.error !== undefined) return '';
    return String(v);
  }
  return value as string | number | boolean;
}

function parseCsv(text: string): (string | number | boolean)[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const sep = text.split('\n', 1)[0].includes(';') && !text.split('\n', 1)[0].includes(',') ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

export async function readFirstSheetRows(file: File): Promise<(string | number | boolean)[][]> {
  const name = file.name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());
  if (name.endsWith('.csv')) return parseCsv(buffer.toString('utf8').replace(/^﻿/, ''));
  if (name.endsWith('.xls')) {
    throw new SpreadsheetError('el formato .xls antiguo ya no se acepta: guárdalo como .xlsx desde Excel y vuelve a subirlo');
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new SpreadsheetError('no se pudo leer el archivo, verifica que sea un .xlsx válido');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new SpreadsheetError('el archivo no tiene hojas');
  const rows: (string | number | boolean)[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push(values.map((v) => cellToPrimitive(v as ExcelJS.CellValue)));
  });
  return rows;
}
