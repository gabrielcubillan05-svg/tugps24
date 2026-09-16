import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:vehicle-cutoff-extra';
// Los 395 registros originales vienen de un archivo estático (vehicle-cutoff-data.json), no de
// Redis — para poder editarlos igual que los agregados desde el panel, cada edición se guarda
// aquí como "override" identificado por su posición en ese archivo ("static-<índice>"), y se
// aplica encima del dato original al armar la lista completa (ver esquemas-apagado.astro).
const OVERRIDES_KEY = 'internal:vehicle-cutoff-overrides';

export interface CutoffEntry {
  id: string;
  marca: string;
  modelo: string;
  anio: string;
  corteBomba: boolean;
  corteIgnicion: boolean;
  colores: string;
  ubicacion: string;
  createdAt: string;
  createdByName: string;
}

const EDITABLE_FIELDS = ['marca', 'modelo', 'anio', 'corteBomba', 'corteIgnicion', 'colores', 'ubicacion'] as const;

async function requireEsquemas(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'esquemas-apagado')) return null;
  return session;
}

export async function readExtraEntries(redis: any): Promise<CutoffEntry[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((e): e is CutoffEntry => e !== null);
}

export async function readOverrides(redis: any): Promise<Record<string, Partial<CutoffEntry>>> {
  const raw = (await redis.hgetall<Record<string, string>>(OVERRIDES_KEY)) || {};
  const out: Record<string, Partial<CutoffEntry>> = {};
  for (const [id, v] of Object.entries(raw)) {
    try {
      out[id] = typeof v === 'string' ? JSON.parse(v) : v;
    } catch {
      // ignora overrides corruptos
    }
  }
  return out;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'origen inválido' }), { status: 403 });
  }
  const session = await requireEsquemas(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const marca = String(body?.marca || '').trim();
  const modelo = String(body?.modelo || '').trim();
  if (!marca || !modelo) {
    return new Response(JSON.stringify({ error: 'marca y modelo son obligatorios' }), { status: 400 });
  }

  const entry: CutoffEntry = {
    id: randomUUID(),
    marca,
    modelo,
    anio: String(body?.anio || '').trim(),
    corteBomba: Boolean(body?.corteBomba),
    corteIgnicion: Boolean(body?.corteIgnicion),
    colores: String(body?.colores || '').trim(),
    ubicacion: String(body?.ubicacion || '').trim(),
    createdAt: new Date().toISOString(),
    createdByName: session.name,
  };

  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });
  await logAudit(redis, session, 'esquema_apagado_create', `${entry.marca} ${entry.modelo}`, '');

  return new Response(JSON.stringify({ ok: true, entry }), { status: 200 });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'origen inválido' }), { status: 403 });
  }
  const session = await requireEsquemas(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const id = String(body?.id || '');
  const fields = body?.fields && typeof body.fields === 'object' ? body.fields : {};
  if (!id) {
    return new Response(JSON.stringify({ error: 'falta el esquema a editar' }), { status: 400 });
  }

  function applyFields<T extends Record<string, any>>(target: T): T {
    const updated: any = { ...target };
    for (const key of EDITABLE_FIELDS) {
      if (fields[key] === undefined) continue;
      if (key === 'corteBomba' || key === 'corteIgnicion') updated[key] = Boolean(fields[key]);
      else updated[key] = String(fields[key]).trim();
    }
    return updated;
  }

  if (id.startsWith('static-')) {
    const overrides = await readOverrides(redis);
    const updated = applyFields(overrides[id] || {});
    await redis.hset(OVERRIDES_KEY, { [id]: JSON.stringify(updated) });
    await logAudit(redis, session, 'esquema_apagado_edit', id, '');
    return new Response(JSON.stringify({ ok: true, override: updated }), { status: 200 });
  }

  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'esquema no encontrado' }), { status: 404 });
  }
  const existing: CutoffEntry = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const updated = applyFields(existing);
  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(updated) });
  await logAudit(redis, session, 'esquema_apagado_edit', `${updated.marca} ${updated.modelo}`, '');

  return new Response(JSON.stringify({ ok: true, entry: updated }), { status: 200 });
};
