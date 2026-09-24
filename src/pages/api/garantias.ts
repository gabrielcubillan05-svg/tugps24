import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { put } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessGarantias, canUploadGarantias, getUsers, verifySameOrigin } from '../../lib/auth';
import { normalizePhone } from './leads';
import { readProfiles } from './employees';
import { readSchedule } from './schedule';
import { colombiaDayAndMinutes } from '../../lib/shift';

export const prerender = false;

const REDIS_KEY = 'internal:garantias';
export const CATEGORIES = ['Pendiente', 'Guardado', 'Taller', 'Revision', 'Baja Señal'];
const BRANCHES = ['Riohacha', 'Valledupar', 'Santa Marta', 'Maicao', 'Atlántico', 'Bucaramanga', 'Medellín', 'Montería'];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface Garantia {
  id: string;
  cliente: string;
  telefono: string;
  placa: string;
  branch: string;
  vehicleType: string;
  modeloGps: string;
  imei: string;
  tarjetaSim: string;
  ultTransmision: string | null;
  category: string;
  note: string;
  images: string[];
  assignedToId: string;
  assignedToName: string;
  // El "titular" original (a quién le tocó por el reparto parejo) — se conserva aparte de
  // assignedToId porque en un día libre del titular esta garantía se reasigna temporalmente
  // al que cubre, y necesitamos saber a quién devolvérsela cuando el titular vuelva.
  homeAssignedToId: string;
  homeAssignedToName: string;
  batchUploadedAt: string;
  createdByName: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

async function requireAccess(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessGarantias(session)) return null;
  return session;
}

export async function readGarantias(redis: any): Promise<Garantia[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((g): g is Garantia => g !== null);
}

function sortByPriority(list: Garantia[]): Garantia[] {
  return [...list].sort((a, b) => a.batchUploadedAt.localeCompare(b.batchUploadedAt) || a.createdAt.localeCompare(b.createdAt));
}

function normalizeForMatch(str: string): string {
  return String(str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function matchBranch(raw: string): string {
  const normalized = normalizeForMatch(raw);
  const found = BRANCHES.find((b) => normalizeForMatch(b) === normalized);
  return found || String(raw || '').trim();
}

// Excel serial date (sistema 1900) -> ISO. Usa la misma cuenta que ya se usó para las fechas
// de ingreso importadas de Optimus.
function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const utcDays = Math.floor(serial - 25569);
  const ms = utcDays * 86400 * 1000 + Math.round((serial % 1) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function headerIndex(headerRow: any[], candidates: string[]): number {
  const normalizedHeaders = headerRow.map((h) => normalizeForMatch(String(h || '')));
  for (const candidate of candidates) {
    const idx = normalizedHeaders.indexOf(normalizeForMatch(candidate));
    if (idx !== -1) return idx;
  }
  return -1;
}

const DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

// Todos los días que un operador NO tiene ninguna franja cargada en Horarios (puede ser uno o
// varios) — a diferencia del cálculo de vacaciones (contracts.ts), aquí no hace falta que sea
// ambiguo con exactamente un día: un operador de garantías puede perfectamente librar 2 días.
// Si no tiene ninguna franja cargada, se asume que no libra ningún día (evita reasignar de más
// por falta de datos).
function getFreeDays(schedule: { operator: string; days: string[] }[], operatorName: string): Set<string> {
  const entries = schedule.filter((e) => e.operator === operatorName);
  if (!entries.length) return new Set();
  const covered = new Set(entries.flatMap((e) => e.days || []));
  return new Set(DAY_ORDER.filter((d) => !covered.has(d)));
}

// A quién le debería quedar asignada HOY una garantía de este titular: si hoy es uno de sus
// días libres y hay alguien marcado como "cubre garantías", al que cubre (round-robin si hay
// varios); si no, al titular. Se usa tanto al subir el Excel como en el cron diario.
function resolveTodayAssignee(
  homeOperator: { id: string; name: string },
  freeDays: Set<string>,
  todayDayName: string,
  coveringOperators: { id: string; name: string }[],
  cursor: number
): { id: string; name: string } {
  if (freeDays.has(todayDayName) && coveringOperators.length) {
    return coveringOperators[cursor % coveringOperators.length];
  }
  return homeOperator;
}

// Revisa TODAS las garantías pendientes y las mueve entre el titular y quien cubre según el día
// libre de hoy (Horarios) — llamado desde el cron diario y también se puede llamar a mano.
export async function reassignForToday(redis: any): Promise<{ moved: number }> {
  const [garantias, users, profiles, schedule] = await Promise.all([
    readGarantias(redis),
    getUsers(redis),
    readProfiles(redis),
    readSchedule(redis),
  ]);

  const coveringOperators = users
    .filter((u) => u.active && profiles[u.id]?.esCubreGarantias)
    .map((u) => ({ id: u.id, name: u.name }));

  const { day: todayDayName } = colombiaDayAndMinutes(new Date());
  const freeDaysCache = new Map<string, Set<string>>();
  function freeDaysFor(name: string): Set<string> {
    if (!freeDaysCache.has(name)) freeDaysCache.set(name, getFreeDays(schedule, name));
    return freeDaysCache.get(name)!;
  }

  let cursor = 0;
  let moved = 0;
  const toSave: Record<string, string> = {};

  for (const g of garantias) {
    if (g.category !== 'Pendiente') continue;
    if (!g.homeAssignedToId) continue; // registros de antes de este campo — no se tocan
    const freeDays = freeDaysFor(g.homeAssignedToName);
    const target = resolveTodayAssignee(
      { id: g.homeAssignedToId, name: g.homeAssignedToName },
      freeDays,
      todayDayName,
      coveringOperators,
      cursor
    );
    if (freeDays.has(todayDayName)) cursor++;
    if (target.id !== g.assignedToId) {
      g.assignedToId = target.id;
      g.assignedToName = target.name;
      g.updatedAt = new Date().toISOString();
      toSave[g.id] = JSON.stringify(g);
      moved++;
    }
  }

  if (moved) await redis.hset(REDIS_KEY, toSave);
  return { moved };
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requireAccess(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const isManager = canUploadGarantias(session);
  let garantias = await readGarantias(redis);

  if (!isManager) {
    garantias = garantias.filter((g) => g.assignedToId === session.userId);
  } else {
    const branch = url.searchParams.get('branch') || '';
    const category = url.searchParams.get('category') || '';
    const operator = url.searchParams.get('operator') || '';
    if (branch) garantias = garantias.filter((g) => g.branch === branch);
    if (category) garantias = garantias.filter((g) => g.category === category);
    if (operator) garantias = garantias.filter((g) => g.assignedToId === operator);
  }

  garantias = sortByPriority(garantias);

  let stats: Record<string, unknown> | null = null;
  if (isManager) {
    const all = sortByPriority(await readGarantias(redis));
    const byOperator = new Map<string, { name: string; total: number; byCategory: Record<string, number> }>();
    for (const g of all) {
      if (!g.assignedToId) continue;
      if (!byOperator.has(g.assignedToId)) byOperator.set(g.assignedToId, { name: g.assignedToName, total: 0, byCategory: {} });
      const entry = byOperator.get(g.assignedToId)!;
      entry.total++;
      entry.byCategory[g.category] = (entry.byCategory[g.category] || 0) + 1;
    }
    stats = { total: all.length, byOperator: Object.fromEntries(byOperator) };
  }

  return new Response(
    JSON.stringify({ garantias, categories: CATEGORIES, branches: BRANCHES, stats }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

// Sube el Excel y reparte parejo (round-robin) entre los empleados activos marcados como
// Operador de Garantías. Va separado del PATCH normal porque es multipart y solo lo puede
// hacer Wilmar/admin (canUploadGarantias).
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canUploadGarantias(session)) {
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
    return new Response(JSON.stringify({ error: 'falta el archivo Excel' }), { status: 400 });
  }

  const [allUsers, profiles, schedule] = await Promise.all([getUsers(redis), readProfiles(redis), readSchedule(redis)]);
  const activeUsers = allUsers.filter((u) => u.active);
  const garantiaOperators = activeUsers
    .filter((u) => profiles[u.id]?.esOperadorGarantias)
    .map((u) => ({ id: u.id, name: u.name }));
  if (!garantiaOperators.length) {
    return new Response(
      JSON.stringify({ error: 'no hay ningún empleado marcado como "Operador de Garantías" — márcalo en su ficha (RR.HH. → Directorio) antes de subir el Excel' }),
      { status: 400 }
    );
  }
  const coveringOperators = activeUsers
    .filter((u) => profiles[u.id]?.esCubreGarantias)
    .map((u) => ({ id: u.id, name: u.name }));
  const { day: todayDayName } = colombiaDayAndMinutes(new Date());
  const freeDaysCache = new Map<string, Set<string>>();
  function freeDaysFor(name: string): Set<string> {
    if (!freeDaysCache.has(name)) freeDaysCache.set(name, getFreeDays(schedule, name));
    return freeDaysCache.get(name)!;
  }

  let rows: any[][];
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1 });
  } catch (err) {
    console.error('garantias: fallo al leer el Excel', err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify({ error: 'no se pudo leer el archivo — confirma que es un Excel válido' }), { status: 400 });
  }
  if (rows.length < 2) {
    return new Response(JSON.stringify({ error: 'el Excel no tiene filas de datos' }), { status: 400 });
  }

  const header = rows[0];
  const idxCliente = headerIndex(header, ['Cliente', 'Nombre']);
  const idxTelefono = headerIndex(header, ['Teléfono', 'Telefono', 'Celular']);
  const idxPlaca = headerIndex(header, ['Placa']);
  const idxSucursal = headerIndex(header, ['Sucursal']);
  const idxTipoVehiculo = headerIndex(header, ['Tipo Vehículo', 'Tipo Vehiculo']);
  const idxModeloGps = headerIndex(header, ['Modelo GPS']);
  const idxImei = headerIndex(header, ['Imei']);
  const idxTarjetaSim = headerIndex(header, ['Tarjeta SIM', 'Tarjeta Sim']);
  const idxUltTransmision = headerIndex(header, ['Ult Transmisión', 'Ult Transmision', 'Última Transmisión']);

  if (idxCliente === -1 || idxTelefono === -1) {
    return new Response(
      JSON.stringify({ error: 'no encontré las columnas "Cliente" y "Teléfono" en la primera fila del Excel' }),
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const toSave: Record<string, string> = {};
  let created = 0;
  let skipped = 0;
  let operatorCursor = 0;
  const perOperator: Record<string, number> = {};

  for (const row of rows.slice(1)) {
    if (!row || !row.length) continue;
    const cliente = String(row[idxCliente] ?? '').trim();
    const rawPhone = String(row[idxTelefono] ?? '');
    const digits = rawPhone.replace(/\D/g, '');
    if (!cliente || digits.length < 7) {
      skipped++;
      continue;
    }
    // Anotaciones tipo "no llamar"/"NL" pegadas al mismo texto del teléfono no se pierden —
    // se guardan en la nota para que el operador las vea de una vez.
    const annotation = rawPhone.replace(/[\d\s]/g, '').trim();

    const homeOperator = garantiaOperators[operatorCursor % garantiaOperators.length];
    operatorCursor++;
    perOperator[homeOperator.name] = (perOperator[homeOperator.name] || 0) + 1;
    // Si justo hoy es el día libre del titular que le tocó por el reparto parejo, esta
    // garantía nace ya asignada a quien cubre, en vez de esperar al cron de mañana.
    const currentAssignee = resolveTodayAssignee(homeOperator, freeDaysFor(homeOperator.name), todayDayName, coveringOperators, 0);

    const ultTransmisionRaw = idxUltTransmision !== -1 ? row[idxUltTransmision] : null;
    const id = randomUUID();
    const garantia: Garantia = {
      id,
      cliente,
      telefono: normalizePhone(digits),
      placa: idxPlaca !== -1 ? String(row[idxPlaca] ?? '').trim().toUpperCase() : '',
      branch: idxSucursal !== -1 ? matchBranch(String(row[idxSucursal] ?? '')) : '',
      vehicleType: idxTipoVehiculo !== -1 ? String(row[idxTipoVehiculo] ?? '').trim() : '',
      modeloGps: idxModeloGps !== -1 ? String(row[idxModeloGps] ?? '').trim() : '',
      imei: idxImei !== -1 ? String(row[idxImei] ?? '').trim() : '',
      tarjetaSim: idxTarjetaSim !== -1 ? String(row[idxTarjetaSim] ?? '').trim() : '',
      ultTransmision: typeof ultTransmisionRaw === 'number' ? excelSerialToISO(ultTransmisionRaw) : null,
      category: 'Pendiente',
      note: annotation ? `⚠️ Anotación junto al teléfono en el Excel: ${annotation}` : '',
      images: [],
      assignedToId: currentAssignee.id,
      assignedToName: currentAssignee.name,
      homeAssignedToId: homeOperator.id,
      homeAssignedToName: homeOperator.name,
      batchUploadedAt: now,
      createdByName: session.name,
      createdById: session.userId,
      createdAt: now,
      updatedAt: now,
    };
    toSave[id] = JSON.stringify(garantia);
    created++;
  }

  if (!created) {
    return new Response(JSON.stringify({ error: 'ninguna fila tenía cliente y teléfono válidos' }), { status: 400 });
  }

  await redis.hset(REDIS_KEY, toSave);
  await logAudit(redis, session, 'garantias_upload', `${created} garantía(s)`, `omitidas: ${skipped}`);

  return new Response(JSON.stringify({ created, skipped, perOperator }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireAccess(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const contentType = request.headers.get('content-type') || '';
  let id = '';
  let category: string | undefined;
  let note: string | undefined;
  let imageFiles: File[] = [];

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    id = String(form.get('id') || '');
    category = form.get('category') !== null ? String(form.get('category')) : undefined;
    note = form.get('note') !== null ? String(form.get('note')) : undefined;
    imageFiles = form.getAll('images').filter((v): v is File => v instanceof File && v.size > 0);
  } else {
    const body = await request.json().catch(() => ({}));
    id = String(body?.id || '');
    category = body?.category !== undefined ? String(body.category) : undefined;
    note = body?.note !== undefined ? String(body.note) : undefined;
  }

  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const garantia: Garantia = { images: [], ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  const isManager = canUploadGarantias(session);
  if (!isManager && garantia.assignedToId !== session.userId) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) {
      return new Response(JSON.stringify({ error: 'categoría inválida' }), { status: 400 });
    }
    garantia.category = category;
  }
  if (note !== undefined) garantia.note = note.trim();

  if (imageFiles.length) {
    const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({ error: 'almacenamiento no configurado' }), { status: 503 });
    }
    for (const f of imageFiles) {
      if (!f.type.startsWith('image/')) {
        return new Response(JSON.stringify({ error: 'los adjuntos deben ser imágenes' }), { status: 400 });
      }
      if (f.size > MAX_IMAGE_BYTES) {
        return new Response(JSON.stringify({ error: 'cada imagen debe pesar menos de 8MB' }), { status: 400 });
      }
    }
    try {
      for (const f of imageFiles.slice(0, MAX_IMAGES - garantia.images.length)) {
        const blob = await put(`garantias/${id}-${randomUUID()}`, f, { access: 'private', token, addRandomSuffix: false });
        garantia.images.push(blob.pathname);
      }
    } catch (err) {
      console.error('garantias: fallo al subir imagen', err instanceof Error ? err.message : String(err));
      return new Response(JSON.stringify({ error: 'fallo al subir imagen' }), { status: 500 });
    }
  }

  garantia.updatedAt = new Date().toISOString();
  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(garantia) });
  await logAudit(redis, session, 'garantia_update', garantia.cliente, garantia.category);

  return new Response(JSON.stringify({ garantia }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
