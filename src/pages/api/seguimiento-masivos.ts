import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, findUserById, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:seguimiento-masivos';

export const BRANCHES = ['Riohacha', 'Valledupar', 'Santa Marta', 'Maicao', 'Atlántico', 'Bucaramanga', 'Medellín', 'Montería'];

interface TimelineEvent {
  id: string;
  message: string;
  authorName: string;
  date: string;
}

export interface ClienteMasivo {
  id: string;
  clientName: string;
  phone: string;
  branch: string;
  vehicleCount: number;
  monthlyRevenue: number;
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
  createdById: string;
  createdByName: string;
}

async function requireAccess(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'seguimiento-masivos')) return null;
  return session;
}

export async function readClientes(redis: any): Promise<ClienteMasivo[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((c): c is ClienteMasivo => c !== null)
    .map((c) => ({ timeline: [], branch: '', vehicleCount: 0, monthlyRevenue: 0, ...c }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function addEvent(cliente: ClienteMasivo, message: string, authorName: string, now: string) {
  cliente.timeline.push({ id: randomUUID(), message, authorName, date: now });
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

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const branch = url.searchParams.get('branch') || '';

  const all = await readClientes(redis);
  let items = all;
  if (q) {
    items = items.filter((c) => c.clientName.toLowerCase().includes(q) || c.phone.toLowerCase().includes(q));
  }
  if (branch) items = items.filter((c) => c.branch === branch);

  const stats = {
    total: items.length,
    totalVehicles: items.reduce((sum, c) => sum + (c.vehicleCount || 0), 0),
    totalMonthlyRevenue: items.reduce((sum, c) => sum + (c.monthlyRevenue || 0), 0),
  };

  return new Response(
    JSON.stringify({ clientes: items, branches: BRANCHES, stats, currentUserId: session.userId }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
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

  let body: { clientName?: string; phone?: string; branch?: string; vehicleCount?: number; monthlyRevenue?: number; initialNote?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const clientName = String(body.clientName || '').trim();
  const phone = String(body.phone || '').trim();
  const branch = String(body.branch || '').trim();
  const vehicleCount = Math.max(0, parseInt(String(body.vehicleCount), 10) || 0);
  const monthlyRevenue = Math.max(0, parseInt(String(body.monthlyRevenue), 10) || 0);
  const initialNote = String(body.initialNote || '').trim();

  if (!clientName || !phone) {
    return new Response(JSON.stringify({ error: 'faltan campos obligatorios' }), { status: 400 });
  }
  if (branch && !BRANCHES.includes(branch)) {
    return new Response(JSON.stringify({ error: 'sucursal inválida' }), { status: 400 });
  }

  const creator = await findUserById(redis, session.userId);
  const now = new Date().toISOString();

  const cliente: ClienteMasivo = {
    id: randomUUID(),
    clientName,
    phone,
    branch,
    vehicleCount,
    monthlyRevenue,
    timeline: [],
    createdAt: now,
    updatedAt: now,
    createdById: session.userId,
    createdByName: creator?.name || session.username,
  };
  addEvent(cliente, `Cliente masivo registrado por ${cliente.createdByName}${initialNote ? ': ' + initialNote : ''}`, cliente.createdByName, now);

  await redis.hset(REDIS_KEY, { [cliente.id]: JSON.stringify(cliente) });
  await logAudit(redis, session, 'cliente_masivo_create', cliente.clientName, cliente.phone);

  return new Response(JSON.stringify({ cliente }), {
    headers: { 'Content-Type': 'application/json' },
  });
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

  let body: {
    id?: string;
    clientName?: string;
    phone?: string;
    branch?: string;
    vehicleCount?: number;
    monthlyRevenue?: number;
    addNote?: string;
  };
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
  const cliente: ClienteMasivo = { timeline: [], branch: '', vehicleCount: 0, monthlyRevenue: 0, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  const actor = await findUserById(redis, session.userId);
  const actorName = actor?.name || session.username;
  const now = new Date().toISOString();

  if (body.clientName !== undefined) {
    const name = String(body.clientName).trim();
    if (!name) return new Response(JSON.stringify({ error: 'el nombre no puede quedar vacío' }), { status: 400 });
    cliente.clientName = name;
  }
  if (body.phone !== undefined) {
    const phone = String(body.phone).trim();
    if (!phone) return new Response(JSON.stringify({ error: 'el teléfono no puede quedar vacío' }), { status: 400 });
    cliente.phone = phone;
  }
  if (body.branch !== undefined) {
    const branch = String(body.branch).trim();
    if (branch && !BRANCHES.includes(branch)) {
      return new Response(JSON.stringify({ error: 'sucursal inválida' }), { status: 400 });
    }
    cliente.branch = branch;
  }
  if (body.vehicleCount !== undefined) {
    const prev = cliente.vehicleCount;
    cliente.vehicleCount = Math.max(0, parseInt(String(body.vehicleCount), 10) || 0);
    if (cliente.vehicleCount !== prev) {
      addEvent(cliente, `${actorName} actualizó la cantidad de vehículos: ${prev} → ${cliente.vehicleCount}`, actorName, now);
    }
  }
  if (body.monthlyRevenue !== undefined) {
    const prev = cliente.monthlyRevenue;
    cliente.monthlyRevenue = Math.max(0, parseInt(String(body.monthlyRevenue), 10) || 0);
    if (cliente.monthlyRevenue !== prev) {
      addEvent(cliente, `${actorName} actualizó el recaudo mensual: $${prev.toLocaleString('es-CO')} → $${cliente.monthlyRevenue.toLocaleString('es-CO')}`, actorName, now);
    }
  }
  if (body.addNote) {
    addEvent(cliente, String(body.addNote).trim(), actorName, now);
  }

  cliente.updatedAt = now;
  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(cliente) });
  await logAudit(redis, session, 'cliente_masivo_update', cliente.clientName, JSON.stringify(body));

  return new Response(JSON.stringify({ cliente }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
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

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  await redis.hdel(REDIS_KEY, String(body.id || ''));
  await logAudit(redis, session, 'cliente_masivo_delete', String(body.id || ''));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
