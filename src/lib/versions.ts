// Contadores de versión para que los sondeos del panel (campanita, chat, alarma de apagados)
// no relean ni serialicen nada cuando no cambió nada: el cliente manda la versión que tiene y
// el servidor responde "sin cambios" con un solo GET a Redis. Cada escritura hace INCR.
export const NOTIF_VERSION_PREFIX = 'internal:ver:notif:';
export const CHAT_VERSION_KEY = 'internal:ver:chat';
export function chatVersionKey(userId: string): string {
  return `internal:ver:chat:${userId}`;
}
export const SHUTDOWNS_VERSION_KEY = 'internal:ver:shutdowns';
export const REPORTS_VERSION_KEY = 'internal:ver:reports';
export const LEADS_VERSION_KEY = 'internal:ver:leads';
export const COBROS_VERSION_KEY = 'internal:ver:cobros';

export function notifVersionKey(userId: string): string {
  return `${NOTIF_VERSION_PREFIX}${userId}`;
}

export async function bumpVersion(redis: any, key: string): Promise<void> {
  try {
    await redis.incr(key);
  } catch {
    // un contador que falla nunca debe tumbar la escritura real
  }
}

export async function readVersion(redis: any, key: string): Promise<string> {
  const v = await redis.get(key);
  return String(v ?? '0');
}

export function unchangedResponse(version: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ unchanged: true, version, ...extra }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
