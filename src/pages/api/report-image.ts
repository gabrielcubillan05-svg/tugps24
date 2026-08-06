import type { APIRoute } from 'astro';
import { get } from '@vercel/blob';
import { isAuthorized, AUTH_COOKIE } from '../../lib/internalAuth';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies }) => {
  if (!isAuthorized(cookies.get(AUTH_COOKIE)?.value)) {
    return new Response('unauthorized', { status: 401 });
  }

  const path = url.searchParams.get('path');
  if (!path) {
    return new Response('missing path', { status: 400 });
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
        'Content-Type': result.blob.contentType || 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return new Response('error', { status: 500 });
  }
};
