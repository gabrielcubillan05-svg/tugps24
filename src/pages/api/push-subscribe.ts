import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, verifySameOrigin } from '../../lib/auth';
import { saveUserPushSubscription, removeUserPushSubscription } from '../../lib/push';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const endpoint = String(body.subscription?.endpoint || '');
  const p256dh = String(body.subscription?.keys?.p256dh || '');
  const auth = String(body.subscription?.keys?.auth || '');
  if (!endpoint || !p256dh || !auth || endpoint.length > 1024) {
    return new Response(JSON.stringify({ error: 'suscripción inválida' }), { status: 400 });
  }
  // El servidor le hace POST a este endpoint firmando con la llave VAPID: solo servicios push
  // reales, nunca una URL interna o arbitraria (SSRF).
  let host = '';
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') throw new Error('no https');
    host = u.hostname;
  } catch {
    return new Response(JSON.stringify({ error: 'endpoint de push inválido' }), { status: 400 });
  }
  const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.samsungosp\.com$/];
  if (!PUSH_HOSTS.some((re) => re.test(host))) {
    return new Response(JSON.stringify({ error: 'servicio de push no reconocido' }), { status: 400 });
  }

  await saveUserPushSubscription(redis, session.userId, { endpoint, keys: { p256dh, auth } });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  await removeUserPushSubscription(redis, session.userId);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
