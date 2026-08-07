import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import {
  SESSION_COOKIE,
  ROLES,
  getSession,
  findUserByUsername,
  saveUser,
  hashPassword,
  canManageUsers,
  verifySameOrigin,
  type Role,
  type User,
} from '../../lib/auth';
import employeeSeed from '../../data/employee-seed.json';

export const prerender = false;

const DEFAULT_PASSWORD = '1234';

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageUsers(session.role)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let created = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const entry of employeeSeed as { username: string; name: string; role: string }[]) {
    const username = String(entry.username || '').trim().toLowerCase();
    const role = entry.role as Role;
    if (!username || !ROLES.includes(role)) {
      skipped++;
      continue;
    }
    if (await findUserByUsername(redis, username)) {
      skipped++;
      continue;
    }
    const user: User = {
      id: randomUUID(),
      username,
      name: entry.name || username,
      passwordHash: hashPassword(DEFAULT_PASSWORD),
      role,
      active: true,
      createdAt: now,
      updatedAt: now,
      mustChangePassword: true,
    };
    await saveUser(redis, user);
    created++;
  }

  await logAudit(redis, session, 'user_bulk_seed', `${created} creados, ${skipped} omitidos`);

  return new Response(JSON.stringify({ created, skipped, total: employeeSeed.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
