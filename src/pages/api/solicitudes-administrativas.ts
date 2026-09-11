import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import {
  SESSION_COOKIE,
  getSession,
  canAccessSolicitudesAdministrativas,
  findUserById,
  findUserByUsername,
  KELLY_USERNAME,
  WILMAR_USERNAME,
  verifySameOrigin,
} from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:solicitudes-administrativas';

export const REQUEST_TYPES = [
  'Reactivación manual sin reconexión',
  'Reactivación manual por descuento',
  'Arreglo de factura por descuento',
  'Arreglo de factura por suspensión o desinstalación',
  'Arreglo de factura por error de Óptimus',
  'Agregar marca o color nuevo',
  'Arreglo de factura por cambio en el ciclo de pago',
  'Agregar factura adicional, reinstalación, viáticos, platina, reposición o cambio 4G',
  'Cliente cambio de sucursal',
  'Anulación de pago errado',
];

export const STATUSES = ['Pendiente', 'Completada', 'No completada'];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface TimelineEvent {
  id: string;
  type: string;
  message: string;
  authorName: string;
  date: string;
}

export interface Solicitud {
  id: string;
  clientName: string;
  requestType: string;
  description: string;
  dueDate: string | null;
  imagePath: string | null;
  // Fotos adjuntas en cualquier momento del proceso (creación o notas de seguimiento
  // posteriores) — imagePath se conserva solo por compatibilidad con registros viejos.
  photoPaths: string[];
  status: string;
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
  createdById: string;
  createdByName: string;
  resolvedAt: string | null;
  resolvedByName: string;
}

async function requireSolicitudes(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSolicitudesAdministrativas(session)) return null;
  return session;
}

export async function readSolicitudes(redis: any): Promise<Solicitud[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((s): s is Solicitud => s !== null)
    .map((s) => ({ timeline: [], dueDate: null, imagePath: null, photoPaths: [], resolvedAt: null, resolvedByName: '', ...s }))
    .map((s) => ({ ...s, photoPaths: s.photoPaths.length ? s.photoPaths : s.imagePath ? [s.imagePath] : [] }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function uploadSolicitudPhoto(photoFile: File): Promise<{ path?: string; error?: string; status?: number }> {
  if (!photoFile.type.startsWith('image/')) {
    return { error: 'la foto debe ser una imagen', status: 400 };
  }
  if (photoFile.size > MAX_IMAGE_BYTES) {
    return { error: 'la foto debe pesar menos de 8MB', status: 400 };
  }
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return { error: 'almacenamiento de imágenes no configurado', status: 503 };
  }
  try {
    const blobId = randomUUID();
    const blob = await put(`solicitudes-admin/${blobId}`, photoFile, { access: 'private', token, addRandomSuffix: false });
    return { path: blob.pathname };
  } catch (err) {
    return { error: 'fallo al subir la foto', status: 500 };
  }
}

function addEvent(sol: Solicitud, type: string, message: string, authorName: string, now: string) {
  sol.timeline.push({ id: randomUUID(), type, message, authorName, date: now });
}

const REACTIVACION_TYPES = ['Reactivación manual sin reconexión', 'Reactivación manual por descuento'];

function computeStats(items: Solicitud[]) {
  const byStatus: Record<string, number> = {};
  for (const s of STATUSES) byStatus[s] = 0;
  for (const s of items) byStatus[s.status] = (byStatus[s.status] || 0) + 1;

  const byType: Record<string, number> = {};
  for (const t of REQUEST_TYPES) byType[t] = 0;
  for (const s of items) byType[s.requestType] = (byType[s.requestType] || 0) + 1;

  const reactivacionesTotal = items.filter((s) => REACTIVACION_TYPES.includes(s.requestType)).length;

  return {
    total: items.length,
    byStatus,
    byType,
    reactivacionesTotal,
  };
}

async function notifyBoth(redis: any, message: string) {
  for (const username of [KELLY_USERNAME, WILMAR_USERNAME]) {
    try {
      const user = await findUserByUsername(redis, username);
      if (user) await pushNotification(redis, user.id, { type: 'solicitud-administrativa', message, link: '/interno/solicitudes-administrativas' });
    } catch {
      // no debe tumbar la operación si no se encuentra a alguno de los dos
    }
  }
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireSolicitudes(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const requestType = url.searchParams.get('requestType') || '';
  const status = url.searchParams.get('status') || '';
  const month = url.searchParams.get('month') || '';

  const all = await readSolicitudes(redis);

  let items = all;
  if (q) {
    items = items.filter((s) => s.clientName.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }
  if (requestType) items = items.filter((s) => s.requestType === requestType);
  if (status) items = items.filter((s) => s.status === status);
  if (month) items = items.filter((s) => s.createdAt.slice(0, 7) === month);

  const stats = computeStats(items);

  const itemsWithUrl = items.map((s) => ({
    ...s,
    photoUrls: s.photoPaths.map((p) => '/api/blob-file?path=' + encodeURIComponent(p)),
  }));

  return new Response(
    JSON.stringify({
      solicitudes: itemsWithUrl,
      requestTypes: REQUEST_TYPES,
      statuses: STATUSES,
      stats,
      currentUserId: session.userId,
      isKellyOrWilmar: [KELLY_USERNAME, WILMAR_USERNAME].includes(session.username.toLowerCase()),
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireSolicitudes(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const form = await request.formData();
  const clientName = String(form.get('clientName') || '').trim();
  const requestType = String(form.get('requestType') || '').trim();
  const description = String(form.get('description') || '').trim();
  const dueDate = form.get('dueDate') ? String(form.get('dueDate')).trim() : null;
  const photoFile = form.get('photo');

  if (!clientName || !requestType) {
    return new Response(JSON.stringify({ error: 'faltan campos obligatorios' }), { status: 400 });
  }
  if (!REQUEST_TYPES.includes(requestType)) {
    return new Response(JSON.stringify({ error: 'tipo de solicitud inválido' }), { status: 400 });
  }

  let imagePath: string | null = null;
  if (photoFile instanceof File && photoFile.size > 0) {
    const uploaded = await uploadSolicitudPhoto(photoFile);
    if (uploaded.error) {
      return new Response(JSON.stringify({ error: uploaded.error }), { status: uploaded.status || 500 });
    }
    imagePath = uploaded.path || null;
  }

  const creator = await findUserById(redis, session.userId);
  const now = new Date().toISOString();

  const sol: Solicitud = {
    id: randomUUID(),
    clientName,
    requestType,
    description,
    dueDate,
    imagePath,
    photoPaths: imagePath ? [imagePath] : [],
    status: 'Pendiente',
    timeline: [],
    createdAt: now,
    updatedAt: now,
    createdById: session.userId,
    createdByName: creator?.name || session.username,
    resolvedAt: null,
    resolvedByName: '',
  };
  addEvent(sol, 'created', `Solicitud creada por ${sol.createdByName}`, sol.createdByName, now);

  await redis.hset(REDIS_KEY, { [sol.id]: JSON.stringify(sol) });
  await logAudit(redis, session, 'solicitud_administrativa_create', sol.clientName, sol.requestType);

  await notifyBoth(redis, `Nueva solicitud administrativa: ${sol.clientName} · ${sol.requestType}`);

  return new Response(JSON.stringify({ solicitud: sol }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireSolicitudes(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string; action?: string; note?: string };
  let photoFile: File | null = null;
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    body = {
      id: String(form.get('id') || ''),
      action: String(form.get('action') || ''),
      note: String(form.get('note') || ''),
    };
    const maybePhoto = form.get('photo');
    if (maybePhoto instanceof File && maybePhoto.size > 0) photoFile = maybePhoto;
  } else {
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
    }
  }

  const id = String(body.id || '');
  const action = String(body.action || '');
  const note = String(body.note || '').trim();
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const sol: Solicitud = { timeline: [], dueDate: null, imagePath: null, photoPaths: [], resolvedAt: null, resolvedByName: '', ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
  if (!sol.photoPaths.length && sol.imagePath) sol.photoPaths = [sol.imagePath];

  const actor = await findUserById(redis, session.userId);
  const actorName = actor?.name || session.username;
  const now = new Date().toISOString();
  const isOverride = session.role === 'admin' || session.role === 'supervisor';
  const isCreator = session.userId === sol.createdById;
  const isKellyOrWilmar = [KELLY_USERNAME, WILMAR_USERNAME].includes(session.username.toLowerCase());

  async function notifyCreator(message: string) {
    if (sol.createdById === session.userId) return;
    try {
      await pushNotification(redis, sol.createdById, { type: 'solicitud-administrativa', message, link: '/interno/solicitudes-administrativas' });
    } catch {
      // no debe tumbar la actualización
    }
  }

  if (action === 'addNote') {
    if (!isCreator && !isKellyOrWilmar && !isOverride) {
      return new Response(JSON.stringify({ error: 'no tienes permiso sobre esta solicitud' }), { status: 403 });
    }
    if (!note && !photoFile) {
      return new Response(JSON.stringify({ error: 'la nota no puede estar vacía' }), { status: 400 });
    }
    if (photoFile) {
      const uploaded = await uploadSolicitudPhoto(photoFile);
      if (uploaded.error) {
        return new Response(JSON.stringify({ error: uploaded.error }), { status: uploaded.status || 500 });
      }
      if (uploaded.path) sol.photoPaths.push(uploaded.path);
    }
    addEvent(sol, 'note', note ? (photoFile ? `${note} (foto adjunta)` : note) : 'Adjuntó una foto', actorName, now);
  } else if (action === 'complete' || action === 'notCompleted') {
    if (!isKellyOrWilmar && !isOverride) {
      return new Response(JSON.stringify({ error: 'solo Kelly o Wilmar pueden cerrar esta solicitud' }), { status: 403 });
    }
    if (sol.status !== 'Pendiente') {
      return new Response(JSON.stringify({ error: 'esta solicitud ya está cerrada' }), { status: 400 });
    }
    sol.status = action === 'complete' ? 'Completada' : 'No completada';
    sol.resolvedAt = now;
    sol.resolvedByName = actorName;
    const label = action === 'complete' ? 'Completada' : 'No completada';
    addEvent(sol, action, `${actorName} marcó la solicitud: ${label}${note ? '. ' + note : ''}`, actorName, now);
    await notifyCreator(`Tu solicitud de ${sol.clientName} quedó: ${label}`);
  } else if (action === 'reopen') {
    if (!isKellyOrWilmar && !isOverride) {
      return new Response(JSON.stringify({ error: 'solo Kelly o Wilmar pueden reabrir esta solicitud' }), { status: 403 });
    }
    if (sol.status === 'Pendiente') {
      return new Response(JSON.stringify({ error: 'esta solicitud ya está pendiente' }), { status: 400 });
    }
    sol.status = 'Pendiente';
    sol.resolvedAt = null;
    sol.resolvedByName = '';
    addEvent(sol, 'reopen', `${actorName} reabrió la solicitud${note ? ': ' + note : ''}`, actorName, now);
  } else {
    return new Response(JSON.stringify({ error: 'acción inválida' }), { status: 400 });
  }

  sol.updatedAt = now;
  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(sol) });
  await logAudit(redis, session, 'solicitud_administrativa_update', sol.clientName, action);

  return new Response(JSON.stringify({ solicitud: sol }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
