import webpush from 'web-push';

const SUBSCRIPTIONS_KEY = 'internal:push-subscriptions';

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

let vapidConfigured = false;

// Se configura una sola vez por instancia de la función serverless — barato, no hay problema
// en llamarlo antes de cada envío.
function ensureVapidConfigured(): boolean {
  const publicKey = import.meta.env.VAPID_PUBLIC_KEY;
  const privateKey = import.meta.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails('mailto:soporte@tugps24.com', publicKey, privateKey);
    vapidConfigured = true;
  }
  return true;
}

export async function saveUserPushSubscription(redis: any, userId: string, subscription: PushSubscriptionData): Promise<void> {
  await redis.hset(SUBSCRIPTIONS_KEY, { [userId]: JSON.stringify(subscription) });
}

export async function removeUserPushSubscription(redis: any, userId: string): Promise<void> {
  await redis.hdel(SUBSCRIPTIONS_KEY, userId);
}

// Manda una notificación push real (llega aunque el navegador/app esté cerrada) — si el
// usuario no tiene suscripción guardada, o las llaves VAPID no están configuradas todavía,
// simplemente no hace nada (el aviso normal dentro de la campanita sigue funcionando igual).
export async function sendPushToUser(
  redis: any,
  userId: string,
  payload: { title: string; body: string; link?: string }
): Promise<void> {
  if (!ensureVapidConfigured()) return;
  const raw = await redis.hget<string>(SUBSCRIPTIONS_KEY, userId);
  if (!raw) return;

  let subscription: PushSubscriptionData;
  try {
    subscription = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return;
  }

  try {
    await webpush.sendNotification(subscription as any, JSON.stringify(payload));
  } catch (err: any) {
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      // La suscripción ya no es válida (el navegador la revocó) — se borra para no seguir
      // intentando en vano.
      await redis.hdel(SUBSCRIPTIONS_KEY, userId);
    } else {
      console.error('push: fallo al enviar', err instanceof Error ? err.message : String(err));
    }
  }
}
