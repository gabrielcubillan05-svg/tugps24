import type { APIRoute } from 'astro';
import { checkPassword, expectedToken, AUTH_COOKIE, PANEL_PATH } from '../../lib/internalAuth';

export const prerender = false;

const ALLOWED_REDIRECTS = [PANEL_PATH, '/cotizaciones'];

function safeRedirectPath(input: FormDataEntryValue | null): string {
  const path = String(input || '');
  return ALLOWED_REDIRECTS.includes(path) ? path : PANEL_PATH;
}

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const password = String(form.get('password') || '');
  const target = safeRedirectPath(form.get('redirect'));

  if (!checkPassword(password)) {
    return redirect(`${target}?error=1`);
  }

  const token = expectedToken();
  if (!token) {
    return redirect(`${target}?error=1`);
  }

  cookies.set(AUTH_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
  });

  return redirect(target);
};
