import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

async function requireCrm(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'crm')) return null;
  return session;
}

const REDIS_KEY = 'internal:leads';
export const STATUSES = ['Nuevo', 'Contactado', 'Cotizado', 'Convertido', 'Perdido'];

interface Note {
  text: string;
  date: string;
}

interface Lead {
  id: string;
  name: string;
  phone: string;
  city: string;
  campaign: string;
  secretary: string;
  status: string;
  nextFollowUp: string | null;
  convertedBranch: string | null;
  vehicleType: string;
  motosCount: number;
  carrosCount: number;
  notes: Note[];
  createdAt: string;
  updatedAt: string;
}

const VEHICLE_TYPES = ['Moto', 'Carro', 'Flota', ''];

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

function computeOverdue(lead: Lead): boolean {
  if (!lead.nextFollowUp) return false;
  if (lead.status === 'Convertido' || lead.status === 'Perdido') return false;
  return new Date(lead.nextFollowUp).getTime() < new Date().setHours(0, 0, 0, 0);
}

async function readLeads(redis: any): Promise<Lead[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((l): l is Lead => l !== null)
    .map((l) => ({ notes: [], nextFollowUp: null, convertedBranch: null, campaign: '', vehicleType: '', motosCount: 0, carrosCount: 0, ...l }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!(await requireCrm(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const leads = await readLeads(redis);
  const withOverdue = leads.map((l) => ({ ...l, overdue: computeOverdue(l) }));

  const stats = { total: leads.length, byStatus: {} as Record<string, number>, overdueCount: 0 };
  STATUSES.forEach((s) => (stats.byStatus[s] = 0));
  withOverdue.forEach((l) => {
    stats.byStatus[l.status] = (stats.byStatus[l.status] || 0) + 1;
    if (l.overdue) stats.overdueCount += 1;
  });

  return new Response(JSON.stringify({ leads: withOverdue, stats, statuses: STATUSES }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCrm(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: Partial<Lead>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  if (!name || !phone) {
    return new Response(JSON.stringify({ error: 'nombre y teléfono son obligatorios' }), { status: 400 });
  }

  const normalizedPhone = normalizePhone(phone);
  const existingLeads = await readLeads(redis);
  if (existingLeads.some((l) => normalizePhone(l.phone) === normalizedPhone)) {
    return new Response(JSON.stringify({ error: 'ya existe un lead guardado con ese número de teléfono' }), { status: 409 });
  }

  const now = new Date().toISOString();
  const initialNote = String((body as any).initialNote || '').trim();

  const lead: Lead = {
    id: randomUUID(),
    name,
    phone,
    city: String(body.city || '').trim(),
    campaign: String(body.campaign || '').trim(),
    secretary: String(body.secretary || '').trim(),
    status: STATUSES.includes(String(body.status)) ? String(body.status) : 'Nuevo',
    nextFollowUp: body.nextFollowUp ? String(body.nextFollowUp) : null,
    convertedBranch: null,
    vehicleType: VEHICLE_TYPES.includes(String((body as any).vehicleType || '')) ? String((body as any).vehicleType || '') : '',
    motosCount: Number.isFinite(Number((body as any).motosCount)) ? Math.max(0, parseInt(String((body as any).motosCount), 10) || 0) : 0,
    carrosCount: Number.isFinite(Number((body as any).carrosCount)) ? Math.max(0, parseInt(String((body as any).carrosCount), 10) || 0) : 0,
    notes: initialNote ? [{ text: initialNote, date: now }] : [],
    createdAt: now,
    updatedAt: now,
  };

  await redis.hset(REDIS_KEY, { [lead.id]: JSON.stringify(lead) });
  await logAudit(redis, session, 'lead_create', lead.name, lead.phone);

  return new Response(JSON.stringify({ lead }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCrm(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: {
    id?: string;
    name?: string;
    phone?: string;
    city?: string;
    campaign?: string;
    status?: string;
    nextFollowUp?: string | null;
    convertedBranch?: string;
    addNote?: string;
    vehicleType?: string;
    motosCount?: number;
    carrosCount?: number;
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
  const lead: Lead = {
    notes: [],
    nextFollowUp: null,
    convertedBranch: null,
    campaign: '',
    vehicleType: '',
    motosCount: 0,
    carrosCount: 0,
    ...(typeof raw === 'string' ? JSON.parse(raw) : raw),
  };

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) {
      return new Response(JSON.stringify({ error: 'el nombre no puede quedar vacío' }), { status: 400 });
    }
    lead.name = name;
  }
  if (body.phone !== undefined) {
    const phone = String(body.phone).trim();
    if (!phone) {
      return new Response(JSON.stringify({ error: 'el teléfono no puede quedar vacío' }), { status: 400 });
    }
    const normalizedPhone = normalizePhone(phone);
    const others = await readLeads(redis);
    if (others.some((l) => l.id !== id && normalizePhone(l.phone) === normalizedPhone)) {
      return new Response(JSON.stringify({ error: 'ya existe un lead guardado con ese número de teléfono' }), { status: 409 });
    }
    lead.phone = phone;
  }
  if (body.city !== undefined) {
    lead.city = String(body.city).trim();
  }
  if (body.campaign !== undefined) {
    lead.campaign = String(body.campaign).trim();
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return new Response(JSON.stringify({ error: 'invalid status' }), { status: 400 });
    }
    lead.status = body.status;
  }
  if (body.nextFollowUp !== undefined) {
    lead.nextFollowUp = body.nextFollowUp || null;
  }
  if (body.convertedBranch !== undefined) {
    lead.convertedBranch = body.convertedBranch || null;
  }
  if (body.vehicleType !== undefined) {
    lead.vehicleType = VEHICLE_TYPES.includes(String(body.vehicleType)) ? String(body.vehicleType) : '';
  }
  if (body.motosCount !== undefined) {
    lead.motosCount = Math.max(0, parseInt(String(body.motosCount), 10) || 0);
  }
  if (body.carrosCount !== undefined) {
    lead.carrosCount = Math.max(0, parseInt(String(body.carrosCount), 10) || 0);
  }
  if (body.addNote) {
    lead.notes = [{ text: String(body.addNote).trim(), date: new Date().toISOString() }, ...lead.notes];
  }
  lead.updatedAt = new Date().toISOString();

  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(lead) });
  await logAudit(redis, session, 'lead_update', lead.name, JSON.stringify(body));

  return new Response(JSON.stringify({ lead: { ...lead, overdue: computeOverdue(lead) } }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCrm(cookies);
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
  await logAudit(redis, session, 'lead_delete', String(body.id || ''));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
