import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { sendWhatsappText, isQuietHoursColombia } from '../../lib/whatsapp';
import { readLeads, REDIS_KEY as LEADS_KEY } from './leads';
import { appendHistory, sendReinforcementMedia } from './whatsapp-webhook';

export const prerender = false;

const MIN_HOURS_SINCE_LAST_REPLY = 3; // esperar unas horas de silencio antes de insistir
const MAX_HOURS_SINCE_LAST_INBOUND = 22; // margen de seguridad antes de que cierre la ventana de 24h de Meta
const MAX_FOLLOW_UPS = 2;

const FOLLOW_UP_MESSAGES = [
  'Hola de nuevo 😊 ¿sigues por ahí? Quedo atento si tienes alguna duda sobre el GPS o los precios, con gusto te ayudo.',
  'Solo para no perder el contacto: si te queda alguna pregunta sobre el servicio, dime y seguimos con gusto.',
];

// Vercel llama esto por cron (ver vercel.json). Revisa leads en conversación activa con el
// agente que se quedaron callados, y les manda un empujoncito — siempre DENTRO de las 24h
// desde su último mensaje, para poder usar texto libre sin necesitar una plantilla de Meta.
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

  // No insistimos entre 11pm y 6am hora Colombia — que se quede callado hasta que amanezca.
  if (isQuietHoursColombia()) {
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 'quiet hours' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const now = Date.now();
  const leads = await readLeads(redis);
  let sent = 0;

  for (const lead of leads) {
    if (lead.source !== 'whatsapp-ads') continue;
    if (lead.aiStage !== 'en_conversacion') continue;
    if (!lead.lastInboundAt || !lead.lastOutboundAt) continue;

    const lastInbound = new Date(lead.lastInboundAt).getTime();
    const lastOutbound = new Date(lead.lastOutboundAt).getTime();
    const lastFollowUp = lead.lastFollowUpAt ? new Date(lead.lastFollowUpAt).getTime() : 0;
    const followUpCount = lead.followUpCount || 0;

    if (lastInbound > lastOutbound) continue; // el cliente ya respondió, no hay nada que reenganchar
    if (followUpCount >= MAX_FOLLOW_UPS) continue; // ya se usaron los intentos disponibles

    const sinceLastReply = now - Math.max(lastOutbound, lastFollowUp);
    if (sinceLastReply < MIN_HOURS_SINCE_LAST_REPLY * 3600000) continue; // muy pronto todavía

    const hoursSinceInbound = (now - lastInbound) / 3600000;
    if (hoursSinceInbound >= MAX_HOURS_SINCE_LAST_INBOUND) continue; // ya se acerca a las 24h, no arriesgarse

    const message = FOLLOW_UP_MESSAGES[Math.min(followUpCount, FOLLOW_UP_MESSAGES.length - 1)];
    const result = await sendWhatsappText(lead.phone, message);
    if (!result.ok) continue;

    const nowIso = new Date(now).toISOString();
    lead.followUpCount = followUpCount + 1;
    lead.lastFollowUpAt = nowIso;
    lead.lastOutboundAt = nowIso;
    lead.updatedAt = nowIso;

    // En el segundo intento (una hora después del primero, ~4h de silencio en total) se
    // refuerza con el video de la central y una recuperación real — sin ser invasivos, solo
    // si no se le ha mandado antes por ningún otro medio.
    if (followUpCount === 1 && !lead.mediaSentAt) {
      await sendReinforcementMedia(redis, lead, lead.phone);
      lead.mediaSentAt = nowIso;
    }

    await redis.hset(LEADS_KEY, { [lead.id]: JSON.stringify(lead) });
    await appendHistory(redis, lead.id, [{ role: 'assistant', content: message }]);
    sent++;
  }

  return new Response(JSON.stringify({ ok: true, sent }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
