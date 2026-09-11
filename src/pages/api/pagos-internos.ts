import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import {
  SESSION_COOKIE,
  getSession,
  canAccessPagosInternos,
  canSeeAllPagosInternos,
  findUserById,
  verifySameOrigin,
} from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:pagos-internos';
export const BRANCHES = ['Riohacha', 'Valledupar', 'Santa Marta', 'Maicao', 'Atlántico', 'Bucaramanga', 'Medellín', 'Montería'];
export const STATUSES = ['Pendiente', 'Pagado'];

interface TimelineEvent {
  id: string;
  type: string;
  message: string;
  authorName: string;
  date: string;
}

export interface PagoInterno {
  id: string;
  concepto: string;
  proveedor: string;
  monto: number;
  dueDate: string;
  branch: string;
  assignedToId: string;
  assignedToName: string;
  status: string;
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
  createdById: string;
  createdByName: string;
  paidAt: string | null;
  paidByName: string;
}

async function requirePagosInternos(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessPagosInternos(session)) return null;
  return session;
}

export async function readPagos(redis: any): Promise<PagoInterno[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((p): p is PagoInterno => p !== null)
    .map((p) => ({ timeline: [], paidAt: null, paidByName: '', ...p }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function addEvent(pago: PagoInterno, type: string, message: string, authorName: string, now: string) {
  pago.timeline.push({ id: randomUUID(), type, message, authorName, date: now });
}

function computeStats(items: PagoInterno[]) {
  const pendientes = items.filter((p) => p.status === 'Pendiente');
  return {
    total: items.length,
    pendientes: pendientes.length,
    pagados: items.filter((p) => p.status === 'Pagado').length,
    montoPendiente: pendientes.reduce((sum, p) => sum + (p.monto || 0), 0),
  };
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requirePagosInternos(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const seesAll = canSeeAllPagosInternos(session);
  let items = await readPagos(redis);

  if (!seesAll) {
    const me = await findUserById(redis, session.userId);
    items = items.filter((p) => p.branch === (me?.branch || ''));
  }

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const status = url.searchParams.get('status') || '';
  const branch = url.searchParams.get('branch') || '';
  if (q) items = items.filter((p) => p.concepto.toLowerCase().includes(q) || p.proveedor.toLowerCase().includes(q));
  if (status) items = items.filter((p) => p.status === status);
  if (seesAll && branch) items = items.filter((p) => p.branch === branch);

  return new Response(
    JSON.stringify({
      pagos: items,
      stats: computeStats(items),
      branches: BRANCHES,
      seesAll,
      currentUserId: session.userId,
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requirePagosInternos(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { concepto?: string; proveedor?: string; monto?: number; dueDate?: string; branch?: string; assignedToId?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const concepto = String(body.concepto || '').trim();
  const proveedor = String(body.proveedor || '').trim();
  const monto = Number(body.monto);
  const dueDate = String(body.dueDate || '').trim();
  const assignedToId = String(body.assignedToId || '').trim();

  if (!concepto || !proveedor || !Number.isFinite(monto) || monto <= 0 || !dueDate || !assignedToId) {
    return new Response(JSON.stringify({ error: 'faltan campos obligatorios' }), { status: 400 });
  }

  const seesAll = canSeeAllPagosInternos(session);
  const creator = await findUserById(redis, session.userId);
  let branch = '';
  if (seesAll) {
    branch = String(body.branch || '').trim();
    if (!branch || !BRANCHES.includes(branch)) {
      return new Response(JSON.stringify({ error: 'sucursal inválida' }), { status: 400 });
    }
  } else {
    branch = creator?.branch || '';
    if (!branch) {
      return new Response(JSON.stringify({ error: 'tu usuario no tiene una sucursal asignada — pide al administrador que te la configure' }), { status: 400 });
    }
  }

  const assignee = await findUserById(redis, assignedToId);
  if (!assignee || !assignee.active) {
    return new Response(JSON.stringify({ error: 'responsable inválido' }), { status: 400 });
  }

  const now = new Date().toISOString();
  const pago: PagoInterno = {
    id: randomUUID(),
    concepto,
    proveedor,
    monto,
    dueDate,
    branch,
    assignedToId: assignee.id,
    assignedToName: assignee.name,
    status: 'Pendiente',
    timeline: [],
    createdAt: now,
    updatedAt: now,
    createdById: session.userId,
    createdByName: creator?.name || session.username,
    paidAt: null,
    paidByName: '',
  };
  addEvent(pago, 'created', `Pago registrado por ${pago.createdByName}`, pago.createdByName, now);

  await redis.hset(REDIS_KEY, { [pago.id]: JSON.stringify(pago) });
  await logAudit(redis, session, 'pago_interno_create', `${pago.concepto} · ${pago.branch}`, `asignado a ${assignee.name}`);

  try {
    await pushNotification(redis, assignee.id, {
      type: 'pago-interno',
      message: `Nuevo pago programado pendiente: ${pago.concepto} (${pago.branch})`,
      link: '/interno/pagos-internos',
    });
  } catch {
    // no debe tumbar la creación
  }

  return new Response(JSON.stringify({ pago }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requirePagosInternos(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string; action?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const id = String(body.id || '');
  const action = String(body.action || '');
  const note = String(body.note || '').trim();
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const pago: PagoInterno = { timeline: [], paidAt: null, paidByName: '', ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  // Acceso al pago: admin/Josué/Wilmar ven y actúan sobre todos; un gerente puede actuar
  // sobre cualquier pago de SU sucursal (no solo el que él mismo creó o el que le asignaron).
  const seesAll = canSeeAllPagosInternos(session);
  const actor = await findUserById(redis, session.userId);
  if (!seesAll && pago.branch !== (actor?.branch || '')) {
    return new Response(JSON.stringify({ error: 'no tienes acceso a este pago' }), { status: 403 });
  }

  const actorName = actor?.name || session.username;
  const now = new Date().toISOString();

  if (action === 'addNote') {
    if (!note) {
      return new Response(JSON.stringify({ error: 'la nota no puede estar vacía' }), { status: 400 });
    }
    addEvent(pago, 'note', note, actorName, now);
  } else if (action === 'markPaid') {
    if (pago.status === 'Pagado') {
      return new Response(JSON.stringify({ error: 'este pago ya está marcado como pagado' }), { status: 400 });
    }
    pago.status = 'Pagado';
    pago.paidAt = now;
    pago.paidByName = actorName;
    addEvent(pago, 'paid', `${actorName} marcó el pago como realizado${note ? '. ' + note : ''}`, actorName, now);
  } else if (action === 'reopen') {
    if (pago.status !== 'Pagado') {
      return new Response(JSON.stringify({ error: 'este pago no está pagado' }), { status: 400 });
    }
    pago.status = 'Pendiente';
    pago.paidAt = null;
    pago.paidByName = '';
    addEvent(pago, 'reopen', `${actorName} reabrió el pago`, actorName, now);
  } else {
    return new Response(JSON.stringify({ error: 'acción inválida' }), { status: 400 });
  }

  pago.updatedAt = now;
  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(pago) });
  await logAudit(redis, session, 'pago_interno_update', `${pago.concepto} · ${pago.branch}`, action);

  return new Response(JSON.stringify({ pago }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
