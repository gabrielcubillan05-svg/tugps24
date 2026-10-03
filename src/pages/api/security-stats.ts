import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canAccessSection } from '../../lib/auth';
import { readSecurityStats } from '../../lib/security-events';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'auditoria')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const stats = await readSecurityStats(redis, 7);
  return new Response(JSON.stringify(stats), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
