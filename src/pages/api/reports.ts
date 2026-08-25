import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import { SESSION_COOKIE, getSession, canAccessSection, getUsers, findUserById, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

async function requireNovedades(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'novedades')) return null;
  return session;
}

const REDIS_KEY = 'internal:reports';
const CATEGORIES = ['Notificación', 'Salida de geocerca', 'Finalizado', 'Alarma', 'Novedad', 'Monitoreo a', 'Monitoreo en', 'Monitoreo vía', 'Monitoreo retornando', 'Otro'];
const BRANCHES = ['Riohacha', 'Valledupar', 'Santa Marta', 'Maicao', 'Atlántico', 'Bucaramanga', 'Medellín', 'Montería'];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB por foto

interface Report {
  id: string;
  plate: string;
  branch: string;
  category: string;
  note: string;
  images: string[];
  createdAt: string;
  createdByName: string;
  createdById: string;
}

const DEFAULT_LIMIT = 200;

export const GET: APIRoute = async ({ cookies, url }) => {
  if (!(await requireNovedades(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const branch = url.searchParams.get('branch') || '';
  const category = url.searchParams.get('category') || '';
  const employee = url.searchParams.get('employee') || '';
  const all = url.searchParams.get('all') === '1';

  // Este registro crece todos los días desde hace meses — traer todo en cada carga
  // (y cada 2 minutos por el auto-refresco) es lo que lo hacía lento. Sin filtros
  // activos solo se traen las más recientes; buscar/filtrar sí revisa todo el historial.
  const needsFullScan = Boolean(q || branch || category || employee || all);
  const total = await redis.llen(REDIS_KEY);
  const raw = needsFullScan
    ? (await redis.lrange<string>(REDIS_KEY, 0, -1)) || []
    : (await redis.lrange<string>(REDIS_KEY, 0, DEFAULT_LIMIT - 1)) || [];

  let reports: Report[] = raw
    .map((r) => {
      try {
        return typeof r === 'string' ? JSON.parse(r) : r;
      } catch {
        return null;
      }
    })
    .filter((r): r is Report => r !== null)
    .map((r) => ({ images: [], createdByName: '', createdById: '', ...r }));

  if (q) {
    reports = reports.filter((r) =>
      r.plate.toLowerCase().includes(q) ||
      r.note.toLowerCase().includes(q) ||
      r.branch.toLowerCase().includes(q)
    );
  }
  if (branch) reports = reports.filter((r) => r.branch === branch);
  if (category) reports = reports.filter((r) => r.category === category);
  if (employee) reports = reports.filter((r) => r.createdById === employee);

  return new Response(
    JSON.stringify({
      reports,
      categories: CATEGORIES,
      branches: BRANCHES,
      total,
      truncated: !needsFullScan && total > DEFAULT_LIMIT,
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireNovedades(cookies);
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
  let note = '';
  let imageFiles: File[] = [];

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    plate = String(form.get('plate') || '').trim();
    branch = String(form.get('branch') || '').trim();
    category = String(form.get('category') || '').trim();
    note = String(form.get('note') || '').trim();
    imageFiles = form.getAll('images').filter((v): v is File => v instanceof File && v.size > 0);
  } else {
    let body: Partial<Report>;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
    }
    plate = String(body.plate || '').trim();
    branch = String(body.branch || '').trim();
    category = String(body.category || '').trim();
    note = String(body.note || '').trim();
  }

  if (!plate || !branch || !category || !note) {
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
        const blob = await put(`reports/${id}-${randomUUID()}`, file, {
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

  const report: Report = {
    id,
    plate: plate.toUpperCase(),
    branch,
    category,
    note,
    images,
    createdAt: new Date().toISOString(),
    createdByName: creator?.name || session.username,
    createdById: session.userId,
  };

  await redis.lpush(REDIS_KEY, JSON.stringify(report));
  await logAudit(redis, session, 'report_create', `${report.plate} · ${report.branch}`, report.category);

  const managers = (await getUsers(redis)).filter(
    (u) => u.active && u.id !== session.userId && (u.role === 'supervisor' || u.role === 'gerente')
  );
  for (const manager of managers) {
    try {
      await pushNotification(redis, manager.id, {
        type: 'novedad',
        message: `Nueva novedad: ${report.plate} · ${report.branch} (${report.category})`,
        link: '/interno/novedades',
      });
    } catch {
      // no debe tumbar el guardado del reporte si falla notificar a un gerente puntual
    }
  }

  return new Response(JSON.stringify({ report }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
