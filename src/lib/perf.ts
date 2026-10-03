import { todayInColombia, addDaysToDateString } from './colombia-time';

// Medición propia de peticiones lentas. Vercel bloquea la duración por ruta en el plan actual
// de observabilidad, así que el middleware cronometra cada petición del lado del servidor y
// guarda por día las que pasan del umbral: cuántas y cuánto tardaron en promedio, por ruta.
// Si aquí no aparece nada y la gente igual siente el panel lento, el problema está en la red
// o en el navegador, no en el servidor.
export const SLOW_REQUEST_MS = 1000;
const TTL_SECONDS = 8 * 86400;

function dayKey(date: string): string {
  return `internal:perf:${date}`;
}

export async function recordSlowRequest(redis: any, path: string, ms: number): Promise<void> {
  try {
    const key = dayKey(todayInColombia());
    const route = path.slice(0, 80);
    const p = redis.pipeline();
    p.hincrby(key, `${route}|n`, 1);
    p.hincrby(key, `${route}|ms`, Math.round(ms));
    p.expire(key, TTL_SECONDS);
    await p.exec();
  } catch {
    // la medición nunca debe afectar la respuesta
  }
}

export interface SlowRoute {
  path: string;
  count: number;
  avgMs: number;
}

export async function readSlowRequests(redis: any, daysBack = 2): Promise<{ since: string; routes: SlowRoute[] }> {
  const today = todayInColombia();
  const dates = Array.from({ length: daysBack }, (_, i) => addDaysToDateString(today, -i));
  const p = redis.pipeline();
  for (const d of dates) p.hgetall(dayKey(d));
  const results: any[] = await p.exec();
  const agg = new Map<string, { n: number; ms: number }>();
  for (const raw of results) {
    for (const [field, value] of Object.entries((raw || {}) as Record<string, unknown>)) {
      const sep = field.lastIndexOf('|');
      if (sep < 0) continue;
      const route = field.slice(0, sep);
      const kind = field.slice(sep + 1);
      const cur = agg.get(route) || { n: 0, ms: 0 };
      if (kind === 'n') cur.n += Number(value) || 0;
      else if (kind === 'ms') cur.ms += Number(value) || 0;
      agg.set(route, cur);
    }
  }
  const routes = [...agg.entries()]
    .filter(([, v]) => v.n > 0)
    .map(([path, v]) => ({ path, count: v.n, avgMs: Math.round(v.ms / v.n) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
  return { since: dates[dates.length - 1], routes };
}
