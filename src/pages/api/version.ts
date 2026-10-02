import type { APIRoute } from 'astro';
import { BUILD_ID } from '../../lib/build-id';

export const prerender = false;

// Sin sesión ni Redis a propósito: lo consulta cada pestaña del panel cada 45 s y solo
// devuelve el id del despliegue, que no es información sensible.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify({ build: BUILD_ID }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
