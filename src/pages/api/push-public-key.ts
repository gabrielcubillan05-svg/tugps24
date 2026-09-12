import type { APIRoute } from 'astro';
import { SESSION_COOKIE, getSession } from '../../lib/auth';

export const prerender = false;

// La llave pública VAPID no es secreta (por diseño de Web Push), pero igual se exige sesión
// solo para no exponer nada del panel a quien no esté ni logueado.
export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const publicKey = import.meta.env.VAPID_PUBLIC_KEY || '';
  return new Response(JSON.stringify({ publicKey }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
