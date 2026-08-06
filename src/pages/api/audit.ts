import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { readAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection } from '../../lib/auth';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'auditoria')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let entries = await readAudit(redis, 500);

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const action = url.searchParams.get('action') || '';
  if (q) {
    entries = entries.filter((e) =>
      e.username.toLowerCase().includes(q) ||
      e.action.toLowerCase().includes(q) ||
      e.target.toLowerCase().includes(q)
    );
  }
  if (action) entries = entries.filter((e) => e.action === action);

  return new Response(JSON.stringify({ entries }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
