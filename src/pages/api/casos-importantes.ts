import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import { SESSION_COOKIE, getSession, canAccessSection, getUsers, findUserById, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:casos-importantes';
export const CATEGORIES = ['Robo', 'Intento de robo', 'Accidente', 'Pérdida de señal prolongada', 'Amenaza', 'Novedad grave', 'Otro'];
export const BRANCHES = ['Riohacha', 'Valledupar', 'Santa Marta', 'Maicao', 'Atlántico', 'Bucaramanga', 'Medellín', 'Montería'];
export const STATUSES = ['Abierto', 'En seguimiento', 'Finalizado'];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface Note {
  text: string;
  date: string;
  authorName: string;
}

interface Caso {
  id: string;
  plate: string;
  branch: string;
  category: string;
  description: string;
  images: string[];
  status: string;
  notes: Note[];
  createdAt: string;
  updatedAt: string;
  createdByName: string;
  createdById: string;
  finalizedAt: string | null;
  finalizedByName: string;
}

async function requireCasos(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'casos-importantes')) return null;
  return session;
}

async function readCasos(redis: any): Promise<Caso[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((c): c is Caso => c !== null)
    .map((c) => ({ notes: [], finalizedAt: null, finalizedByName: '', ...c }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireCasos(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const branch = url.searchParams.get('branch') || '';
  const category = url.searchParams.get('category') || '';
  const status = url.searchParams.get('status') || '';

  let casos = await readCasos(redis);

  if (q) {
    casos = casos.filter((c) =>
      c.plate.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.branch.toLowerCase().includes(q)
    );
  }
  if (branch) casos = casos.filter((c) => c.branch === branch);
  if (category) casos = casos.filter((c) => c.category === category);
  if (status) casos = casos.filter((c) => c.status === status);

  return new Response(
    JSON.stringify({ casos, categories: CATEGORIES, branches: BRANCHES, statuses: STATUSES }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCasos(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const contentType = request.headers.get('content-type') || '';
  let plate = '';
  let branch = '';
  let category = '';
  let description = '';
  let imageFiles: File[] = [];

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    plate = String(form.get('plate') || '').trim();
    branch = String(form.get('branch') || '').trim();
    category = String(form.get('category') || '').trim();
    description = String(form.get('description') || '').trim();
    imageFiles = form.getAll('images').filter((v): v is File => v instanceof File && v.size > 0);
  } else {
    let body: Partial<Caso>;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
    }
    plate = String(body.plate || '').trim();
    branch = String(body.branch || '').trim();
    category = String(body.category || '').trim();
    description = String(body.description || '').trim();
  }

  if (!plate || !branch || !category || !description) {
    return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400 });
  }
  if (!BRANCHES.includes(branch) || !CATEGORIES.includes(category)) {
    return new Response(JSON.stringify({ error: 'invalid branch or category' }), { status: 400 });
  }
  for (const file of imageFiles) {
    if (!file.type.startsWith('image/')) {
      return new Response(JSON.stringify({ error: 'los adjuntos deben ser imágenes' }), { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return new Response(JSON.stringify({ error: 'cada imagen debe pesar menos de 8MB' }), { status: 400 });
    }
  }

  const id = randomUUID();
  const images: string[] = [];

  if (imageFiles.length) {
    const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({ error: 'almacenamiento de imágenes no configurado' }), { status: 503 });
    }
    try {
      for (const file of imageFiles.slice(0, MAX_IMAGES)) {
        const blob = await put(`casos/${id}-${randomUUID()}`, file, {
          access: 'private',
          token,
          addRandomSuffix: false,
        });
        images.push(blob.pathname);
      }
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'fallo al subir imagen', detail: err instanceof Error ? err.message : String(err) }),
        { status: 500 }
      );
    }
  }

  const creator = await findUserById(redis, session.userId);
  const now = new Date().toISOString();

  const caso: Caso = {
    id,
    plate: plate.toUpperCase(),
    branch,
    category,
    description,
    images,
    status: 'Abierto',
    notes: [],
    createdAt: now,
    updatedAt: now,
    createdByName: creator?.name || session.username,
    createdById: session.userId,
    finalizedAt: null,
    finalizedByName: '',
  };

  await redis.hset(REDIS_KEY, { [caso.id]: JSON.stringify(caso) });
  await logAudit(redis, session, 'caso_importante_create', `${caso.plate} · ${caso.branch}`, caso.category);

  const managers = (await getUsers(redis)).filter(
    (u) => u.active && u.id !== session.userId && (u.role === 'supervisor' || u.role === 'gerente' || u.role === 'admin')
  );
  for (const manager of managers) {
    try {
      await pushNotification(redis, manager.id, {
        type: 'caso-importante',
        message: `Caso importante: ${caso.plate} · ${caso.branch} (${caso.category})`,
        link: '/interno/casos-importantes',
      });
    } catch {
      // no debe tumbar el guardado del caso si falla notificar a un gerente puntual
    }
  }

  return new Response(JSON.stringify({ caso }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCasos(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string; status?: string; addNote?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const id = String(body.id || '');
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const caso: Caso = { notes: [], finalizedAt: null, finalizedByName: '', ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  const author = await findUserById(redis, session.userId);
  const authorName = author?.name || session.username;
  const now = new Date().toISOString();

  if (body.addNote !== undefined) {
    const text = String(body.addNote).trim();
    if (!text) {
      return new Response(JSON.stringify({ error: 'la nota no puede estar vacía' }), { status: 400 });
    }
    caso.notes.push({ text, date: now, authorName });
  }

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return new Response(JSON.stringify({ error: 'invalid status' }), { status: 400 });
    }
    caso.status = body.status;
    if (body.status === 'Finalizado') {
      caso.finalizedAt = now;
      caso.finalizedByName = authorName;
    } else {
      caso.finalizedAt = null;
      caso.finalizedByName = '';
    }
  }

  caso.updatedAt = now;

  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(caso) });
  await logAudit(redis, session, 'caso_importante_update', `${caso.plate} · ${caso.branch}`, body.status || 'nota agregada');

  return new Response(JSON.stringify({ caso }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
