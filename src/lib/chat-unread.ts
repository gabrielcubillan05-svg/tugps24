// Contadores de no leídos del chat interno, aparte del JSON de la conversación.
// Antes cada mensaje hacía "leer conversación → unread[x]++ → guardar conversación entera":
// dos mensajes a la vez (dos personas escribiendo en un grupo, o GPSITO contestando mientras
// alguien escribe) se pisaban y el contador perdía mensajes. HINCRBY es atómico en Redis, así
// que ningún incremento se pierde aunque lleguen en paralelo.
// Un hash por usuario (conversación → cantidad): el listado de conversaciones lo trae de una
// sola lectura chica. El campo `unread` del JSON de la conversación queda solo como valor
// heredado de antes del cambio y se usa mientras el hash no tenga ese campo.

function unreadKey(userId: string): string {
  return `internal:chat-unread:${userId}`;
}

export async function incrementUnread(redis: any, conversationId: string, userIds: string[]): Promise<void> {
  const targets = [...new Set(userIds.filter((id) => typeof id === 'string' && id))];
  if (!targets.length) return;
  await Promise.all(targets.map((userId) => redis.hincrby(unreadKey(userId), conversationId, 1)));
}

// Se escribe 0 en vez de borrar el campo: así el listado ya no cae al valor heredado del JSON,
// que puede quedar desactualizado si un envío lo guardó en paralelo.
export async function clearUnread(redis: any, userId: string, conversationId: string): Promise<void> {
  await redis.hset(unreadKey(userId), { [conversationId]: 0 });
}

export async function readUnreadMap(redis: any, userId: string): Promise<Record<string, number>> {
  const raw = (await redis.hgetall<Record<string, unknown>>(unreadKey(userId))) || {};
  const map: Record<string, number> = {};
  for (const [conversationId, value] of Object.entries(raw)) {
    const n = Number(value);
    map[conversationId] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  return map;
}
