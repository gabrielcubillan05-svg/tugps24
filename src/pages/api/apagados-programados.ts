import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, findUserById, canAccessShutdownSchedules, canDeleteShutdownSchedules, verifySameOrigin, type Session } from '../../lib/auth';
import { todayInColombia, timeInColombia } from '../../lib/colombia-time';

export const prerender = false;

// Apagados y encendidos programados de vehículos. Antes cada operador los llevaba como alarmas
// en su propio teléfono y, cuando el cliente cambiaba la hora, la alarma vieja seguía sonando
// o la nueva no existía. Aquí hay una sola lista por placa y la página de la central suena
// como alarma a la hora exacta (ver public/js/interno-alarmas.js) hasta que alguien confirma.
export const REDIS_KEY = 'internal:scheduled-shutdowns';
const LOG_KEY = 'internal:scheduled-shutdowns-log';
const LOG_MAX = 3000;
// Pasados estos minutos sin confirmar, la programación se marca vencida y el cron avisa a los
// supervisores.
export const LATE_AFTER_MINUTES = 15;

export type ShutdownAction = 'apagar' | 'encender';
export type ShutdownRepeat = 'diario' | 'lun_vie' | 'dias' | 'una_vez';
const ACTIONS: ShutdownAction[] = ['apagar', 'encender'];
const REPEATS: ShutdownRepeat[] = ['diario', 'lun_vie', 'dias', 'una_vez'];

export interface ShutdownSchedule {
  id: string;
  placa: string;
  cliente: string;
  accion: ShutdownAction;
  hora: string; // HH:MM hora Colombia
  repeat: ShutdownRepeat;
  dias: number[]; // 0=Domingo ... 6=Sábado (solo cuando repeat = 'dias')
  fecha: string | null; // YYYY-MM-DD (solo cuando repeat = 'una_vez')
  nota: string;
  activo: boolean;
  createdAt: string;
  createdByName: string;
  updatedAt: string;
  updatedByName: string;
  // Última confirmación: la franja (fecha+hora) que se marcó hecha, para no volver a sonar.
  doneSlot: string | null;
  doneAt: string | null;
  doneByName: string;
}

export interface AgendaEntry {
  id: string;
  placa: string;
  cliente: string;
  accion: ShutdownAction;
  hora: string;
  nota: string;
  slot: string; // YYYY-MM-DDTHH:MM
  status: 'pendiente' | 'hecho' | 'vencido';
  doneAt: string | null;
  doneByName: string;
}

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
  return (h || 0) * 60 + (m || 0);
}

// Día de la semana de una fecha YYYY-MM-DD sin que la zona horaria del servidor lo corra.
function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function isDueOn(item: ShutdownSchedule, date: string): boolean {
  if (!item.activo) return false;
  const wd = weekdayOf(date);
  switch (item.repeat) {
    case 'diario':
      return true;
    case 'lun_vie':
      return wd >= 1 && wd <= 5;
    case 'dias':
      return item.dias.includes(wd);
    case 'una_vez':
      return item.fecha === date;
    default:
      return false;
  }
}

export function buildAgenda(items: ShutdownSchedule[], date: string, nowHHMM: string): AgendaEntry[] {
  const nowMin = toMinutes(nowHHMM);
  return items
    .filter((i) => isDueOn(i, date))
    .map((i) => {
      const slot = `${date}T${i.hora}`;
      const done = i.doneSlot === slot;
      const status: AgendaEntry['status'] = done ? 'hecho' : nowMin - toMinutes(i.hora) >= LATE_AFTER_MINUTES ? 'vencido' : 'pendiente';
      return {
        id: i.id,
        placa: i.placa,
        cliente: i.cliente,
        accion: i.accion,
        hora: i.hora,
        nota: i.nota,
        slot,
        status,
        doneAt: done ? i.doneAt : null,
        doneByName: done ? i.doneByName : '',
      };
    })
    .sort((a, b) => a.hora.localeCompare(b.hora) || a.placa.localeCompare(b.placa));
}

export async function readShutdownSchedules(redis: any): Promise<ShutdownSchedule[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((i): i is ShutdownSchedule => !!i && typeof i === 'object')
    .map((i) => ({ dias: [], fecha: null, nota: '', cliente: '', activo: true, doneSlot: null, doneAt: null, doneByName: '', ...i }))
    .sort((a, b) => a.hora.localeCompare(b.hora) || a.placa.localeCompare(b.placa));
}

async function readLog(redis: any, limit: number) {
  const raw: unknown[] = (await redis.lrange(LOG_KEY, 0, limit - 1)) || [];
  return raw
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function requireAccess(cookies: any): Promise<Session | null> {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessShutdownSchedules(session)) return null;
  return session;
}

async function actorName(redis: any, session: Session): Promise<string> {
  const user = await findUserById(redis, session.userId);
  return user?.name || session.username;
}

function clean(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function parseDias(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((d) => parseInt(String(d), 10)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
}

// Valida los campos que vienen en el cuerpo y los aplica sobre el ítem; devuelve el mensaje de
// error si algo no cuadra. Sirve igual para crear y para editar.
function applyFields(item: ShutdownSchedule, body: any, partial: boolean): string | null {
  if (!partial || body.placa !== undefined) {
    item.placa = clean(body.placa, 20).toUpperCase().replace(/\s+/g, '');
    if (!item.placa) return 'la placa es obligatoria';
  }
  if (!partial || body.cliente !== undefined) item.cliente = clean(body.cliente, 80);
  if (!partial || body.nota !== undefined) item.nota = clean(body.nota, 200);
  if (!partial || body.accion !== undefined) {
    item.accion = clean(body.accion, 10) as ShutdownAction;
    if (!ACTIONS.includes(item.accion)) return 'acción inválida';
  }
  if (!partial || body.hora !== undefined) {
    item.hora = clean(body.hora, 5);
    if (!HORA_RE.test(item.hora)) return 'la hora debe ser HH:MM';
  }
  if (!partial || body.repeat !== undefined) {
    item.repeat = clean(body.repeat, 10) as ShutdownRepeat;
    if (!REPEATS.includes(item.repeat)) return 'repetición inválida';
  }
  if (!partial || body.dias !== undefined) item.dias = parseDias(body.dias);
  if (!partial || body.fecha !== undefined) {
    const fecha = clean(body.fecha, 10);
    item.fecha = fecha && FECHA_RE.test(fecha) ? fecha : null;
  }
  if (body.activo !== undefined) item.activo = !!body.activo;
  if (item.repeat === 'dias' && !item.dias.length) return 'elige al menos un día';
  if (item.repeat === 'una_vez' && !item.fecha) return 'indica la fecha';
  return null;
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireAccess(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const date = todayInColombia();
  const now = timeInColombia();
  const items = await readShutdownSchedules(redis);
  const agenda = buildAgenda(items, date, now);
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  // Consulta liviana que hace la alarma de cada pestaña del panel cada minuto.
  if (url.searchParams.get('agenda')) {
    return new Response(JSON.stringify({ agenda, date, serverNow: new Date().toISOString() }), { headers });
  }

  const log = await readLog(redis, 100);
  return new Response(
    JSON.stringify({ items, agenda, log, date, serverNow: new Date().toISOString(), canDelete: canDeleteShutdownSchedules(session.role) }),
    { headers }
  );
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireAccess(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const name = await actorName(redis, session);
  const nowIso = new Date().toISOString();

  if (body.action === 'done') {
    const raw = await redis.hget<string>(REDIS_KEY, String(body.id || ''));
    if (!raw) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    const slot = clean(body.slot, 16);
    if (!SLOT_RE.test(slot)) {
      return new Response(JSON.stringify({ error: 'franja inválida' }), { status: 400 });
    }
    const item: ShutdownSchedule = { dias: [], fecha: null, doneSlot: null, doneAt: null, doneByName: '', ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
    if (item.doneSlot === slot) {
      return new Response(JSON.stringify({ item, already: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    item.doneSlot = slot;
    item.doneAt = nowIso;
    item.doneByName = name;
    await redis.hset(REDIS_KEY, { [item.id]: JSON.stringify(item) });

    const nowColombia = `${todayInColombia()}T${timeInColombia()}`;
    const lateMinutes = Math.max(0, Math.round((Date.parse(`${nowColombia}:00Z`) - Date.parse(`${slot}:00Z`)) / 60000));
    const entry = { id: item.id, placa: item.placa, cliente: item.cliente, accion: item.accion, slot, doneAt: nowIso, doneByName: name, lateMinutes };
    await redis.lpush(LOG_KEY, JSON.stringify(entry));
    await redis.ltrim(LOG_KEY, 0, LOG_MAX - 1);
    await logAudit(redis, session, 'apagado_programado_hecho', `${item.accion} ${item.placa}`, `${slot.replace('T', ' ')}${lateMinutes ? ` · ${lateMinutes} min tarde` : ''}`);
    return new Response(JSON.stringify({ item, entry }), { headers: { 'Content-Type': 'application/json' } });
  }

  const item: ShutdownSchedule = {
    id: randomUUID(),
    placa: '',
    cliente: '',
    accion: 'apagar',
    hora: '',
    repeat: 'diario',
    dias: [],
    fecha: null,
    nota: '',
    activo: true,
    createdAt: nowIso,
    createdByName: name,
    updatedAt: nowIso,
    updatedByName: name,
    doneSlot: null,
    doneAt: null,
    doneByName: '',
  };
  const error = applyFields(item, body, false);
  if (error) {
    return new Response(JSON.stringify({ error }), { status: 400 });
  }
  await redis.hset(REDIS_KEY, { [item.id]: JSON.stringify(item) });
  await logAudit(redis, session, 'apagado_programado_create', `${item.accion} ${item.placa}`, `${item.hora} · ${item.repeat}`);
  return new Response(JSON.stringify({ item }), { headers: { 'Content-Type': 'application/json' } });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireAccess(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const raw = await redis.hget<string>(REDIS_KEY, String(body.id || ''));
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const item: ShutdownSchedule = { dias: [], fecha: null, doneSlot: null, doneAt: null, doneByName: '', ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
  const before = `${item.hora} · ${item.repeat}${item.activo ? '' : ' · inactivo'}`;
  const error = applyFields(item, body, true);
  if (error) {
    return new Response(JSON.stringify({ error }), { status: 400 });
  }
  item.updatedAt = new Date().toISOString();
  item.updatedByName = await actorName(redis, session);
  await redis.hset(REDIS_KEY, { [item.id]: JSON.stringify(item) });
  await logAudit(redis, session, 'apagado_programado_update', `${item.accion} ${item.placa}`, `${before} → ${item.hora} · ${item.repeat}${item.activo ? '' : ' · inactivo'}`);
  return new Response(JSON.stringify({ item }), { headers: { 'Content-Type': 'application/json' } });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireAccess(cookies);
  if (!session || !canDeleteShutdownSchedules(session.role)) {
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
  const raw = await redis.hget<string>(REDIS_KEY, String(body.id || ''));
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const item: ShutdownSchedule = typeof raw === 'string' ? JSON.parse(raw) : raw;
  await redis.hdel(REDIS_KEY, item.id);
  await logAudit(redis, session, 'apagado_programado_delete', `${item.accion} ${item.placa}`, `${item.hora} · ${item.repeat}`);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
