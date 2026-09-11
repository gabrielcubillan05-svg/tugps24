import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:schedule';

export interface ScheduleEntry {
  id: string;
  operator: string;
  horario: string;
  // Días/horas estructuradas para que GaBot pueda saber si un operador está de turno ahora
  // mismo — vacíos en franjas viejas creadas antes de este campo (formato solo texto libre).
  days: string[];
  start: string;
  end: string;
  createdAt: string;
}

async function requireHorario(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'horario')) return null;
  return session;
}

export async function readSchedule(redis: any): Promise<ScheduleEntry[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.entries(raw)
    .map(([key, v]) => {
      try {
        const parsed = typeof v === 'string' ? JSON.parse(v) : v;
        if (parsed && typeof parsed === 'object' && parsed.operator && parsed.horario) {
          return {
            id: parsed.id || key,
            operator: parsed.operator,
            horario: parsed.horario,
            days: Array.isArray(parsed.days) ? parsed.days : [],
            start: parsed.start || '',
            end: parsed.end || '',
            createdAt: parsed.createdAt || '',
          };
        }
      } catch {
        // no era JSON: formato antiguo (clave = operador, valor = horario en texto plano)
      }
      if (typeof v === 'string' && v.trim()) {
        return { id: key, operator: key, horario: v, days: [], start: '', end: '', createdAt: '' };
      }
      return null;
    })
    .filter((e): e is ScheduleEntry => e !== null)
    .sort((a, b) => a.operator.localeCompare(b.operator) || a.createdAt.localeCompare(b.createdAt));
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!(await requireHorario(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const schedule = await readSchedule(redis);

  return new Response(JSON.stringify({ schedule }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireHorario(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { operator?: string; horario?: string; days?: string[]; start?: string; end?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const operator = String(body.operator || '').trim();
  const horario = String(body.horario || '').trim();
  if (!operator || !horario) {
    return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400 });
  }
  const days = Array.isArray(body.days) ? body.days.filter((d) => typeof d === 'string') : [];
  const start = /^\d{2}:\d{2}$/.test(String(body.start || '')) ? String(body.start) : '';
  const end = /^\d{2}:\d{2}$/.test(String(body.end || '')) ? String(body.end) : '';

  const entry: ScheduleEntry = {
    id: randomUUID(),
    operator,
    horario,
    days,
    start,
    end,
    createdAt: new Date().toISOString(),
  };
  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });
  await logAudit(redis, session, 'schedule_add', operator, horario);

  return new Response(JSON.stringify({ entry }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireHorario(cookies);
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
  await logAudit(redis, session, 'schedule_delete', String(body.id || ''));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
