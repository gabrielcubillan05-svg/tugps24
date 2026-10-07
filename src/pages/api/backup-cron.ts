import type { APIRoute } from 'astro';
import { cronSecretMatches } from '../../lib/auth';
import { put, list, del } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { reportIncident, markCronOk } from '../../lib/incidents';
import { todayInColombia } from '../../lib/colombia-time';
import { blobTimeout } from '../../lib/blob-path';

export const prerender = false;

// Respaldo diario de Redis a Blob (vercel.json, 2:30 a. m. Colombia, antes de la limpieza).
// Redis es la única base de datos y no había ninguna copia: un borrado accidental o una cuenta
// suspendida perdían todo. Cada llave internal:* se vuelca a backups/AAAA-MM-DD/<llave>.json,
// leyendo por bloques para no superar los 10 MB por petición de Upstash. Se conservan 30 días.
const KEEP_DAYS = 30;
const CHUNK = 500;
// Una lista enorme (novedades: decenas de MB) se parte en varios archivos de este tamaño en vez
// de un solo put gigante.
const LIST_PART = 5000;
// La función tiene 300 s: se para antes y lo que falte queda registrado; mañana vuelve a
// intentarse completo.
const TIME_BUDGET_MS = 240_000;
// Efímeras o reconstruibles: no vale la pena respaldarlas.
const SKIP_PREFIXES = [
  'internal:sessions', 'internal:ver:', 'internal:cache:', 'internal:notif-sync', 'internal:whatsapp-msg-seen:',
  'internal:shutdown-push:', 'internal:shutdown-late:', 'internal:shutdown-done:', 'internal:login-', 'internal:web-chat-rate:', 'internal:survey-rate:',
  'internal:incident', 'internal:cron-ok:', 'internal:cron-lock:', 'internal:cleanup-lock', 'internal:cobros-bulk-lock', 'internal:followup-lock',
  'internal:cold-followup-lock', 'internal:whatsapp-inbox-lock', 'internal:whatsapp-phone-lock:', 'internal:whatsapp-rate', 'internal:whatsapp-phone-index:rebuilt',
  'internal:reports-photos-purged-count', 'internal:security:', 'internal:perf:', 'internal:sim-consumos-staging:', 'internal:sim-consumos-commit:',
  'internal:sim-consumos-done:', 'internal:sim-consumos-rate:', 'internal:novedades-archivadas-rate:', 'internal:gabot-sent:', 'internal:agent-conv-seen:',
  'internal:backup-lock',
];
// Además de internal:*, la encuesta de la nueva sucursal vive bajo otro prefijo.
const SCAN_PATTERNS = ['internal:*', 'survey:*'];

async function dumpKey(redis: any, key: string, part?: { offset: number; limit: number }): Promise<unknown | null> {
  const type = String(await redis.type(key));
  if (type === 'hash') {
    const out: Record<string, unknown> = {};
    let cursor: string | number = 0;
    do {
      const [next, flat] = await redis.hscan(key, cursor, { count: CHUNK });
      cursor = next;
      const pairs = Array.isArray(flat) ? flat : [];
      for (let i = 0; i + 1 < pairs.length; i += 2) out[String(pairs[i])] = pairs[i + 1];
    } while (String(cursor) !== '0');
    return { type, value: out };
  }
  if (type === 'list') {
    const total = Number(await redis.llen(key)) || 0;
    const from = part ? part.offset : 0;
    const to = part ? Math.min(total, part.offset + part.limit) : total;
    const items: unknown[] = [];
    for (let offset = from; offset < to; offset += CHUNK) {
      items.push(...((await redis.lrange(key, offset, Math.min(to, offset + CHUNK) - 1)) || []));
    }
    return part ? { type, value: items, part: { offset: from, total } } : { type, value: items };
  }
  if (type === 'set') {
    const members: unknown[] = [];
    let cursor: string | number = 0;
    do {
      const [next, batch] = await redis.sscan(key, cursor, { count: CHUNK });
      cursor = next;
      members.push(...(Array.isArray(batch) ? batch : []));
    } while (String(cursor) !== '0');
    return { type, value: members };
  }
  if (type === 'string') return { type, value: await redis.get(key) };
  if (type === 'zset') return { type, value: await redis.zrange(key, 0, -1, { withScores: true }) };
  return null;
}

export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (!secret || !cronSecretMatches(request.headers.get('authorization'), secret)) {
    return new Response('unauthorized', { status: 401 });
  }
  const redis = getRedis();
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  if (!redis || !token) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  // Un reintento de Vercel o una corrida manual no deben solaparse con la que va a mitad.
  const lock = await redis.set('internal:backup-lock', '1', { nx: true, ex: 1500 });
  if (!lock) return new Response(JSON.stringify({ ok: true, skipped: 'otra corrida en curso' }), { headers: { 'Content-Type': 'application/json' } });

  const day = todayInColombia();
  const started = Date.now();
  let keysDone = 0;
  let bytes = 0;
  let outOfTime = false;
  const errors: string[] = [];
  const putOptions = { access: 'private' as const, token, addRandomSuffix: false, contentType: 'application/json' };
  const blobName = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');
  try {
    const keys: string[] = [];
    for (const pattern of SCAN_PATTERNS) {
      let cursor: string | number = 0;
      do {
        const [next, batch] = await redis.scan(cursor, { match: pattern, count: 200 });
        cursor = next;
        keys.push(...(batch as string[]));
      } while (String(cursor) !== '0');
    }

    for (const key of keys) {
      if (SKIP_PREFIXES.some((p) => key.startsWith(p))) continue;
      if (Date.now() - started > TIME_BUDGET_MS) {
        outOfTime = true;
        break;
      }
      try {
        const type = String(await redis.type(key));
        if (type === 'list') {
          const total = Number(await redis.llen(key)) || 0;
          for (let offset = 0; offset < Math.max(total, 1); offset += LIST_PART) {
            const dump = await dumpKey(redis, key, { offset, limit: LIST_PART });
            if (!dump) break;
            const body = JSON.stringify({ key, exportedAt: new Date().toISOString(), ...dump });
            bytes += body.length;
            const suffix = total > LIST_PART ? `.parte-${String(offset / LIST_PART + 1).padStart(3, '0')}` : '';
            await put(`backups/${day}/${blobName(key)}${suffix}.json`, body, { ...putOptions, abortSignal: blobTimeout(60_000) });
          }
        } else {
          const dump = await dumpKey(redis, key);
          if (!dump) continue;
          const body = JSON.stringify({ key, exportedAt: new Date().toISOString(), ...dump });
          bytes += body.length;
          await put(`backups/${day}/${blobName(key)}.json`, body, { ...putOptions, abortSignal: blobTimeout(60_000) });
        }
        keysDone++;
      } catch (err) {
        errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Retención: se borran las carpetas de respaldo con más de KEEP_DAYS días.
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    let oldCursor: string | undefined;
    do {
      const page = await list({ prefix: 'backups/', token, cursor: oldCursor, limit: 1000, abortSignal: blobTimeout(20_000) });
      const old = page.blobs.filter((b) => (b.pathname.split('/')[1] || '') < cutoff).map((b) => b.url);
      if (old.length) await del(old, { token, abortSignal: blobTimeout(20_000) });
      oldCursor = page.hasMore ? page.cursor : undefined;
    } while (oldCursor);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    await redis.del('internal:backup-lock').catch(() => {});
  }
  if (outOfTime) errors.push('se agotó el tiempo: el respaldo de hoy quedó incompleto');

  const summary = `${keysDone} llaves respaldadas (${Math.round(bytes / 1024 / 1024)} MB) en ${Math.round((Date.now() - started) / 1000)} s${errors.length ? ` · ${errors.length} errores` : ''}`;
  await logAudit(redis, { userId: 'sistema', username: 'respaldo-automatico' }, 'backup', summary, errors.slice(0, 5).join(' | ') || undefined);
  if (errors.length) await reportIncident(redis, 'backup_errors', errors.slice(0, 3).join(' | '));
  else await markCronOk(redis, 'backup');

  return new Response(JSON.stringify({ ok: !errors.length, keysDone, bytes, errors }), { headers: { 'Content-Type': 'application/json' } });
};
