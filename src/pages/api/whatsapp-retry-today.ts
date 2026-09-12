import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { sendWhatsappText, isQuietHoursColombia } from '../../lib/whatsapp';
import { readLeads, REDIS_KEY as LEADS_KEY } from './leads';
import { readHistory, appendHistory, GENERIC_FALLBACK_TEXT } from './whatsapp-webhook';
import { SESSION_COOKIE, getSession, canManageAiAgents, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const RETRY_MESSAGE = 'Hola de nuevo 😊 disculpa la demora en contestarte — tuvimos un inconveniente técnico momentáneo. ¿En qué te puedo ayudar con el GPS?';

function todayInColombia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

function dateInColombia(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(iso));
}

// Acción manual de admin: cuando el agente de ventas (Andrés) se quedó sin poder responder de
// verdad a leads de hoy (ej. créditos de Anthropic agotados), igual les llegó un mensaje —
// pero fue el genérico de respaldo ("Gracias por tu mensaje, dame un momento."), no una
// respuesta real. Por eso NO alcanza con mirar quién tiene el mensaje más reciente: hay que
// revisar el CONTENIDO del último mensaje nuestro y detectar si fue ese relleno.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageAiAgents(session)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  if (isQuietHoursColombia()) {
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 0, reason: 'quiet-hours' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const today = todayInColombia();
  const leads = await readLeads(redis);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const lead of leads) {
    if (lead.source !== 'whatsapp-ads') continue;
    if (lead.aiStage !== 'en_conversacion') continue;
    if (dateInColombia(lead.createdAt) !== today) continue;

    const history = await readHistory(redis, lead.id);
    const lastMessage = history[history.length - 1];
    // Necesita reintento si nunca le contestamos (última fue del cliente) o si lo último
    // nuestro fue el relleno genérico — cualquier otra respuesta real, por corta que sea, se
    // deja tranquila para no interrumpir una conversación que sí avanzó.
    const needsRetry = !lastMessage || lastMessage.role === 'user' || (lastMessage.role === 'assistant' && lastMessage.content === GENERIC_FALLBACK_TEXT);
    if (!needsRetry) { skipped++; continue; }

    const result = await sendWhatsappText(lead.phone, RETRY_MESSAGE);
    if (!result.ok) { failed++; continue; }

    const nowIso = new Date().toISOString();
    lead.lastOutboundAt = nowIso;
    lead.updatedAt = nowIso;
    await redis.hset(LEADS_KEY, { [lead.id]: JSON.stringify(lead) });
    await appendHistory(redis, lead.id, [{ role: 'assistant', content: RETRY_MESSAGE }]);
    sent++;
  }

  await logAudit(redis, session, 'whatsapp_retry_today', `${sent} enviados`, `${skipped} omitidos, ${failed} fallidos`);

  return new Response(JSON.stringify({ ok: true, sent, skipped, failed }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
