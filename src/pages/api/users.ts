import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import {
  SESSION_COOKIE,
  ROLES,
  getSession,
  getUsers,
  findUserByUsername,
  findUserById,
  saveUser,
  hashPassword,
  verifyPassword,
  canManageUsers,
  canAssignTasks,
  canAccessSection,
  destroyAllSessionsForUser,
  verifySameOrigin,
  type Role,
  type User,
} from '../../lib/auth';

export const prerender = false;

function publicUser(u: User) {
  const { passwordHash, ...rest } = u;
  return rest;
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const isPrivileged = canManageUsers(session.role) || canAssignTasks(session.role);
  const roleParam = url.searchParams.get('role');

  if (!isPrivileged) {
    // Acceso reducido: solo para poblar el selector de secretarias en el CRM.
    if (!canAccessSection(session.role, 'crm') || roleParam !== 'secretaria') {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  let users = await getUsers(redis);
  if (!isPrivileged) {
    users = users.filter((u) => u.role === 'secretaria' && u.active);
  } else if (roleParam) {
    users = users.filter((u) => u.role === roleParam);
  }
  return new Response(JSON.stringify({ users: users.map(publicUser), roles: ROLES }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

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

  let body: { username?: string; name?: string; password?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const username = String(body.username || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const role = String(body.role || '') as Role;

  if (!username || !name || !password || !ROLES.includes(role)) {
    return new Response(JSON.stringify({ error: 'campos incompletos o rol inválido' }), { status: 400 });
  }
  if (password.length < 8) {
    return new Response(JSON.stringify({ error: 'la contraseña debe tener al menos 8 caracteres' }), { status: 400 });
  }
  if (await findUserByUsername(redis, username)) {
    return new Response(JSON.stringify({ error: 'ese usuario ya existe' }), { status: 409 });
  }

  const now = new Date().toISOString();
  const user: User = {
    id: randomUUID(),
    username,
    name,
    passwordHash: hashPassword(password),
    role,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await saveUser(redis, user);
  await logAudit(redis, session, 'user_create', username, role);

  return new Response(JSON.stringify({ user: publicUser(user) }), {
    headers: { 'Content-Type': 'application/json' },
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

  let body: {
    id?: string;
    name?: string;
    role?: string;
    active?: boolean;
    password?: string;
    currentPassword?: string;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const id = String(body.id || '');
  const isSelf = id === session.userId;
  const isAdmin = canManageUsers(session.role);
  if (!isSelf && !isAdmin) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const user = await findUserById(redis, id);
  if (!user) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }

  if (!isAdmin) {
    // Autoservicio: un usuario solo puede cambiar su propia contraseña, nada más.
    if (body.name !== undefined || body.role !== undefined || body.active !== undefined) {
      return new Response(JSON.stringify({ error: 'no autorizado para editar esos campos' }), { status: 403 });
    }
    if (!body.password) {
      return new Response(JSON.stringify({ error: 'falta la nueva contraseña' }), { status: 400 });
    }
    if (!body.currentPassword || !verifyPassword(body.currentPassword, user.passwordHash)) {
      return new Response(JSON.stringify({ error: 'la contraseña actual no es correcta' }), { status: 401 });
    }
    if (String(body.password).length < 8) {
      return new Response(JSON.stringify({ error: 'la contraseña debe tener al menos 8 caracteres' }), { status: 400 });
    }
    user.passwordHash = hashPassword(String(body.password));
    user.updatedAt = new Date().toISOString();
    await saveUser(redis, user);
    await logAudit(redis, session, 'user_password_self_change', user.username);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.name !== undefined) {
    user.name = String(body.name).trim();
  }
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role as Role)) {
      return new Response(JSON.stringify({ error: 'rol inválido' }), { status: 400 });
    }
    user.role = body.role as Role;
  }
  if (body.password !== undefined && body.password !== '') {
    if (String(body.password).length < 8) {
      return new Response(JSON.stringify({ error: 'la contraseña debe tener al menos 8 caracteres' }), { status: 400 });
    }
    user.passwordHash = hashPassword(String(body.password));
    if (!isSelf) await destroyAllSessionsForUser(redis, user.id);
  }
  if (body.active !== undefined) {
    if (user.id === session.userId && body.active === false) {
      return new Response(JSON.stringify({ error: 'no puedes desactivar tu propia cuenta' }), { status: 400 });
    }
    user.active = Boolean(body.active);
    if (!user.active) {
      await destroyAllSessionsForUser(redis, user.id);
    }
  }
  user.updatedAt = new Date().toISOString();

  await saveUser(redis, user);
  await logAudit(redis, session, 'user_update', user.username, JSON.stringify({ ...body, password: body.password ? '***' : undefined }));

  return new Response(JSON.stringify({ user: publicUser(user) }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
