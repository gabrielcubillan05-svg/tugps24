import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, getUsers, branchesOf, verifySameOrigin } from '../../lib/auth';
import { getProfile, saveProfile } from './employees';
import { computeVacationBalances, readContracts } from './contracts';

export const prerender = false;

const SELF_EDITABLE_FIELDS = ['telefono', 'direccion', 'correo'] as const;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const [profile, users, entries] = await Promise.all([getProfile(redis, session.userId), getUsers(redis), readContracts(redis)]);
  const me = users.find((u) => u.id === session.userId);
  const balances = await computeVacationBalances(redis, entries);
  const balance = me ? balances.find((b) => b.employee === me.name) : null;

  return new Response(
    JSON.stringify({
      name: me?.name || session.username,
      branches: me ? branchesOf(me) : [],
      profile,
      balance: balance || null,
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
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

  const body = await request.json().catch(() => null);
  const fields = body?.fields && typeof body.fields === 'object' ? body.fields : {};

  const existing = await getProfile(redis, session.userId);
  const updated = { ...existing };
  for (const key of SELF_EDITABLE_FIELDS) {
    if (fields[key] !== undefined) updated[key] = String(fields[key]);
  }

  await saveProfile(redis, session.userId, updated);

  return new Response(JSON.stringify({ ok: true, profile: updated }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
