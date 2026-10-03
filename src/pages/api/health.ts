import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';

export const prerender = false;

// Chequeo para un monitor externo (UptimeRobot, Better Stack, etc.): responde 200 si Redis
// contesta y los crons importantes han corrido dentro de su plazo; 503 si no. No expone datos
// ni requiere sesión: solo "ok"/"fallo" y la antigüedad de cada cron en minutos.
const CRONS: { name: string; maxAgeMinutes: number }[] = [
  { name: 'apagados', maxAgeMinutes: 10 },
  { name: 'whatsapp-followup', maxAgeMinutes: 90 },
  { name: 'cleanup', maxAgeMinutes: 26 * 60 },
  { name: 'backup', maxAgeMinutes: 26 * 60 },
];

export const GET: APIRoute = async () => {
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ ok: false, redis: 'not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  const started = Date.now();
  let redisOk = false;
  try {
    redisOk = (await redis.ping()) === 'PONG';
  } catch {
    redisOk = false;
  }
  // Ida y vuelta de un solo comando: si pasa de 50 ms la base está lejos de la función.
  const redisPingMs = Date.now() - started;
  const crons: Record<string, { ageMinutes: number | null; ok: boolean }> = {};
  let cronsOk = true;
  if (redisOk) {
    for (const c of CRONS) {
      const last = await redis.get<string>(`internal:cron-ok:${c.name}`).catch(() => null);
      const ageMinutes = last ? Math.round((Date.now() - Date.parse(String(last))) / 60000) : null;
      // Un cron que nunca ha corrido todavía (recién desplegado) no cuenta como fallo.
      const ok = ageMinutes === null || ageMinutes <= c.maxAgeMinutes;
      crons[c.name] = { ageMinutes, ok };
      if (!ok) cronsOk = false;
    }
  }
  const ok = redisOk && cronsOk;
  return new Response(JSON.stringify({ ok, redis: redisOk ? 'ok' : 'down', redisPingMs, redisMs: Date.now() - started, crons }), {
    status: ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
