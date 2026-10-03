import type { APIRoute } from 'astro';
import { getRedis } from '../../../lib/redis';
import { logAudit } from '../../../lib/audit';
import { getClientIp, checkAndIncrementRateLimit } from '../../../lib/rate-limit';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  LOGIN_PATH,
  createSession,
  findUserByUsername,
  createBootstrapAdminIfMatches,
  saveUser,
  verifyPassword,
  hashPassword,
  verifySameOrigin,
  CHANGE_PASSWORD_PATH,
} from '../../../lib/auth';

export const prerender = false;

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_SECONDS = 15 * 60;
// Tope por IP además del bloqueo por usuario: sin él, un tercero bloqueaba a cualquier cuenta
// con 5 intentos, y podía probar claves sobre decenas de usuarios sin tocar ningún límite.
const MAX_ATTEMPTS_PER_IP = 20;
// Hash de relleno para que un usuario inexistente tarde lo mismo que uno real (scrypt).
const DUMMY_HASH = hashPassword('relleno-tiempo-constante');

// El bloqueo es por usuario + IP: así un atacante remoto no deja fuera al dueño real de la cuenta.
function loginAttemptsKey(username: string, ip: string) {
  return `internal:login-attempts:${username.toLowerCase()}:${ip}`;
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

  const ip = getClientIp(request);
  const okIp = await checkAndIncrementRateLimit(redis, `internal:login-ip:${ip}`, MAX_ATTEMPTS_PER_IP, LOGIN_LOCKOUT_SECONDS);
  if (!okIp) {
    await logAudit(redis, { userId: 'anon', username: username || 'desconocido' }, 'login_locked', `${username} (ip)`);
    return redirect(`${LOGIN_PATH}?error=locked`);
  }
  const attemptsKey = loginAttemptsKey(username, ip);
  const attempts = Number((await redis.get<number>(attemptsKey)) || 0);
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    await logAudit(redis, { userId: 'anon', username: username || 'desconocido' }, 'login_locked', username);
    return redirect(`${LOGIN_PATH}?error=locked`);
  }

  let user = await findUserByUsername(redis, username);
  if (!user) {
    user = await createBootstrapAdminIfMatches(redis, username, password);
  }

  const passwordOk = verifyPassword(password, user?.passwordHash || DUMMY_HASH);
  if (!user || !user.active || !passwordOk) {
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
