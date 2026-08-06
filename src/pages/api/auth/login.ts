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
  verifyPassword,
  verifySameOrigin,
  firstSectionFor,
  SECTION_PATHS,
} from '../../../lib/auth';

export const prerender = false;

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

  let user = await findUserByUsername(redis, username);
  if (!user) {
    user = await createBootstrapAdminIfMatches(redis, username, password);
  }

  if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
    await logAudit(redis, { userId: 'anon', username: username || 'desconocido' }, 'login_failed', username);
    return redirect(`${LOGIN_PATH}?error=1`);
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

  const section = firstSectionFor(user.role);
  return redirect(section ? SECTION_PATHS[section] : LOGIN_PATH);
};
