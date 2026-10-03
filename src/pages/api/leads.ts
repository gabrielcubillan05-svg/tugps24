import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { bumpVersion, readVersion, LEADS_VERSION_KEY } from '../../lib/versions';
import { branchForCityName } from '../../lib/pricing';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, canManageUsers, canVerifyInstalls, findUserById, verifySameOrigin } from '../../lib/auth';
import { isOverdueInColombia, todayInColombia, dateInColombia } from '../../lib/colombia-time';

export const prerender = false;

async function requireCrm(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'crm')) return null;
  return session;
}

export const REDIS_KEY = 'internal:leads';
export const STATUSES = ['Nuevo', 'Contactado', 'Cotizado', 'Concretado por el agente', 'Agendado', 'Instalado', 'Perdido'];

interface Note {
  text: string;
  date: string;
}

export interface Lead {
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
  installed: boolean;
  installedAt: string | null;
  verifiedInstalled: boolean;
  verifiedInstalledAt: string | null;
  scheduledInstallDate: string | null;
  source: 'manual' | 'meta-leadgen' | 'whatsapp-ads' | 'web-chat';
  metaLeadId: string | null;
  createdByName: string;
  notes: Note[];
  createdAt: string;
  updatedAt: string;
  // --- Agente IA de ventas por WhatsApp (opcional, solo aplica a leads de ese canal) ---
  aiStage?: 'sin_iniciar' | 'en_conversacion' | 'entregado' | 'escalado';
  aiHandoffAt?: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  followUpCount?: number;
  lastFollowUpAt?: string | null;
  mediaSentAt?: string | null;
  // --- Recordatorio frío por plantilla (leads que llevan días sin escribir) ---
  coldFollowUpCount?: number;
  lastColdFollowUpAt?: string | null;
  // --- Confirmación del gerente de que ya sabe de una venta concretada por el agente IA ---
  // (GaBot lo sigue recordando en cada corrida hasta que quede marcado) ---
  managerAckAt?: string | null;
  managerAckBy?: string | null;
  // --- Aviso de promoción de instalación ya enviado (whatsapp-promo-notice) ---
  promoNoticeSentAt?: string | null;
  // Andrés no pudo contestar de verdad (Anthropic caído, Meta rechazó el envío): el cron de
  // seguimiento lo reintenta solo mientras siga abierta la ventana de 24 h.
  needsRetry?: boolean;
  // Autorización de tratamiento de datos (Ley 1581): cuándo y por qué canal la dio.
  consentAt?: string | null;
  consentSource?: string | null;
  // El cliente pidió no recibir más mensajes: ningún cron ni aviso masivo le vuelve a escribir,
  // aunque alguien le cambie el estado en el CRM.
  optOut?: boolean;
}

const VEHICLE_TYPES = ['Moto', 'Carro', 'Flota', 'Máquina Amarilla', ''];

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  // Los celulares colombianos se guardan muchas veces sin el indicativo (10 dígitos,
  // empiezan por 3) — Meta siempre necesita el número completo (57 + 10 dígitos) tanto
  // para reconocer quién escribe como para poder enviarle un mensaje.
  if (digits.length === 10 && digits.startsWith('3')) return '57' + digits;
  return digits;
}

// Un "usuario de WhatsApp" (ej: @eliacaturbina07) puede traer dígitos sueltos que no
// representan un teléfono real; si lo tratáramos como tal, dos usuarios distintos con
// las mismas cifras sueltas (ej: "...07") se marcarían como duplicados entre sí.
function isPhoneLike(value: string): boolean {
  const v = String(value || '').trim();
  return /^[\d\s+().-]+$/.test(v) && v.replace(/\D/g, '').length >= 7;
}

export function computeOverdue(lead: Lead): boolean {
  if (!lead.nextFollowUp) return false;
  if (lead.status === 'Instalado' || lead.status === 'Perdido') return false;
  return isOverdueInColombia(lead.nextFollowUp.slice(0, 10));
}

// Rellena los campos que se fueron agregando con el tiempo, para que un lead viejo leído
// suelto (hget) se comporte igual que uno de la lista completa.
export function normalizeLead(l: any): Lead {
  return { notes: [], nextFollowUp: null, convertedBranch: null, campaign: '', vehicleType: '', motosCount: 0, carrosCount: 0, installed: false, installedAt: null, verifiedInstalled: false, verifiedInstalledAt: null, scheduledInstallDate: null, source: 'manual', metaLeadId: null, createdByName: '', aiStage: 'sin_iniciar', aiHandoffAt: null, lastInboundAt: null, lastOutboundAt: null, followUpCount: 0, lastFollowUpAt: null, mediaSentAt: null, coldFollowUpCount: 0, lastColdFollowUpAt: null, managerAckAt: null, managerAckBy: null, promoNoticeSentAt: null, needsRetry: false, consentAt: null, consentSource: null, optOut: false, ...l };
}

// El hash de leads pesa ~3 MB y se lee en el CRM (varias veces por carga), en el inicio de
// cada usuario, en cada mensaje de WhatsApp y en los crons. Cada lectura era bajar y parsear
// esos 3 MB de nuevo. Se guarda en memoria de la instancia junto con un contador de versión
// que sube en cada escritura (writeLeads/deleteLeads): si la versión no cambió, se devuelve
// una copia de lo ya parseado con una sola lectura chica. El TTL acota cualquier escritura
// que se salte el contador.
// Toda escritura pasa por writeLeads/deleteLeads (que suben la versión), así que el TTL es
// solo una red de seguridad; a 15 s anulaba casi todo el ahorro.
const LEADS_CACHE_TTL_MS = 5 * 60_000;
let leadsCache: { version: string; at: number; leads: Lead[] } | null = null;
let leadsInflight: Promise<Lead[]> | null = null;

export async function writeLeads(redis: any, fields: Record<string, string>): Promise<void> {
  await redis.hset(REDIS_KEY, fields);
  await bumpVersion(redis, LEADS_VERSION_KEY);
  leadsCache = null;
}

export async function deleteLeads(redis: any, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await redis.hdel(REDIS_KEY, ...ids);
  await bumpVersion(redis, LEADS_VERSION_KEY);
  leadsCache = null;
}

export async function readLeads(redis: any): Promise<Lead[]> {
  const version = await readVersion(redis, LEADS_VERSION_KEY);
  if (leadsCache && leadsCache.version === version && Date.now() - leadsCache.at < LEADS_CACHE_TTL_MS) {
    return structuredClone(leadsCache.leads);
  }
  // Varias peticiones a la vez (el CRM pide 4 páginas en ráfaga) comparten una sola lectura.
  if (!leadsInflight) {
    leadsInflight = readLeadsUncached(redis)
      .then((leads) => {
        leadsCache = { version, at: Date.now(), leads };
        return leads;
      })
      .finally(() => {
        leadsInflight = null;
      });
  }
  return structuredClone(await leadsInflight);
}

async function readLeadsUncached(redis: any): Promise<Lead[]> {
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
    .map(normalizeLead)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface SalesAgentStats {
  total: number;
  sinIniciar: number;
  enConversacion: number;
  concretados: number;
  escalados: number;
  sinInteres: number;
  // Lo de hoy (hora Colombia): leads nuevos que atendió y cuántos entregó a sucursal hoy.
  nuevosHoy: number;
  concretadosHoy: number;
}

// Resultados del agente IA (Andrés) — cuenta los leads de los canales donde él conversa de
// verdad con el cliente: WhatsApp Ads y el chat en vivo de la página web.
export function computeSalesAgentStats(leads: Lead[]): SalesAgentStats {
  const touched = leads.filter((l) => l.source === 'whatsapp-ads' || l.source === 'web-chat');
  const today = todayInColombia();
  const stats: SalesAgentStats = { total: touched.length, sinIniciar: 0, enConversacion: 0, concretados: 0, escalados: 0, sinInteres: 0, nuevosHoy: 0, concretadosHoy: 0 };
  for (const l of touched) {
    if (dateInColombia(l.createdAt) === today) stats.nuevosHoy++;
    if (l.aiStage === 'entregado' && l.aiHandoffAt && dateInColombia(l.aiHandoffAt) === today) stats.concretadosHoy++;
    switch (l.aiStage) {
      case 'en_conversacion':
        stats.enConversacion++;
        break;
      case 'entregado':
        stats.concretados++;
        break;
      case 'escalado':
        stats.escalados++;
        break;
      default:
        stats.sinIniciar++;
    }
    if (l.status === 'Perdido') stats.sinInteres++;
  }
  return stats;
}

const MAX_PAGE_SIZE = 1000;

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireCrm(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let leads = await readLeads(redis);
  // Una secretaria ve los leads que tiene asignados y los de su(s) sucursal(es); la vista
  // nacional queda para supervisor, gerente y admin. Antes cualquier secretaria veía y
  // exportaba los 3.470 leads del país. Si no tiene sucursal configurada, ve todo (como antes)
  // para no dejarla sin trabajo por un perfil incompleto.
  if (session.role === 'secretaria') {
    const me = await findUserById(redis, session.userId);
    const myBranches = me ? (me.branches && me.branches.length ? me.branches : me.branch ? [me.branch] : []) : [];
    if (myBranches.length) {
      leads = leads.filter((l) => l.secretary === me!.name || myBranches.includes(l.convertedBranch || branchForCityName(l.city) || ''));
    }
  }
  const withOverdue = leads.map((l) => ({ ...l, overdue: computeOverdue(l) }));

  const stats = { total: leads.length, byStatus: {} as Record<string, number>, overdueCount: 0 };
  STATUSES.forEach((s) => (stats.byStatus[s] = 0));
  withOverdue.forEach((l) => {
    stats.byStatus[l.status] = (stats.byStatus[l.status] || 0) + 1;
    if (l.overdue) stats.overdueCount += 1;
  });

  // Paginación opcional (offset/limit sobre la lista ya ordenada por última actividad): el
  // CRM pinta la primera página de inmediato y trae el resto en segundo plano. Sin
  // parámetros se devuelve todo, como antes.
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const limitParam = parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_PAGE_SIZE) : null;
  const page = limit === null ? withOverdue : withOverdue.slice(offset, offset + limit);

  return new Response(JSON.stringify({ leads: page, total: withOverdue.length, offset, limit, stats, statuses: STATUSES }), {
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
  if (!phone) {
    return new Response(JSON.stringify({ error: 'el teléfono es obligatorio' }), { status: 400 });
  }

  const normalizedPhone = isPhoneLike(phone) ? normalizePhone(phone) : '';
  const existingLeads = await readLeads(redis);
  const isDuplicate = normalizedPhone
    ? existingLeads.some((l) => isPhoneLike(l.phone) && normalizePhone(l.phone) === normalizedPhone)
    : existingLeads.some((l) => l.phone.trim().toLowerCase() === phone.toLowerCase());
  if (isDuplicate) {
    return new Response(JSON.stringify({ error: 'ya existe un lead guardado con ese teléfono o usuario' }), { status: 409 });
  }

  const now = new Date().toISOString();
  const initialNote = String((body as any).initialNote || '').trim();
  const creator = await findUserById(redis, session.userId);

  // Si ya trae una nota desde la creación, no tiene sentido que quede en "Nuevo" — es el
  // mismo criterio que ya se usa al agregar una nota a un lead existente.
  let initialStatus = STATUSES.includes(String(body.status)) ? String(body.status) : 'Nuevo';
  if (initialStatus === 'Nuevo' && initialNote) initialStatus = 'Contactado';

  const lead: Lead = {
    id: randomUUID(),
    name: name || phone,
    phone,
    city: String(body.city || '').trim(),
    campaign: String(body.campaign || '').trim(),
    secretary: String(body.secretary || '').trim() || creator?.name || session.username,
    status: initialStatus,
    nextFollowUp: body.nextFollowUp ? String(body.nextFollowUp) : null,
    convertedBranch: null,
    vehicleType: VEHICLE_TYPES.includes(String((body as any).vehicleType || '')) ? String((body as any).vehicleType || '') : '',
    motosCount: Number.isFinite(Number((body as any).motosCount)) ? Math.max(0, parseInt(String((body as any).motosCount), 10) || 0) : 0,
    carrosCount: Number.isFinite(Number((body as any).carrosCount)) ? Math.max(0, parseInt(String((body as any).carrosCount), 10) || 0) : 0,
    installed: false,
    verifiedInstalled: false,
    verifiedInstalledAt: null,
    scheduledInstallDate: null,
    source: 'manual',
    metaLeadId: null,
    createdByName: creator?.name || session.username,
    notes: initialNote ? [{ text: initialNote, date: now }] : [],
    createdAt: now,
    updatedAt: now,
  };

  await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
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
    installed?: boolean;
    scheduledInstallDate?: string | null;
    resetAiStage?: boolean;
    confirmVenta?: boolean;
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
    installed: false,
    verifiedInstalled: false,
    verifiedInstalledAt: null,
    scheduledInstallDate: null,
    source: 'manual',
    metaLeadId: null,
    createdByName: '',
    aiStage: 'sin_iniciar',
    aiHandoffAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    followUpCount: 0,
    lastFollowUpAt: null,
    mediaSentAt: null,
    coldFollowUpCount: 0,
    lastColdFollowUpAt: null,
    managerAckAt: null,
    managerAckBy: null,
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
    const normalizedPhone = isPhoneLike(phone) ? normalizePhone(phone) : '';
    const others = await readLeads(redis);
    const isDuplicate = normalizedPhone
      ? others.some((l) => l.id !== id && isPhoneLike(l.phone) && normalizePhone(l.phone) === normalizedPhone)
      : others.some((l) => l.id !== id && l.phone.trim().toLowerCase() === phone.toLowerCase());
    if (isDuplicate) {
      return new Response(JSON.stringify({ error: 'ya existe un lead guardado con ese teléfono o usuario' }), { status: 409 });
    }
    lead.phone = phone;
  }
  if (body.city !== undefined) {
    lead.city = String(body.city).trim();
  }
  if (body.campaign !== undefined) {
    lead.campaign = String(body.campaign).trim();
  }
  if (body.secretary !== undefined) {
    lead.secretary = String(body.secretary).trim();
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return new Response(JSON.stringify({ error: 'invalid status' }), { status: 400 });
    }
    const willBeInstalled = body.installed !== undefined ? Boolean(body.installed) : lead.installed;
    if (body.status === 'Perdido' && willBeInstalled) {
      return new Response(
        JSON.stringify({ error: 'no puedes marcar como "sin interés" un lead que ya está instalado' }),
        { status: 400 }
      );
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
  if (body.installed !== undefined) {
    const wasInstalled = lead.installed;
    lead.installed = Boolean(body.installed);
    if (lead.installed) {
      lead.status = 'Instalado';
      if (!wasInstalled) lead.installedAt = new Date().toISOString();
    } else if (lead.status === 'Instalado') {
      // Se desmarcó "instalado" (ej: se había marcado por error) — el estado no debe
      // quedarse pegado en "Instalado" si ya no lo está.
      lead.status = 'Contactado';
      lead.installedAt = null;
    }
  }
  if (body.scheduledInstallDate !== undefined) {
    lead.scheduledInstallDate = body.scheduledInstallDate || null;
    if (lead.scheduledInstallDate && ['Nuevo', 'Contactado', 'Cotizado', 'Concretado por el agente'].includes(lead.status)) {
      lead.status = 'Agendado';
    } else if (!lead.scheduledInstallDate && lead.status === 'Agendado') {
      // Si se borra la fecha (ej. el cliente dejó de contestar), el lead deja de estar
      // "Agendado" — vuelve a "Contactado" para que se note que hay que volver a gestionarlo.
      lead.status = 'Contactado';
    }
  }
  if (body.resetAiStage) {
    if (!canManageUsers(session.role)) {
      return new Response(JSON.stringify({ error: 'solo un administrador puede reiniciar la conversación con el agente' }), { status: 403 });
    }
    lead.aiStage = 'en_conversacion';
    lead.aiHandoffAt = null;
    lead.notes = [{ text: `${session.username} reinició la conversación con el agente IA.`, date: new Date().toISOString() }, ...lead.notes];
  }
  if (body.confirmVenta) {
    lead.managerAckAt = new Date().toISOString();
    lead.managerAckBy = session.name;
  }
  if (body.addNote) {
    lead.notes = [{ text: String(body.addNote).trim(), date: new Date().toISOString() }, ...lead.notes];
    if (lead.status === 'Nuevo') {
      lead.status = 'Contactado';
    }
  }
  lead.updatedAt = new Date().toISOString();

  await writeLeads(redis, { [id]: JSON.stringify(lead) });
  await logAudit(redis, session, 'lead_update', lead.id, Object.keys(body).filter((k) => k !== 'id').join(', '));

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

  // Borrar es destructivo: solo supervisor en adelante, no cualquier cuenta con CRM.
  if (!canVerifyInstalls(session.role)) {
    return new Response(JSON.stringify({ error: 'solo un supervisor, gerente o administrador puede borrar leads' }), { status: 403 });
  }

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const id = String(body.id || '');
  const raw = await redis.hget<string>(REDIS_KEY, id);
  const lead: Lead | null = raw ? normalizeLead(typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  await deleteLeads(redis, [id]);
  // Que no queden rastros del cliente: su conversación de WhatsApp y su entrada en el índice
  // de teléfonos (las llaves viven en whatsapp-webhook.ts; aquí se nombran para no crear un
  // import circular).
  await redis.hdel('internal:lead-whatsapp-conversations', id);
  const phone = lead ? normalizePhone(lead.phone) : '';
  if (phone) await redis.hdel('internal:whatsapp-phone-index', phone);
  await logAudit(redis, session, 'lead_delete', id);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
