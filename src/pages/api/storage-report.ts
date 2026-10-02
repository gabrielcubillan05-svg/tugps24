import type { APIRoute } from 'astro';
import { SESSION_COOKIE, getSession, canAccessSection, verifySameOrigin } from '../../lib/auth';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { computeStorageReport, runCleanup, describeCleanup } from '../../lib/storage-maintenance';

export const prerender = false;

async function requireAdmin(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'almacenamiento')) return null;
  return session;
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await requireAdmin(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const report = await computeStorageReport(redis);
  return new Response(JSON.stringify(report), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireAdmin(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  if (body.action !== 'simulate' && body.action !== 'run') {
    return new Response(JSON.stringify({ error: 'acción inválida' }), { status: 400 });
  }

  const summary = await runCleanup(redis, { dryRun: body.action === 'simulate' });
  if (!summary.dryRun) {
    await logAudit(redis, session, 'storage_cleanup_manual', describeCleanup(summary), summary.errors.join(' | ') || undefined);
  }
  return new Response(JSON.stringify({ summary, text: describeCleanup(summary) }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
