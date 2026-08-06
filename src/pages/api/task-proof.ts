import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAssignTasks } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:tasks';

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return new Response(JSON.stringify({ error: 'invalid content-type' }), { status: 400 });
  }

  const form = await request.formData();
  const id = String(form.get('id') || '');
  const photo = form.get('photo');

  if (!id || !(photo instanceof File) || photo.size === 0) {
    return new Response(JSON.stringify({ error: 'faltan campos (tarea o foto)' }), { status: 400 });
  }
  if (!photo.type.startsWith('image/')) {
    return new Response(JSON.stringify({ error: 'el archivo debe ser una foto' }), { status: 400 });
  }

  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'tarea no encontrada' }), { status: 404 });
  }
  const task: any = { notes: [], proof: null, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  const isManager = canAssignTasks(session.role);
  if (!isManager && task.assigneeId !== session.userId) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'almacenamiento no configurado' }), { status: 503 });
  }

  try {
    const blob = await put(`tasks/${id}-${randomUUID()}`, photo, {
      access: 'private',
      token,
      addRandomSuffix: false,
    });
    task.proof = { pathname: blob.pathname, contentType: photo.type };
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'fallo al subir la foto', detail: err instanceof Error ? err.message : String(err) }),
      { status: 500 }
    );
  }

  task.updatedAt = new Date().toISOString();
  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(task) });
  await logAudit(redis, session, 'task_proof_upload', task.title || id);

  return new Response(JSON.stringify({ task }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
