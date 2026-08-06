import type { APIRoute } from 'astro';
import { get } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canAccessSection } from '../../lib/auth';

export const prerender = false;

const TASK_PATH_RE = /^tasks\/([0-9a-f-]{36})-/i;

export const GET: APIRoute = async ({ url, cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response('unauthorized', { status: 401 });
  }

  const path = url.searchParams.get('path');
  if (!path) {
    return new Response('missing path', { status: 400 });
  }

  if (path.startsWith('reports/')) {
    if (!canAccessSection(session.role, 'novedades')) {
      return new Response('forbidden', { status: 403 });
    }
  } else if (path.startsWith('tasks/')) {
    const match = path.match(TASK_PATH_RE);
    const isManager = session.role === 'supervisor' || session.role === 'gerente' || session.role === 'admin';
    if (!isManager) {
      if (!match) {
        return new Response('forbidden', { status: 403 });
      }
      const redis = getRedis();
      if (!redis) {
        return new Response('not configured', { status: 503 });
      }
      const taskRaw = await redis.hget<string>('internal:tasks', match[1]);
      if (!taskRaw) {
        return new Response('forbidden', { status: 403 });
      }
      const task = typeof taskRaw === 'string' ? JSON.parse(taskRaw) : (taskRaw as any);
      if (task.assigneeId !== session.userId) {
        return new Response('forbidden', { status: 403 });
      }
    }
  } else {
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
        'Content-Type': result.blob.contentType || 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return new Response('error', { status: 500 });
  }
};
