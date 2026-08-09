import type { APIRoute } from 'astro';
import { getRedis } from '../../../lib/redis';
import { logAudit } from '../../../lib/audit';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  LOGIN_PATH,
  createSession,
  findUserByUsername,
  createBootstrapAdminIfMatches,
  saveUser,
  verifyPassword,
  verifySameOrigin,
  CHANGE_PASSWORD_PATH,
} from '../../../lib/auth';

export const prerender = false;

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_SECONDS = 15 * 60;

function loginAttemptsKey(username: string) {
  return `internal:login-attempts:${username.toLowerCase()}`;
}

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  if (!verifySameOrigin(request)) {
    return redirect(`${LOGIN_PATH}?error=1`);
  }

  const form = await request.formData();
  const username = String(form.get('username') || '').trim();
  const password = String(form.get('password') || '');

  if (!username || !password) {
    return redirect(`${LOGIN_PATH}?error=1`);
  }

  const redis = getRedis();
  if (!redis) {
    return redirect(`${LOGIN_PATH}?error=1`);
  }

  const attemptsKey = loginAttemptsKey(username);
  const attempts = Number((await redis.get<number>(attemptsKey)) || 0);
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    await logAudit(redis, { userId: 'anon', username: username || 'desconocido' }, 'login_locked', username);
    return redirect(`${LOGIN_PATH}?error=locked`);
  }

  let user = await findUserByUsername(redis, username);
  if (!user) {
    user = await createBootstrapAdminIfMatches(redis, username, password);
  }

  if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
    const newCount = await redis.incr(attemptsKey);
    if (newCount === 1) {
      await redis.expire(attemptsKey, LOGIN_LOCKOUT_SECONDS);
    }
    await logAudit(redis, { userId: 'anon', username: username || 'desconocido' }, 'login_failed', username);
    return redirect(`${LOGIN_PATH}?error=1`);
  }

  await redis.del(attemptsKey);

  // Autorreparación: la cuenta designada como admin de arranque (env var) siempre vuelve a
  // quedar con rol admin al iniciar sesión, por si se le cambió el rol por error desde Usuarios.
  const bootstrapUsername = import.meta.env.BOOTSTRAP_ADMIN_USERNAME;
  if (bootstrapUsername && user.username === bootstrapUsername && user.role !== 'admin') {
    user.role = 'admin';
    user.updatedAt = new Date().toISOString();
    await saveUser(redis, user);
    await logAudit(redis, { userId: user.id, username: user.username }, 'admin_role_self_healed', user.username);
  }

  const cookieValue = await createSession(user);
  if (!cookieValue) {
    return redirect(`${LOGIN_PATH}?error=1`);
  }

  cookies.set(SESSION_COOKIE, cookieValue, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
  });

  await logAudit(redis, { userId: user.id, username: user.username }, 'login', user.username);

  return redirect(user.mustChangePassword ? CHANGE_PASSWORD_PATH : '/interno');
};
