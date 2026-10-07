import type { APIRoute } from 'astro';
import { cronSecretMatches } from '../../lib/auth';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { markCronOk, reportIncident } from '../../lib/incidents';
import { INBOX_KEY, INBOX_MAX_ATTEMPTS, processInboundMessage, type InboxEntry } from './whatsapp-webhook';

export const prerender = false;

// Un mensaje recién llegado todavía puede estar siendo atendido por la invocación del webhook
// (espera del candado por número de hasta un minuto, más Anthropic con reintentos); solo se
// retoman los que llevan más de esto en el buzón.
const MIN_AGE_MS = 4 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TIME_BUDGET_MS = 200_000;
const ACTOR = { userId: 'whatsapp-agent', username: 'Agente IA (Andrés)' };

// Reintenta los mensajes de WhatsApp que quedaron en el buzón: la invocación que los atendía
// murió después de responderle a Meta, o el número estaba ocupado por otra invocación. Ver
// INBOX_KEY en whatsapp-webhook.ts.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (!secret || !cronSecretMatches(request.headers.get('authorization'), secret)) {
    return new Response('unauthorized', { status: 401 });
  }
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });

  const lock = await redis.set('internal:whatsapp-inbox-lock', '1', { nx: true, ex: 290 });
  if (!lock) return new Response(JSON.stringify({ ok: true, skipped: 'otra corrida en curso' }), { headers: { 'Content-Type': 'application/json' } });

  const started = Date.now();
  let retried = 0;
  let dropped = 0;
  let pending = 0;
  try {
    const raw = (await redis.hgetall<Record<string, unknown>>(INBOX_KEY)) || {};
    for (const [id, value] of Object.entries(raw)) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      let entry: InboxEntry;
      try {
        entry = typeof value === 'string' ? JSON.parse(value) : (value as InboxEntry);
      } catch {
        await redis.hdel(INBOX_KEY, id).catch(() => {});
        continue;
      }
      const age = Date.now() - Date.parse(entry.queuedAt || '');
      if (!(age > MIN_AGE_MS)) {
        pending++;
        continue;
      }
      const attempts = Number(entry.attempts) || 0;
      if (attempts >= INBOX_MAX_ATTEMPTS || age > MAX_AGE_MS) {
        await redis.hdel(INBOX_KEY, id).catch(() => {});
        dropped++;
        const tail = `…${String(entry.fromPhone || '').slice(-4)}`;
        await logAudit(redis, ACTOR, 'whatsapp_inbox_dropped', tail, `mensaje sin atender tras ${attempts} reintentos; revisar la conversación en el CRM`).catch(() => {});
        await reportIncident(redis, 'whatsapp_inbox_dropped', `${tail}: mensaje de WhatsApp sin atender tras ${attempts} reintentos`);
        continue;
      }
      entry.attempts = attempts + 1;
      await redis.hset(INBOX_KEY, { [id]: JSON.stringify(entry) }).catch(() => {});
      await logAudit(redis, ACTOR, 'whatsapp_inbox_retry', `…${String(entry.fromPhone || '').slice(-4)}`, `reintento ${entry.attempts} de ${INBOX_MAX_ATTEMPTS}`).catch(() => {});
      const done = await processInboundMessage(redis, entry);
      if (done) retried++;
      else pending++;
    }
    await markCronOk(redis, 'whatsapp-inbox');
  } finally {
    await redis.del('internal:whatsapp-inbox-lock').catch(() => {});
  }
  return new Response(JSON.stringify({ ok: true, retried, dropped, pending }), { headers: { 'Content-Type': 'application/json' } });
};
