import type { APIRoute } from 'astro';
import { checkPassword, expectedToken, AUTH_COOKIE, PANEL_PATH } from '../../lib/internalAuth';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const password = String(form.get('password') || '');

  if (!checkPassword(password)) {
    return redirect(`${PANEL_PATH}?error=1`);
  }

  const token = expectedToken();
  if (!token) {
    return redirect(`${PANEL_PATH}?error=1`);
  }

  cookies.set(AUTH_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
  });

  return redirect(PANEL_PATH);
};
