import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canManageCompDays, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:contracts';
const TYPES = ['Contrato', 'Vacaciones'];

interface ContractEntry {
  id: string;
  employee: string;
  type: string;
  startDate: string;
  endDate: string | null;
  note: string;
  createdAt: string;
}

async function requireContracts(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageCompDays(session.role)) return null;
  return session;
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!(await requireContracts(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  const entries = Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((e): e is ContractEntry => e !== null)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));

  return new Response(JSON.stringify({ entries, types: TYPES }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireContracts(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { employee?: string; type?: string; startDate?: string; endDate?: string | null; note?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const employee = String(body.employee || '').trim();
  const type = String(body.type || '');
  const startDate = String(body.startDate || '').trim();
  const endDate = body.endDate ? String(body.endDate) : null;
  const note = String(body.note || '').trim();

  if (!employee || !TYPES.includes(type) || !startDate) {
    return new Response(JSON.stringify({ error: 'missing or invalid fields' }), { status: 400 });
  }

  const entry: ContractEntry = {
    id: randomUUID(),
    employee,
    type,
    startDate,
    endDate,
    note,
    createdAt: new Date().toISOString(),
  };

  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });
  await logAudit(redis, session, 'contract_create', employee, `${type}: ${startDate}${endDate ? ' – ' + endDate : ''}`);

  return new Response(JSON.stringify({ entry }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireContracts(cookies);
  if (!session) {
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

  await redis.hdel(REDIS_KEY, String(body.id || ''));
  await logAudit(redis, session, 'contract_delete', String(body.id || ''));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
