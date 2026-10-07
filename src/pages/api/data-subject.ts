import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { del } from '@vercel/blob';
import { blobTimeout } from '../../lib/blob-path';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canManageUsers, verifySameOrigin } from '../../lib/auth';
import { normalizePhone, deleteLeads } from './leads';
import { writeCobros } from './cobros';
import { bumpVersion, COBROS_VERSION_KEY } from '../../lib/versions';

export const prerender = false;

// Supresión de datos de un cliente a pedido (Ley 1581 de 2012, art. 15: 15 días hábiles para
// responder). Dado un teléfono o una cédula, busca en todas las colecciones donde pueda estar,
// borra los registros y sus archivos en Blob, y deja en auditoría solo un hash del dato
// (nunca el teléfono o la cédula en claro). Solo admin; con dryRun devuelve qué borraría.
const COLLECTIONS: { key: string; blobPrefix?: string; label: string }[] = [
  { key: 'internal:leads', label: 'leads' },
  { key: 'internal:leads-archive', label: 'leads archivados' },
  { key: 'internal:cobros', label: 'cobros' },
  { key: 'internal:garantias', blobPrefix: 'garantias/', label: 'garantías' },
  { key: 'internal:planillas-vehiculo', blobPrefix: 'planillas/', label: 'planillas' },
  { key: 'internal:suspensiones', blobPrefix: 'suspensiones/', label: 'suspensiones' },
  { key: 'internal:solicitudes-administrativas', blobPrefix: 'solicitudes-admin/', label: 'solicitudes administrativas' },
  { key: 'internal:seguimiento-masivos', label: 'clientes masivos' },
];
const PHONE_FIELDS = ['phone', 'telefono', 'clienteTelefono', 'clientPhone'];
// 'numero' no entra: en varios módulos es el número de SIM o de factura, no la cédula.
const ID_FIELDS = ['cedula', 'clienteCedula', 'documento'];

function digits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

function matches(record: any, phone: string, cedula: string): boolean {
  if (!record || typeof record !== 'object') return false;
  if (phone && PHONE_FIELDS.some((f) => normalizePhone(String(record[f] || '')) === phone)) return true;
  if (cedula && ID_FIELDS.some((f) => digits(record[f]) === cedula)) return true;
  return false;
}

// Rutas de Blob referenciadas en cualquier campo (string) del registro.
function blobPaths(record: any, prefix: string): string[] {
  const out: string[] = [];
  const walk = (v: any) => {
    if (typeof v === 'string') {
      if (v.startsWith(prefix)) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(record);
  return out;
}

async function scanHash(redis: any, key: string): Promise<[string, any][]> {
  const out: [string, any][] = [];
  let cursor: string | number = 0;
  do {
    const [next, flat] = await redis.hscan(key, cursor, { count: 500 });
    cursor = next;
    const pairs = Array.isArray(flat) ? flat : [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      let v: any = pairs[i + 1];
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { continue; }
      }
      out.push([String(pairs[i]), v]);
    }
  } while (String(cursor) !== '0');
  return out;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageUsers(session.role)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  let body: { phone?: string; cedula?: string; dryRun?: boolean };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const phone = normalizePhone(String(body.phone || ''));
  const cedula = digits(body.cedula);
  if (phone.length < 7 && cedula.length < 5) {
    return new Response(JSON.stringify({ error: 'indica un teléfono o una cédula válidos' }), { status: 400 });
  }
  const dryRun = body.dryRun !== false;
  const found: { collection: string; id: string; summary: string; blobs: string[] }[] = [];

  for (const c of COLLECTIONS) {
    const entries = await scanHash(redis, c.key);
    for (const [id, record] of entries) {
      if (!matches(record, phone, cedula)) continue;
      found.push({
        collection: c.label,
        id,
        summary: String(record.name || record.nombre || record.clienteNombre || record.clientName || record.cliente || id).slice(0, 60),
        blobs: c.blobPrefix ? blobPaths(record, c.blobPrefix) : [],
      });
      if (dryRun) continue;
      if (c.key === 'internal:leads') {
        await deleteLeads(redis, [id]);
        await redis.hdel('internal:lead-whatsapp-conversations', id);
      } else if (c.key === 'internal:cobros') {
        await redis.hdel(c.key, id);
        await redis.hdel('internal:cobro-whatsapp-conversations', id);
        await bumpVersion(redis, COBROS_VERSION_KEY);
      } else {
        await redis.hdel(c.key, id);
      }
      const blobs = c.blobPrefix ? blobPaths(record, c.blobPrefix) : [];
      if (blobs.length && token) {
        try { await del(blobs, { token, abortSignal: blobTimeout(20_000) }); } catch (err) { console.error('data-subject: fallo borrando archivos', err instanceof Error ? err.message : String(err)); }
      }
    }
  }
  if (!dryRun && phone) await redis.hdel('internal:whatsapp-phone-index', phone);

  const fingerprint = createHash('sha256').update(`${phone}|${cedula}`).digest('hex').slice(0, 16);
  await logAudit(redis, session, dryRun ? 'data_subject_lookup' : 'data_subject_delete', `huella ${fingerprint}`, `${found.length} registro(s) en ${[...new Set(found.map((f) => f.collection))].join(', ') || 'ninguna colección'}`);

  return new Response(JSON.stringify({ ok: true, dryRun, fingerprint, found }), { headers: { 'Content-Type': 'application/json' } });
};
