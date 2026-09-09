import type { APIRoute } from 'astro';
import { SESSION_COOKIE, getSession, canViewWhatsappConversations } from '../../lib/auth';
import { readLeads } from './leads';
import { readCobros } from './cobros';
import { readHistory, readCobroHistory } from './whatsapp-webhook';
import { getRedis } from '../../lib/redis';

export const prerender = false;

async function requireAccess(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canViewWhatsappConversations(session)) return null;
  return session;
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

  const allLeads = await readLeads(redis);
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

  const allCobros = await readCobros(redis);
  const cobroItems = allCobros.map((c) => ({
    key: `valentina:${c.id}`,
    id: c.id,
    agent: 'valentina' as const,
    name: c.nombre,
    phone: c.telefono,
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

  let items = [...leadItems, ...cobroItems];
  if (agentFilter) items = items.filter((i) => i.agent === agentFilter);
  if (q) items = items.filter((i) => i.name.toLowerCase().includes(q) || i.phone.toLowerCase().includes(q));
  if (aiStage) items = items.filter((i) => i.aiStage === aiStage);
  items.sort((a, b) =>
    (b.lastInboundAt || b.updatedAt || b.createdAt).localeCompare(a.lastInboundAt || a.updatedAt || a.createdAt)
  );

  return new Response(JSON.stringify({ conversations: items }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
