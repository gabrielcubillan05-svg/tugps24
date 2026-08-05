import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { isAuthorized, AUTH_COOKIE } from '../../lib/internalAuth';

export const prerender = false;

const REDIS_KEY = 'internal:reports';
const CATEGORIES = ['Notificación', 'Salida de geocerca', 'Finalizado', 'Alarma', 'Novedad', 'Otro'];
const BRANCHES = ['Riohacha', 'Valledupar', 'Santa Marta', 'Maicao', 'Soledad', 'Barranquilla', 'Bucaramanga', 'Medellín', 'Montería'];

interface Report {
  id: string;
  plate: string;
  branch: string;
  category: string;
  note: string;
  createdAt: string;
}

export const GET: APIRoute = async ({ cookies, url }) => {
  if (!isAuthorized(cookies.get(AUTH_COOKIE)?.value)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const raw = (await redis.lrange<string>(REDIS_KEY, 0, -1)) || [];
  let reports: Report[] = raw
    .map((r) => {
      try {
        return typeof r === 'string' ? JSON.parse(r) : r;
      } catch {
        return null;
      }
    })
    .filter((r): r is Report => r !== null);

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const branch = url.searchParams.get('branch') || '';
  const category = url.searchParams.get('category') || '';

  if (q) {
    reports = reports.filter((r) =>
      r.plate.toLowerCase().includes(q) ||
      r.note.toLowerCase().includes(q) ||
      r.branch.toLowerCase().includes(q)
    );
  }
  if (branch) reports = reports.filter((r) => r.branch === branch);
  if (category) reports = reports.filter((r) => r.category === category);

  return new Response(JSON.stringify({ reports, categories: CATEGORIES, branches: BRANCHES }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAuthorized(cookies.get(AUTH_COOKIE)?.value)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: Partial<Report>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const plate = String(body.plate || '').trim();
  const branch = String(body.branch || '').trim();
  const category = String(body.category || '').trim();
  const note = String(body.note || '').trim();

  if (!plate || !branch || !category || !note) {
    return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400 });
  }
  if (!BRANCHES.includes(branch) || !CATEGORIES.includes(category)) {
    return new Response(JSON.stringify({ error: 'invalid branch or category' }), { status: 400 });
  }

  const report: Report = {
    id: randomUUID(),
    plate: plate.toUpperCase(),
    branch,
    category,
    note,
    createdAt: new Date().toISOString(),
  };

  await redis.lpush(REDIS_KEY, JSON.stringify(report));

  return new Response(JSON.stringify({ report }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
