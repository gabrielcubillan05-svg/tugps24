import type { APIRoute } from 'astro';
import { get } from '@vercel/blob';

export const prerender = false;

// Sirve, SIN sesión, los archivos de material del agente de WhatsApp (video de la central,
// recuperaciones, fotos de sucursal) para que los servidores de Meta puedan descargarlos al
// mandarlos por WhatsApp — no tienen forma de iniciar sesión en la app. Restringido al único
// prefijo "whatsapp-agent-media/" para no exponer nada más del almacenamiento privado.
export const GET: APIRoute = async ({ url }) => {
  const path = url.searchParams.get('path');
  if (!path || !path.startsWith('whatsapp-agent-media/')) {
    return new Response('forbidden', { status: 403 });
  }

  const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return new Response('not configured', { status: 503 });
  }

  try {
    const result = await get(path, { access: 'private', token });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return new Response('not found', { status: 404 });
    }
    return new Response(result.stream, {
      headers: {
        'Content-Type': result.blob.contentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return new Response('error', { status: 500 });
  }
};
