import type { APIRoute } from 'astro';
import { getRedis } from '../../../lib/redis';
import { logAudit } from '../../../lib/audit';
import { SESSION_COOKIE, LOGIN_PATH, getSession, destroySession, verifySameOrigin } from '../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  if (!verifySameOrigin(request)) {
    return redirect(LOGIN_PATH);
  }
  const cookieValue = cookies.get(SESSION_COOKIE)?.value;
  const session = await getSession(cookieValue);
  if (session) {
    const redis = getRedis();
    if (redis) {
      await logAudit(redis, { userId: session.userId, username: session.username }, 'logout', session.username);
    }
  }
  await destroySession(cookieValue);
  cookies.delete(SESSION_COOKIE, { path: '/' });
  return redirect(LOGIN_PATH);
};
