import type { APIRoute } from 'astro';
import { SESSION_COOKIE, getSession, canViewWhatsappConversations } from '../../lib/auth';
import { readLeads } from './leads';
import { readHistory } from './whatsapp-webhook';
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

  if (id) {
    const history = await readHistory(redis, id);
    return new Response(JSON.stringify({ history }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const aiStage = url.searchParams.get('aiStage') || '';

  const allLeads = await readLeads(redis);
  let leads = allLeads.filter((l) => l.source === 'whatsapp-ads');
  if (q) {
    leads = leads.filter((l) => l.name.toLowerCase().includes(q) || l.phone.toLowerCase().includes(q));
  }
  if (aiStage) {
    leads = leads.filter((l) => (l.aiStage || 'sin_iniciar') === aiStage);
  }
  leads.sort((a, b) => (b.lastInboundAt || b.updatedAt).localeCompare(a.lastInboundAt || a.updatedAt));

  const summaries = leads.map((l) => ({
    id: l.id,
    name: l.name,
    phone: l.phone,
    city: l.city,
    vehicleType: l.vehicleType,
    aiStage: l.aiStage || 'sin_iniciar',
    secretary: l.secretary,
    lastInboundAt: l.lastInboundAt,
    lastOutboundAt: l.lastOutboundAt,
    createdAt: l.createdAt,
  }));

  return new Response(JSON.stringify({ leads: summaries }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
