import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { sendWhatsappTemplate, isQuietHoursColombia } from '../../lib/whatsapp';
import { readLeads, normalizePhone, REDIS_KEY as LEADS_KEY } from './leads';
import { appendHistory } from './whatsapp-webhook';

export const prerender = false;

const TEMPLATE_NAME = 'seguimiento_interesado';
const TEMPLATE_LANGUAGE = 'es_CO'; // crear la plantilla como "Español (COL)" en Meta, igual que recordatorio_pago
const COLD_INTERVAL_DAYS = 7; // cada cuánto se reintenta un lead frío
const MAX_COLD_FOLLOW_UPS = 8; // ~2 meses de intentos semanales, luego se deja en paz
const MIN_INACTIVE_DAYS = 7; // no tocar a alguien que sigue escribiendo activamente

// Vercel llama esto una vez al día (ver vercel.json). Reengancha, con la plantilla ya
// aprobada por Meta, a los leads que llevan días sin escribir — a diferencia de
// whatsapp-followup-cron (que solo insiste DENTRO de las 24h con texto libre), este cron
// alcanza a leads fríos de cualquier antigüedad, hasta que se instalen, se marquen sin
// interés (columna "Perdido" del CRM) o se agoten los intentos.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (secret && authHeader !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  // No mandamos plantillas de recordatorio entre 11pm y 6am hora Colombia.
  if (isQuietHoursColombia()) {
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 'quiet hours' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const now = Date.now();
  const leads = await readLeads(redis);
  let sent = 0;

  for (const lead of leads) {
    if (lead.installed || lead.status === 'Perdido') continue;
    const phone = normalizePhone(lead.phone);
    if (phone.length < 10) continue;

    const coldCount = lead.coldFollowUpCount || 0;
    if (coldCount >= MAX_COLD_FOLLOW_UPS) continue;

    // Si escribió hace poco, está activo — que lo atienda la conversación normal, no la plantilla.
    if (lead.lastInboundAt) {
      const daysSinceInbound = (now - new Date(lead.lastInboundAt).getTime()) / 86400000;
      if (daysSinceInbound < MIN_INACTIVE_DAYS) continue;
    }

    const anchor = lead.lastColdFollowUpAt || lead.lastInboundAt || lead.lastOutboundAt || lead.createdAt;
    const daysSinceAnchor = (now - new Date(anchor).getTime()) / 86400000;
    if (daysSinceAnchor < COLD_INTERVAL_DAYS) continue;

    const firstName = lead.name.trim().split(/\s+/)[0] || lead.name;
    const result = await sendWhatsappTemplate(phone, TEMPLATE_NAME, TEMPLATE_LANGUAGE, [firstName]);
    if (!result.ok) continue;

    const nowIso = new Date(now).toISOString();
    lead.coldFollowUpCount = coldCount + 1;
    lead.lastColdFollowUpAt = nowIso;
    lead.lastOutboundAt = nowIso;
    lead.updatedAt = nowIso;
    if (!lead.aiStage || lead.aiStage === 'sin_iniciar') lead.aiStage = 'en_conversacion';
    await redis.hset(LEADS_KEY, { [lead.id]: JSON.stringify(lead) });
    await appendHistory(redis, lead.id, [{ role: 'assistant', content: `[Plantilla ${TEMPLATE_NAME}] Hola ${firstName}, ¿sigues interesado en el GPS?` }]);
    sent++;
  }

  return new Response(JSON.stringify({ ok: true, sent }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
