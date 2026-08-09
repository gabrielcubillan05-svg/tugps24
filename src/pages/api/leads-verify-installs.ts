import type { APIRoute } from 'astro';
import * as XLSX from 'xlsx';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, canVerifyInstalls, verifySameOrigin } from '../../lib/auth';
import { readLeads, normalizePhone, REDIS_KEY, type Lead } from './leads';

export const prerender = false;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const PHONE_HEADER_ALIASES = [
  'telefono', 'teléfono', 'celular', 'numero', 'número', 'phone', 'tel', 'contacto', 'whatsapp',
];

function normalizeHeader(header: string): string {
  return String(header)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'crm') || !canVerifyInstalls(session.role)) {
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

  let rows: Record<string, unknown>[];
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('sin hojas');
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  } catch {
    return new Response(JSON.stringify({ error: 'no se pudo leer el archivo, verifica el formato' }), { status: 400 });
  }
  if (!rows.length) {
    return new Response(JSON.stringify({ error: 'el archivo no tiene filas de datos' }), { status: 400 });
  }

  const headers = Object.keys(rows[0]);
  const phoneHeader = headers.find((h) => PHONE_HEADER_ALIASES.includes(normalizeHeader(h)));
  if (!phoneHeader) {
    return new Response(
      JSON.stringify({ error: 'no se encontró una columna de teléfono (ej. "Teléfono", "Celular", "WhatsApp")' }),
      { status: 400 }
    );
  }

  const orderPhones = new Set<string>();
  for (const row of rows) {
    const phone = normalizePhone(String(row[phoneHeader] ?? ''));
    if (phone) orderPhones.add(phone);
  }

  const leads = await readLeads(redis);
  const byPhone = new Map<string, Lead>();
  for (const lead of leads) {
    const phone = normalizePhone(lead.phone);
    if (phone) byPhone.set(phone, lead);
  }

  const now = new Date().toISOString();
  const updates: Record<string, string> = {};
  let matched = 0;
  let newlyVerified = 0;
  const unmatchedPhones: string[] = [];

  for (const phone of orderPhones) {
    const lead = byPhone.get(phone);
    if (!lead) {
      if (unmatchedPhones.length < 50) unmatchedPhones.push(phone);
      continue;
    }
    matched++;
    if (!lead.verifiedInstalled) {
      lead.verifiedInstalled = true;
      lead.verifiedInstalledAt = now;
      lead.installed = true;
      if (lead.status !== 'Perdido') lead.status = 'Instalado';
      lead.updatedAt = now;
      updates[lead.id] = JSON.stringify(lead);
      newlyVerified++;
    }
  }

  if (Object.keys(updates).length) {
    await redis.hset(REDIS_KEY, updates);
  }

  await logAudit(
    redis,
    session,
    'lead_verify_installs_upload',
    file.name,
    `${matched} coincidencias, ${newlyVerified} nuevas verificaciones, ${unmatchedPhones.length} sin lead`
  );

  return new Response(
    JSON.stringify({
      processedRows: rows.length,
      ordersWithPhone: orderPhones.size,
      matched,
      newlyVerified,
      unmatchedCount: orderPhones.size - matched,
      unmatchedPhones,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};
