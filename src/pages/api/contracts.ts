import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessRRHH, verifySameOrigin, getUsers } from '../../lib/auth';
import { getHireDate, getProfile } from './employees';
import { readSchedule } from './schedule';

export const prerender = false;

const REDIS_KEY = 'internal:contracts';
const TYPES = ['Contrato', 'Vacaciones'];
const VACATION_DAYS_PER_YEAR = 15;
// Un mes: lo que Gabriel pidió para el aviso de contratos por vencer (antes eran 90 días).
const UPCOMING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
// Índice de Date.prototype.getDay() (0=domingo) para cada nombre de día.
const DAY_NAME_TO_INDEX: Record<string, number> = { Domingo: 0, Lunes: 1, Martes: 2, Miércoles: 3, Jueves: 4, Viernes: 5, Sábado: 6 };

export interface ContractEntry {
  id: string;
  employee: string;
  type: string;
  startDate: string;
  endDate: string | null;
  indefinite: boolean;
  pagada: boolean;
  note: string;
  createdAt: string;
}

async function requireContracts(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessRRHH(session)) return null;
  return session;
}

export function withStatus(e: ContractEntry) {
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

// Días hábiles entre dos fechas (incluyendo ambas): domingo no cuenta (sábado sí, confirmado con
// Gabriel), y si se pasa el día libre semanal de un operador (según su horario), tampoco cuenta.
function businessDaysBetween(startDate: string, endDate: string, extraFreeDayIndex: number | null): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  let count = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += 24 * 60 * 60 * 1000) {
    const dow = new Date(t).getUTCDay();
    if (dow === 0) continue;
    if (extraFreeDayIndex !== null && dow === extraFreeDayIndex) continue;
    count++;
  }
  return count;
}

// Día de la semana (índice de getDay(), 0=domingo) que un operador tiene libre según su horario
// — solo tiene sentido cuando cubre exactamente un día suelto sin turno asignado; si trabaja
// los 7 días o el patrón no es claro, no se descuenta ninguno extra (además del domingo).
function operatorFreeDayIndex(schedule: { operator: string; days: string[] }[], employeeName: string): number | null {
  const covered = new Set(
    schedule.filter((e) => e.operator === employeeName).flatMap((e) => e.days || [])
  );
  if (!covered.size) return null;
  const free = DAY_ORDER.filter((d) => !covered.has(d));
  if (free.length !== 1) return null;
  return DAY_NAME_TO_INDEX[free[0]] ?? null;
}

export function computeSeniority(hireDate: string | null): { yearsOfService: number; accruedDays: number } {
  if (!hireDate) return { yearsOfService: 0, accruedDays: 0 };
  const ms = Date.now() - new Date(hireDate).getTime();
  const yearsOfService = Math.max(0, Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000)));
  return { yearsOfService, accruedDays: yearsOfService * VACATION_DAYS_PER_YEAR };
}

export async function computeVacationBalances(redis: any, entries: ContractEntry[]) {
  const employees = [...new Set(entries.map((e) => e.employee))];
  const [users, schedule] = await Promise.all([getUsers(redis), readSchedule(redis)]);

  return Promise.all(employees.map(async (employee) => {
    // La fecha de ingreso vive en el perfil de RR.HH. del empleado (fuente única); si todavía
    // no se ha registrado ahí, se usa el contrato más antiguo como antes (datos viejos).
    const user = users.find((u) => u.name === employee);
    let hireDate = user ? await getHireDate(redis, user.id) : null;
    if (!hireDate) {
      const contracts = entries.filter((e) => e.employee === employee && e.type === 'Contrato' && e.startDate);
      hireDate = contracts.length ? contracts.map((e) => e.startDate).sort()[0] : null;
    }

    const { yearsOfService, accruedDays } = computeSeniority(hireDate);

    // A los operadores no se les cuenta su día libre semanal dentro de los días de vacaciones
    // tomados (además del domingo, que nunca cuenta).
    const freeDayIndex = user && user.role === 'operador' ? operatorFreeDayIndex(schedule, employee) : null;
    const vacationEntries = entries.filter((e) => e.employee === employee && e.type === 'Vacaciones' && e.startDate && e.endDate);
    const takenDays = vacationEntries.reduce((sum, e) => sum + businessDaysBetween(e.startDate, e.endDate as string, freeDayIndex), 0);
    const paidDays = vacationEntries
      .filter((e) => e.pagada)
      .reduce((sum, e) => sum + businessDaysBetween(e.startDate, e.endDate as string, freeDayIndex), 0);

    // Ajuste manual (positivo o negativo) para el historial de ~4 años sin fechas exactas: se
    // indica cuántos días ya se sabe que se disfrutaron/pagaron, sin inventar entradas con
    // fechas que no se tienen.
    const profile = user ? await getProfile(redis, user.id) : null;
    const ajusteInicial = profile?.vacacionesAjuste || 0;

    return {
      employee,
      hireDate,
      yearsOfService,
      accruedDays,
      takenDays,
      paidDays,
      ajusteInicial,
      remainingDays: accruedDays - takenDays + ajusteInicial,
    };
  }));
}

// Se usa al aprobar una solicitud de vacaciones (vacation-requests.ts) para que quede reflejada
// en el balance ya calculado aquí, sin duplicar la lógica de días tomados.
export async function createVacationEntry(redis: any, employee: string, startDate: string, endDate: string, note: string, pagada = false): Promise<void> {
  const entry: ContractEntry = {
    id: randomUUID(),
    employee,
    type: 'Vacaciones',
    startDate,
    endDate,
    indefinite: false,
    pagada,
    note,
    createdAt: new Date().toISOString(),
  };
  await redis.hset(REDIS_KEY, { [entry.id]: JSON.stringify(entry) });
}

export async function readContracts(redis: any): Promise<ContractEntry[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((e): e is ContractEntry => e !== null)
    .map((e) => ({ indefinite: false, pagada: false, ...e }))
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!(await requireContracts(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const entries = await readContracts(redis);
  const withStatuses = entries.map(withStatus);
  const vacationBalances = (await computeVacationBalances(redis, entries)).sort((a, b) => a.employee.localeCompare(b.employee));

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
    pagada?: boolean;
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
  const pagada = type === 'Vacaciones' && Boolean(body.pagada);
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
    pagada,
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
