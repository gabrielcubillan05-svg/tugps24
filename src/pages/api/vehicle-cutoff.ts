import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:vehicle-cutoff-extra';

interface CutoffEntry {
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
