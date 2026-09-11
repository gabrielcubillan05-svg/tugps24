import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { isBulkSendWindowColombia } from '../../lib/whatsapp';
import { sendReminderBatch, BULK_REMINDER_BATCH_SIZE } from './cobros';
import { logAudit } from '../../lib/audit';

export const prerender = false;

// Vercel llama esto cada hora (ver vercel.json). Reparte el envío del recordatorio de
// cobranza en tandas de BULK_REMINDER_BATCH_SIZE (300) SOLO entre 8am y 6pm hora Colombia, para
// que un archivo grande recién subido (miles de registros) no le salga de golpe a todo el mundo
// y se vea como spam ante Meta. Si ya no queda nadie pendiente, simplemente no envía nada.
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

  if (!isBulkSendWindowColombia()) {
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 'fuera de la ventana 8am-6pm' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const result = await sendReminderBatch(redis, BULK_REMINDER_BATCH_SIZE);
  if (result.sent || result.failed) {
    await logAudit(
      redis,
      { userId: 'cron', username: 'whatsapp-cobros-bulk-cron' },
      'cobros_whatsapp_reminder_bulk_cron',
      `${result.sent} enviados`,
      result.failed ? `${result.failed} fallidos` : ''
    );
  }

  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
