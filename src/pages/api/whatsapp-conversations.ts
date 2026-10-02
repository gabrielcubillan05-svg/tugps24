import type { APIRoute } from 'astro';
import { SESSION_COOKIE, getSession, canViewWhatsappConversations } from '../../lib/auth';
import { readLeads, normalizePhone } from './leads';
import { readCobros } from './cobros';
import { readHistory, readCobroHistory } from './whatsapp-webhook';
import { getRedis } from '../../lib/redis';

export const prerender = false;

const MAX_PAGE_SIZE = 500;

async function requireAccess(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canViewWhatsappConversations(session)) return null;
  return session;
}

export const GET: APIRoute = async (ctx) => {
  try {
    return await handleGet(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('whatsapp-conversations: fallo al listar', message);
    return new Response(JSON.stringify({ error: `error al cargar conversaciones: ${message}` }), { status: 500 });
  }
};

async function handleGet({ cookies, url }: Parameters<APIRoute>[0]): Promise<Response> {
  const session = await requireAccess(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const id = url.searchParams.get('id');
  const agentParam = url.searchParams.get('agent') || '';

  if (id) {
    const history = agentParam === 'valentina' ? await readCobroHistory(redis, id) : await readHistory(redis, id);
    return new Response(JSON.stringify({ history }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const aiStage = url.searchParams.get('aiStage') || '';
  const agentFilter = url.searchParams.get('agent') || '';

  const [allLeads, allCobros] = await Promise.all([readLeads(redis), readCobros(redis)]);
  const leadItems = allLeads
    .filter((l) => l.source === 'whatsapp-ads')
    .map((l) => ({
      key: `andres:${l.id}`,
      id: l.id,
      agent: 'andres' as const,
      name: l.name,
      phone: l.phone,
      city: l.city,
      vehicleType: l.vehicleType,
      aiStage: l.aiStage || 'sin_iniciar',
      secretary: l.secretary,
      lastInboundAt: l.lastInboundAt,
      lastOutboundAt: l.lastOutboundAt,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      deuda: null as number | null,
    }));

  const cobroItems = allCobros.map((c) => ({
    key: `valentina:${c.id}`,
    id: c.id,
    agent: 'valentina' as const,
    name: c.nombre,
    phone: normalizePhone(c.telefono) || c.telefono,
    city: c.sucursal,
    vehicleType: '',
    aiStage: c.aiStage || 'sin_iniciar',
    secretary: c.assignedTo,
    lastInboundAt: c.lastInboundAt,
    lastOutboundAt: c.lastOutboundAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    deuda: c.deuda,
  }));

  // Un solo registro sin nombre, teléfono o fechas (cargas masivas viejas, datos a medio
  // guardar) no debe tumbar la lista completa: se normaliza todo a texto antes de filtrar
  // y ordenar.
  let items = [...leadItems, ...cobroItems].map((i) => ({
    ...i,
    name: String(i.name || i.phone || 'Sin nombre'),
    phone: String(i.phone || ''),
    lastActivity: String(i.lastInboundAt || i.updatedAt || i.createdAt || ''),
  }));
  if (agentFilter) items = items.filter((i) => i.agent === agentFilter);
  if (q) items = items.filter((i) => i.name.toLowerCase().includes(q) || i.phone.toLowerCase().includes(q));
  if (aiStage) items = items.filter((i) => i.aiStage === aiStage);
  items.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  // Paginación (offset/limit sobre la lista ya ordenada): mandar todas las conversaciones de
  // golpe superaba lo que Vercel deja responder y la página quedaba en "No se pudo cargar".
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const limitParam = parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_PAGE_SIZE) : MAX_PAGE_SIZE;
  const page = items.slice(offset, offset + limit);

  return new Response(JSON.stringify({ conversations: page, total: items.length, offset, limit }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
