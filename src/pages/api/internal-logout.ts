import type { APIRoute } from 'astro';
import { AUTH_COOKIE, PANEL_PATH } from '../../lib/internalAuth';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect }) => {
  cookies.delete(AUTH_COOKIE, { path: '/' });
  return redirect(PANEL_PATH);
};
