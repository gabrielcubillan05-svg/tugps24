import type { APIRoute } from 'astro';
import { BUILD_ID } from '../../lib/build-id';
import { readVersion, notifVersionKey, unchangedResponse } from '../../lib/versions';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, verifySameOrigin } from '../../lib/auth';
import {
  syncComputedNotifications,
  readNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '../../lib/notifications';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  await syncComputedNotifications(redis, session);
  // La campanita manda la versión que ya tiene: si no hubo escrituras desde entonces, no se
  // lee ni se serializa el hash (es el sondeo más frecuente de todo el panel).
  const version = await readVersion(redis, notifVersionKey(session.userId));
  const known = url.searchParams.get('v');
  if (known && known === version) return unchangedResponse(version, { build: BUILD_ID });

  const { notifications, unreadCount } = await readNotifications(redis, session.userId);

  return new Response(JSON.stringify({ notifications: notifications.slice(0, 100), unreadCount, version, build: BUILD_ID }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
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

  let body: { id?: string; markAllRead?: boolean };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  if (body.markAllRead) {
    await markAllNotificationsRead(redis, session.userId);
  } else if (body.id) {
    await markNotificationRead(redis, session.userId, String(body.id));
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
