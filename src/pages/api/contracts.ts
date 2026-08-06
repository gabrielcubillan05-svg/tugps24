import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canManageCompDays, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:contracts';
const TYPES = ['Contrato', 'Vacaciones'];
const VACATION_DAYS_PER_YEAR = 15;
const UPCOMING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

interface ContractEntry {
  id: string;
  employee: string;
  type: string;
  startDate: string;
  endDate: string | null;
  indefinite: boolean;
  note: string;
  createdAt: string;
}

async function requireContracts(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageCompDays(session.role)) return null;
  return session;
}

function withStatus(e: ContractEntry) {
  const now = Date.now();
  if (e.type === 'Contrato') {
    if (e.indefinite || !e.endDate) {
      return { ...e, status: 'indefinido' as const };
    }
    const end = new Date(e.endDate).getTime();
    if (end < now) return { ...e, status: 'vencido' as const };
    if (end - now <= UPCOMING_WINDOW_MS) return { ...e, status: 'proximo' as const };
    return { ...e, status: 'vigente' as const };
  }
  // Vacaciones
  if (e.startDate) {
    const start = new Date(e.startDate).getTime();
    if (start >= now && start - now <= UPCOMING_WINDOW_MS) {
      return { ...e, status: 'proxima' as const };
    }
  }
  return { ...e, status: 'programada' as const };
}

function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function computeVacationBalances(entries: ContractEntry[]) {
  const employees = [...new Set(entries.map((e) => e.employee))];
  return employees.map((employee) => {
    const contracts = entries.filter((e) => e.employee === employee && e.type === 'Contrato' && e.startDate);
    const hireDate = contracts.length
      ? contracts.map((e) => e.startDate).sort()[0]
      : null;

    let yearsOfService = 0;
    if (hireDate) {
      const ms = Date.now() - new Date(hireDate).getTime();
      yearsOfService = Math.max(0, Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000)));
    }
    const accruedDays = hireDate ? yearsOfService * VACATION_DAYS_PER_YEAR : 0;

    const takenDays = entries
      .filter((e) => e.employee === employee && e.type === 'Vacaciones' && e.startDate && e.endDate)
      .reduce((sum, e) => sum + daysBetween(e.startDate, e.endDate as string), 0);

    return {
      employee,
      hireDate,
      yearsOfService,
      accruedDays,
      takenDays,
      remainingDays: accruedDays - takenDays,
    };
  });
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
    .map((e) => ({ indefinite: false, ...e }))
    .sort((a, b) => b.startDate.localeCompare(a.startDate));

  const withStatuses = entries.map(withStatus);
  const vacationBalances = computeVacationBalances(entries).sort((a, b) => a.employee.localeCompare(b.employee));

  return new Response(JSON.stringify({ entries: withStatuses, types: TYPES, vacationBalances }), {
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

  let body: {
    employee?: string;
    type?: string;
    startDate?: string;
    endDate?: string | null;
    indefinite?: boolean;
    note?: string;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const employee = String(body.employee || '').trim();
  const type = String(body.type || '');
  const startDate = String(body.startDate || '').trim();
  const indefinite = type === 'Contrato' && Boolean(body.indefinite);
  const endDate = indefinite ? null : body.endDate ? String(body.endDate) : null;
  const note = String(body.note || '').trim();

  if (!employee || !TYPES.includes(type) || !startDate) {
    return new Response(JSON.stringify({ error: 'missing or invalid fields' }), { status: 400 });
  }
  if (type === 'Vacaciones' && !endDate) {
    return new Response(JSON.stringify({ error: 'las vacaciones necesitan fecha de fin' }), { status: 400 });
  }

  const entry: ContractEntry = {
    id: randomUUID(),
    employee,
    type,
    startDate,
    endDate,
    indefinite,
    note,
    createdAt: new Date().toISOString(),
  };

  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });
  await logAudit(
    redis,
    session,
    'contract_create',
    employee,
    `${type}: ${startDate}${indefinite ? ' (indefinido)' : endDate ? ' – ' + endDate : ''}`
  );

  return new Response(JSON.stringify({ entry: withStatus(entry) }), {
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
