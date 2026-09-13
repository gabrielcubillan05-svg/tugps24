// Límite de tasa simple basado en Redis (INCR + EXPIRE) — usado por endpoints públicos sin
// autenticación para protegerse de scripts/bots, sin depender de un servicio externo.

export function getClientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0].trim() : '') || 'unknown';
}

export async function checkAndIncrementRateLimit(redis: any, key: string, max: number, windowSeconds: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count <= max;
}
