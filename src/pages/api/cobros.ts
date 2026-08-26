import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, canVerifyInstalls, findUserById, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:cobros';
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

// Reparto por defecto si no se especifica otra lista al subir el archivo.
const DEFAULT_ASSIGNEES = ['Yelitza', 'Heydrich', 'Alonso', 'Helen', 'Cristofer', 'Joenys', 'Melany', 'Pierangela', 'Ana'];

interface Cobro {
  id: string;
  nombre: string;
  numero: string;
  sucursal: string;
  facturasImpagas: number;
  fechaUltimoPago: string | null;
  deuda: number;
  telefono: string;
  assignedTo: string;
  contacted: boolean;
  contactedAt: string | null;
  contactedByName: string;
  createdAt: string;
  updatedAt: string;
}

interface AssigneeStat {
  name: string;
  total: number;
  contacted: number;
  avgContactHours: number | null;
}

function computeAssigneeStats(cobros: Cobro[]): AssigneeStat[] {
  const groups: Record<string, { total: number; contacted: number; totalHours: number; contactedWithTime: number }> = {};
  for (const c of cobros) {
    const key = c.assignedTo || 'Sin asignar';
    const g = groups[key] || (groups[key] = { total: 0, contacted: 0, totalHours: 0, contactedWithTime: 0 });
    g.total++;
    if (c.contacted) {
      g.contacted++;
      if (c.contactedAt) {
        const hours = (new Date(c.contactedAt).getTime() - new Date(c.createdAt).getTime()) / 3600000;
        if (hours >= 0) {
          g.totalHours += hours;
          g.contactedWithTime++;
        }
      }
    }
  }
  return Object.entries(groups)
    .map(([name, g]) => ({
      name,
      total: g.total,
      contacted: g.contacted,
      avgContactHours: g.contactedWithTime ? Math.round((g.totalHours / g.contactedWithTime) * 10) / 10 : null,
    }))
    .sort((a, b) => b.contacted - a.contacted || b.total - a.total);
}

async function requireCobros(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'cobros')) return null;
  return session;
}

function normalizeHeader(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function readCobros(redis: any): Promise<Cobro[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((c): c is Cobro => c !== null)
    .sort((a, b) => b.deuda - a.deuda);
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await requireCobros(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const cobros = await readCobros(redis);
  const assigneeStats = computeAssigneeStats(cobros);
  return new Response(JSON.stringify({ cobros, assigneeStats }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'cobros') || !canVerifyInstalls(session.role)) {
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
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return new Response(JSON.stringify({ error: 'falta el archivo' }), { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return new Response(JSON.stringify({ error: 'el archivo debe pesar menos de 5MB' }), { status: 400 });
  }
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
    return new Response(JSON.stringify({ error: 'el archivo debe ser .xlsx, .xls o .csv' }), { status: 400 });
  }

  let rows: unknown[][];
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('sin hojas');
    rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '' });
  } catch {
    return new Response(JSON.stringify({ error: 'no se pudo leer el archivo, verifica el formato' }), { status: 400 });
  }
  if (!rows.length) {
    return new Response(JSON.stringify({ error: 'el archivo no tiene filas de datos' }), { status: 400 });
  }

  const header = rows[0].map(normalizeHeader);
  const nombreCol = header.indexOf('nombre');
  const numeroCol = header.findIndex((h) => h === 'numero' || h === 'número');
  const sucursalCol = header.indexOf('sucursal');
  const telefonoCol = header.findIndex((h) => h === 'telefono' || h === 'teléfono');
  const deudaCol = header.findIndex((h) => h.includes('deuda'));
  const impagasCol = header.findIndex((h) => h.includes('impagas'));
  const ultPagoCol = header.findIndex((h) => h.includes('pago'));

  const assigneesRaw = String(form.get('assignees') || '').trim();
  const assignees = assigneesRaw
    ? assigneesRaw.split(/[\n,]/).map((n) => n.trim()).filter(Boolean)
    : DEFAULT_ASSIGNEES;

  if (nombreCol < 0 || telefonoCol < 0 || deudaCol < 0) {
    return new Response(
      JSON.stringify({ error: 'no se encontraron las columnas "Nombre", "Teléfono" y "Deuda" en el archivo' }),
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const newCobros: Record<string, string> = {};
  let count = 0;

  for (const row of rows.slice(1)) {
    if (!row.length || row.every((c) => c === '')) continue;
    const nombre = String(row[nombreCol] ?? '').trim();
    const telefono = String(row[telefonoCol] ?? '').trim();
    const deuda = Number(row[deudaCol]) || 0;
    if (!nombre || !telefono) continue;

    const cobro: Cobro = {
      id: randomUUID(),
      nombre,
      numero: numeroCol >= 0 ? String(row[numeroCol] ?? '') : '',
      sucursal: sucursalCol >= 0 ? String(row[sucursalCol] ?? '').trim() : '',
      facturasImpagas: impagasCol >= 0 ? Number(row[impagasCol]) || 0 : 0,
      fechaUltimoPago: ultPagoCol >= 0 ? excelSerialToISO(Number(row[ultPagoCol])) : null,
      deuda,
      telefono,
      assignedTo: assignees.length ? assignees[count % assignees.length] : '',
      contacted: false,
      contactedAt: null,
      contactedByName: '',
      createdAt: now,
      updatedAt: now,
    };
    newCobros[cobro.id] = JSON.stringify(cobro);
    count++;
  }

  if (!count) {
    return new Response(JSON.stringify({ error: 'no se encontraron filas válidas (nombre, teléfono y deuda)' }), { status: 400 });
  }

  // Cada subida reemplaza la lista completa: es una foto del estado de la deuda al
  // momento de exportar, no tiene sentido acumular listas viejas encima.
  const existingIds = Object.keys((await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {});
  if (existingIds.length) {
    await redis.hdel(REDIS_KEY, ...existingIds);
  }
  await redis.hset(REDIS_KEY, newCobros);

  await logAudit(redis, session, 'cobros_upload', file.name, `${count} cobros cargados`);

  return new Response(JSON.stringify({ count }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCobros(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string; contacted?: boolean };
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
  const cobro: Cobro = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (body.contacted !== undefined) {
    cobro.contacted = Boolean(body.contacted);
    if (cobro.contacted) {
      const user = await findUserById(redis, session.userId);
      cobro.contactedAt = new Date().toISOString();
      cobro.contactedByName = user?.name || session.username;
    } else {
      cobro.contactedAt = null;
      cobro.contactedByName = '';
    }
    cobro.updatedAt = new Date().toISOString();
  }

  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(cobro) });

  return new Response(JSON.stringify({ cobro }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
