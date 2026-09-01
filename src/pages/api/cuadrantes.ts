import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, canVerifyInstalls, findUserById, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:cuadrantes';
export const BRANCHES = ['Riohacha', 'Valledupar', 'Santa Marta', 'Maicao', 'Atlántico', 'Bucaramanga', 'Medellín', 'Montería'];

interface Cuadrante {
  id: string;
  ciudad: string;
  numero: string;
  telefono: string;
  nota: string;
  createdAt: string;
  createdByName: string;
}

async function requireCuadrantes(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'cuadrantes')) return null;
  return session;
}

async function readCuadrantes(redis: any): Promise<Cuadrante[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((c): c is Cuadrante => c !== null)
    .sort((a, b) => a.ciudad.localeCompare(b.ciudad) || a.numero.localeCompare(b.numero));
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await requireCuadrantes(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const cuadrantes = await readCuadrantes(redis);
  return new Response(JSON.stringify({ cuadrantes, branches: BRANCHES }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCuadrantes(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { ciudad?: string; numero?: string; telefono?: string; nota?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const ciudad = String(body.ciudad || '').trim();
  const numero = String(body.numero || '').trim();
  const telefono = String(body.telefono || '').trim();
  const nota = String(body.nota || '').trim();

  if (!ciudad || !numero) {
    return new Response(JSON.stringify({ error: 'la ciudad y el número de cuadrante son obligatorios' }), { status: 400 });
  }

  const creator = await findUserById(redis, session.userId);
  const cuadrante: Cuadrante = {
    id: randomUUID(),
    ciudad,
    numero,
    telefono,
    nota,
    createdAt: new Date().toISOString(),
    createdByName: creator?.name || session.username,
  };

  await redis.hset(REDIS_KEY, { [cuadrante.id]: JSON.stringify(cuadrante) });
  await logAudit(redis, session, 'cuadrante_create', `${cuadrante.ciudad} · ${cuadrante.numero}`);

  return new Response(JSON.stringify({ cuadrante }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCuadrantes(cookies);
  if (!session || !canVerifyInstalls(session.role)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const id = String(body.id || '');
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const cuadrante: Cuadrante = typeof raw === 'string' ? JSON.parse(raw) : raw;

  await redis.hdel(REDIS_KEY, id);
  await logAudit(redis, session, 'cuadrante_delete', `${cuadrante.ciudad} · ${cuadrante.numero}`);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
