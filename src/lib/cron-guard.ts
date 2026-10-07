import { markCronOk } from './incidents';

// Vercel puede disparar un cron dos veces (reintento tras un error de red, despliegue a mitad
// de una corrida) y dos corridas cruzadas mandaban los mismos recordatorios dos veces. Cada
// cron toma un candado al empezar y marca cada envío con una llave de un solo uso por franja.

export async function runCronGuarded<T>(
  redis: any,
  name: string,
  lockSeconds: number,
  fn: () => Promise<T>
): Promise<{ skipped: string } | { result: T }> {
  const lockKey = `internal:cron-lock:${name}`;
  const lock = await redis.set(lockKey, '1', { nx: true, ex: lockSeconds });
  if (!lock) return { skipped: 'otra corrida en curso' };
  try {
    const result = await fn();
    await markCronOk(redis, name);
    return { result };
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

// true la primera vez que se pide esa llave dentro del plazo; false si ya se usó.
export async function claimOnce(redis: any, key: string, seconds = 2 * 86400): Promise<boolean> {
  try {
    return !!(await redis.set(key, '1', { nx: true, ex: seconds }));
  } catch {
    // Si Redis no responde se prefiere mandar el aviso (quizá repetido) a no mandarlo.
    return true;
  }
}

// Franja horaria en Colombia para distinguir corridas: "2026-10-07T14" (por hora) o "2026-10-07" (diaria).
export function cronSlot(hourly: boolean): string {
  const colombia = new Date(Date.now() - 5 * 3600 * 1000);
  const iso = colombia.toISOString();
  return hourly ? iso.slice(0, 13) : iso.slice(0, 10);
}
