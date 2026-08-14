import type { APIRoute } from 'astro';
import * as XLSX from 'xlsx';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessPagos, verifySameOrigin } from '../../lib/auth';
import { readReceipts } from './payment-receipts';

export const prerender = false;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const MIN_SHARED_WORDS = 2;

interface OptimusEntry {
  numero: string;
  cliente: string;
  monto: number;
  fecha: string | null; // YYYY-MM-DD
  sucursal: string;
  creadoPor: string;
}

function normalizeHeader(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function normalizeName(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase();
}

function nameTokens(raw: unknown): string[] {
  return normalizeName(raw)
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function sharedWordCount(a: unknown, b: unknown): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  return ta.filter((w) => tb.includes(w)).length;
}

function namesLikelyMatch(a: unknown, b: unknown): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const need = Math.min(MIN_SHARED_WORDS, Math.min(ta.length, tb.length));
  return sharedWordCount(a, b) >= need;
}

function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessPagos(session)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return new Response(JSON.stringify({ error: 'invalid content-type' }), { status: 400 });
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return new Response(JSON.stringify({ error: 'falta el archivo' }), { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return new Response(JSON.stringify({ error: 'el archivo debe pesar menos de 5MB' }), { status: 400 });
  }
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
    return new Response(JSON.stringify({ error: 'el archivo debe ser .xlsx, .xls o .csv' }), { status: 400 });
  }

  let rows: unknown[][];
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('sin hojas');
    rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '' });
  } catch {
    return new Response(JSON.stringify({ error: 'no se pudo leer el archivo, verifica el formato' }), { status: 400 });
  }

  // El export de Optimus trae una fila de título suelta y una fila vacía antes de los
  // encabezados reales, así que buscamos la fila que de verdad tiene "Cliente" y "Monto".
  const headerRowIndex = rows.findIndex((row) => {
    const norm = row.map(normalizeHeader);
    return norm.includes('cliente') && norm.includes('monto');
  });
  if (headerRowIndex < 0) {
    return new Response(
      JSON.stringify({ error: 'no se encontraron las columnas "Cliente" y "Monto" en el archivo' }),
      { status: 400 }
    );
  }
  const headerRow = rows[headerRowIndex].map(normalizeHeader);
  const col = (name: string) => headerRow.indexOf(name);
  const clienteCol = col('cliente');
  const montoCol = col('monto');
  const fechaCol = col('fecha');
  const sucursalCol = col('sucursal');
  const creadoPorCol = col('creado por');
  const numeroCol = col('numero') >= 0 ? col('numero') : col('número');

  const optimusEntries: OptimusEntry[] = [];
  for (const row of rows.slice(headerRowIndex + 1)) {
    const cliente = String(row[clienteCol] ?? '').trim();
    const monto = Number(row[montoCol]);
    if (!cliente || !Number.isFinite(monto) || monto <= 0) continue;
    optimusEntries.push({
      numero: numeroCol >= 0 ? String(row[numeroCol] ?? '') : '',
      cliente,
      monto,
      fecha: fechaCol >= 0 ? excelSerialToISO(Number(row[fechaCol])) : null,
      sucursal: sucursalCol >= 0 ? String(row[sucursalCol] ?? '') : '',
      creadoPor: creadoPorCol >= 0 ? String(row[creadoPorCol] ?? '') : '',
    });
  }

  if (!optimusEntries.length) {
    return new Response(
      JSON.stringify({ error: 'el archivo no tiene pagos con cliente y monto mayor a cero' }),
      { status: 400 }
    );
  }

  const allReceipts = await readReceipts(redis);
  const verifiedReceipts = allReceipts.filter((r) => r.status === 'verificado');
  const claimed = new Set<string>();

  const matched: Array<{ cliente: string; monto: number; payerName: string; receiptId: string }> = [];
  const amountMismatch: Array<{ cliente: string; montoOptimus: number; montoComprobante: number; payerName: string; receiptId: string }> = [];
  const optimusOnly: Array<{ cliente: string; monto: number; fecha: string | null; numero: string }> = [];

  for (const entry of optimusEntries) {
    const amountCandidates = verifiedReceipts.filter(
      (r) => !claimed.has(r.id) && Math.round(r.amount) === Math.round(entry.monto) && namesLikelyMatch(r.payerName, entry.cliente)
    );
    if (amountCandidates.length === 1) {
      claimed.add(amountCandidates[0].id);
      matched.push({ cliente: entry.cliente, monto: entry.monto, payerName: amountCandidates[0].payerName, receiptId: amountCandidates[0].id });
      continue;
    }
    if (amountCandidates.length > 1) {
      // Varias coincidencias por monto y nombre: se toma la primera, igual que en la
      // comparación contra el banco — el resto sigue disponible para otras filas.
      claimed.add(amountCandidates[0].id);
      matched.push({ cliente: entry.cliente, monto: entry.monto, payerName: amountCandidates[0].payerName, receiptId: amountCandidates[0].id });
      continue;
    }

    const nameCandidates = verifiedReceipts
      .filter((r) => !claimed.has(r.id) && namesLikelyMatch(r.payerName, entry.cliente))
      .sort((a, b) => sharedWordCount(b.payerName, entry.cliente) - sharedWordCount(a.payerName, entry.cliente));
    if (nameCandidates.length) {
      const best = nameCandidates[0];
      claimed.add(best.id);
      amountMismatch.push({ cliente: entry.cliente, montoOptimus: entry.monto, montoComprobante: best.amount, payerName: best.payerName, receiptId: best.id });
      continue;
    }

    optimusOnly.push({ cliente: entry.cliente, monto: entry.monto, fecha: entry.fecha, numero: entry.numero });
  }

  const receiptOnly = verifiedReceipts
    .filter((r) => !claimed.has(r.id))
    .map((r) => ({ id: r.id, payerName: r.payerName, amount: r.amount, paymentDate: r.paymentDate }));

  await logAudit(
    redis,
    session,
    'payment_receipts_compare_optimus',
    file.name,
    `${optimusEntries.length} pagos Optimus, ${matched.length} coinciden, ${amountMismatch.length} con monto distinto, ${optimusOnly.length} sin comprobante, ${receiptOnly.length} comprobantes sin registrar`
  );

  return new Response(
    JSON.stringify({
      stats: {
        optimusCount: optimusEntries.length,
        receiptsUploadedCount: allReceipts.length,
        receiptsVerifiedCount: verifiedReceipts.length,
        matchedCount: matched.length,
        amountMismatchCount: amountMismatch.length,
        optimusOnlyCount: optimusOnly.length,
        receiptOnlyCount: receiptOnly.length,
      },
      matched,
      amountMismatch,
      optimusOnly,
      receiptOnly,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};
