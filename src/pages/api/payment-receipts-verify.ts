import type { APIRoute } from 'astro';
import * as XLSX from 'xlsx';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, verifySameOrigin } from '../../lib/auth';
import { readReceipts, REDIS_KEY, type PaymentReceipt } from './payment-receipts';

export const prerender = false;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const SAMPLE_ROWS = 300;

interface Movement {
  date: string; // YYYY-MM-DD
  amount: number;
  description: string;
  used: boolean;
}

function normalizeText(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

// El extracto de Bancolombia (CSV de "movimientos") no trae encabezados ni número de
// referencia: son filas de datos puras. Detectamos qué columna es cuál mirando qué
// patrón cumple cada columna en varias filas, en vez de asumir posiciones fijas.
function sniffColumns(rows: unknown[][]): { dateCol: number; amountCol: number; descCol: number } {
  const numCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const dateScore = new Array(numCols).fill(0);
  const amountScore = new Array(numCols).fill(0);
  const textScore = new Array(numCols).fill(0);
  let sampled = 0;

  for (const row of rows) {
    if (sampled >= SAMPLE_ROWS) break;
    let rowHasData = false;
    for (let c = 0; c < numCols; c++) {
      const v = String(row[c] ?? '').trim();
      if (!v) continue;
      rowHasData = true;
      if (/^\d{8}$/.test(v)) dateScore[c]++;
      if (/^-?\d+\.\d{1,2}$/.test(v)) amountScore[c]++;
      if (/[A-Za-z]{4,}/.test(v)) textScore[c]++;
    }
    if (rowHasData) sampled++;
  }

  const dateCol = dateScore.indexOf(Math.max(...dateScore));
  const amountCol = amountScore.indexOf(Math.max(...amountScore));
  let descCol = -1;
  let bestTextScore = -1;
  for (let c = 0; c < numCols; c++) {
    if (c === dateCol || c === amountCol) continue;
    if (textScore[c] > bestTextScore) {
      bestTextScore = textScore[c];
      descCol = c;
    }
  }
  return { dateCol, amountCol, descCol };
}

function parseBankDate(raw: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(raw);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'pagos')) {
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
    rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false });
  } catch {
    return new Response(JSON.stringify({ error: 'no se pudo leer el archivo, verifica el formato' }), { status: 400 });
  }
  if (!rows.length) {
    return new Response(JSON.stringify({ error: 'el archivo no tiene filas de datos' }), { status: 400 });
  }

  const { dateCol, amountCol, descCol } = sniffColumns(rows);
  if (dateCol < 0 || amountCol < 0) {
    return new Response(
      JSON.stringify({ error: 'no se pudo identificar las columnas de fecha y valor en el archivo' }),
      { status: 400 }
    );
  }

  // Solo créditos (dinero que entra): los montos negativos son cargos/débitos de la cuenta.
  const movements: Movement[] = [];
  for (const row of rows) {
    const dateRaw = String(row[dateCol] ?? '').trim();
    if (!/^\d{8}$/.test(dateRaw)) continue;
    const date = parseBankDate(dateRaw);
    if (!date) continue;
    const amount = parseFloat(String(row[amountCol] ?? '').trim());
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const description = descCol >= 0 ? String(row[descCol] ?? '').trim() : '';
    movements.push({ date, amount, description, used: false });
  }

  if (!movements.length) {
    return new Response(
      JSON.stringify({ error: 'no se encontraron movimientos de dinero recibido en el archivo' }),
      { status: 400 }
    );
  }

  const receipts = await readReceipts(redis);
  const now = new Date().toISOString();
  const updates: Record<string, string> = {};
  let verified = 0;
  let ambiguous = 0;
  let notFound = 0;

  for (const receipt of receipts) {
    if (receipt.status === 'verificado') continue;

    let candidates = movements.filter(
      (m) => !m.used && m.date === receipt.paymentDate && Math.round(m.amount) === Math.round(receipt.amount)
    );

    if (candidates.length > 1 && receipt.payerName) {
      const hint = normalizeText(receipt.payerName)
        .split(/\s+/)
        .filter((w) => w.length >= 4);
      if (hint.length) {
        const narrowed = candidates.filter((m) => {
          const desc = normalizeText(m.description);
          return hint.some((w) => desc.includes(w));
        });
        if (narrowed.length) candidates = narrowed;
      }
    }

    if (candidates.length === 1) {
      const match = candidates[0];
      match.used = true;
      receipt.status = 'verificado';
      receipt.matchedDetail = match.description ? `Coincide con: ${match.description}` : 'Coincide por monto y fecha';
      receipt.verifiedAt = now;
      receipt.updatedAt = now;
      updates[receipt.id] = JSON.stringify(receipt);
      verified++;
    } else if (candidates.length > 1) {
      receipt.status = 'pendiente';
      receipt.matchedDetail = `${candidates.length} movimientos coinciden por monto y fecha, confirma manualmente cuál es`;
      receipt.updatedAt = now;
      updates[receipt.id] = JSON.stringify(receipt);
      ambiguous++;
    } else {
      receipt.status = 'no-encontrado';
      receipt.matchedDetail = 'No se encontró un movimiento con ese monto y fecha en el archivo del banco';
      receipt.updatedAt = now;
      updates[receipt.id] = JSON.stringify(receipt);
      notFound++;
    }
  }

  if (Object.keys(updates).length) {
    await redis.hset(REDIS_KEY, updates);
  }

  await logAudit(
    redis,
    session,
    'payment_receipts_verify_upload',
    file.name,
    `${verified} verificados, ${ambiguous} ambiguos, ${notFound} sin encontrar`
  );

  return new Response(
    JSON.stringify({
      processedRows: rows.length,
      movementsRead: movements.length,
      verified,
      ambiguous,
      notFound,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};
