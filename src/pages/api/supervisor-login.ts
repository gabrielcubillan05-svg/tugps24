import type { APIRoute } from 'astro';
import { checkSupervisorPassword, expectedSupervisorToken, isAuthorized, AUTH_COOKIE, SUPERVISOR_COOKIE } from '../../lib/internalAuth';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAuthorized(cookies.get(AUTH_COOKIE)?.value)) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
  }

  let password = '';
  try {
    const body = await request.json();
    password = String(body?.password || '');
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid body' }), { status: 400 });
  }

  if (!checkSupervisorPassword(password)) {
    return new Response(JSON.stringify({ ok: false, error: 'wrong password' }), { status: 401 });
  }

  const token = expectedSupervisorToken();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: 'not configured' }), { status: 503 });
  }

  cookies.set(SUPERVISOR_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 8,
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
