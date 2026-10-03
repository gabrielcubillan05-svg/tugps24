import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, findUserById, inventoryScopeFor, verifySameOrigin, BRANCHES, type Session } from '../../lib/auth';

export const prerender = false;

// Inventario físico por sucursal, con las mismas cuatro tablas de la plantilla de Excel que
// usaban antes: equipos disponibles, equipos por reparar, SIM disponibles y equipos
// pendientes por última revisión. Lo llena el encargado de cada sucursal; el admin lo ve
// completo para cuadrarlo contra Optimus.
const REDIS_KEY = 'internal:inventory';
const META_KEY = 'internal:inventory-meta';

export const CATEGORIES = ['disponible', 'reparar', 'sim', 'ultima_revision'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  disponible: 'Equipos disponibles',
  reparar: 'Equipos por reparar',
  sim: 'SIM disponibles',
  ultima_revision: 'Equipos pendientes por última revisión',
};

export interface InventoryItem {
  id: string;
  branch: string;
  category: Category;
  // Equipos: imei, sim, modelo, observacion. SIM: serial, numeroSim.
  imei: string;
  sim: string;
  modelo: string;
  observacion: string;
  serial: string;
  numeroSim: string;
  createdAt: string;
  createdByName: string;
  updatedAt: string;
  updatedByName: string;
}

export interface CountRow {
  category: Category;
  registered: number;
  counted: number;
}

// Conteo físico diario: lo hace el encargado de la sucursal (quien tiene los equipos en la
// mano) y el sistema lo compara con lo registrado en las tablas. La auditoría es el control
// aparte del auditor nacional o el admin: dice si al revisar le cuadró o no, con nota.
export interface BranchMeta {
  lastUpdatedAt: string;
  lastUpdatedByName: string;
  lastCount?: { at: string; byName: string; ok: boolean; rows: CountRow[] };
  audit?: { at: string; byName: string; ok: boolean; note: string };
}

const ALL_BRANCHES = BRANCHES.filter((b) => b !== 'Central de Monitoreo');

// Audita quien ve el inventario de todas las sucursales (Cristian) o el admin.
function canAuditInventory(session: Session, scope: string[]): boolean {
  return session.role === 'admin' || ALL_BRANCHES.every((b) => scope.includes(b));
}

async function requireInventory(cookies: any): Promise<{ session: Session; scope: string[] } | null> {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const redis = getRedis();
  const user = redis ? await findUserById(redis, session.userId) : null;
  const scope = inventoryScopeFor(session, user);
  if (!scope.length) return null;
  return { session, scope };
}

export async function readInventory(redis: any): Promise<InventoryItem[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((i): i is InventoryItem => i !== null)
    .sort((a, b) => a.branch.localeCompare(b.branch) || b.updatedAt.localeCompare(a.updatedAt));
}

export async function readInventoryMeta(redis: any): Promise<Record<string, BranchMeta>> {
  const raw = (await redis.hgetall<Record<string, string>>(META_KEY)) || {};
  const out: Record<string, BranchMeta> = {};
  for (const [branch, v] of Object.entries(raw)) {
    try {
      out[branch] = typeof v === 'string' ? JSON.parse(v) : (v as BranchMeta);
    } catch {
      // entrada corrupta, se ignora
    }
  }
  return out;
}

async function touchBranch(redis: any, branch: string, byName: string, extra: Partial<BranchMeta> = {}): Promise<BranchMeta> {
  // Se conserva el último conteo y la auditoría: antes cada cambio reescribía la ficha entera.
  const current = (await readInventoryMeta(redis))[branch] || ({} as Partial<BranchMeta>);
  const meta: BranchMeta = { ...current, lastUpdatedAt: new Date().toISOString(), lastUpdatedByName: byName, ...extra } as BranchMeta;
  await redis.hset(META_KEY, { [branch]: JSON.stringify(meta) });
  return meta;
}

async function actorName(redis: any, session: Session): Promise<string> {
  const user = await findUserById(redis, session.userId);
  return user?.name || session.username;
}

function clean(v: unknown, max = 120): string {
  return String(v ?? '').trim().slice(0, max);
}

function describe(item: InventoryItem): string {
  return item.category === 'sim' ? `SIM ${item.serial || item.numeroSim}` : `${item.modelo || 'equipo'} IMEI ${item.imei}`;
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const access = await requireInventory(cookies);
  if (!access) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const branchParam = url.searchParams.get('branch') || '';
  const branches = branchParam ? access.scope.filter((b) => b === branchParam) : access.scope;
  const [all, meta] = await Promise.all([readInventory(redis), readInventoryMeta(redis)]);
  const items = all.filter((i) => branches.includes(i.branch));
  const metaScoped: Record<string, BranchMeta> = {};
  for (const b of access.scope) if (meta[b]) metaScoped[b] = meta[b];
  return new Response(
    JSON.stringify({ items, meta: metaScoped, scope: access.scope, categories: CATEGORIES, labels: CATEGORY_LABELS, isAdmin: access.session.role === 'admin', canAudit: canAuditInventory(access.session, access.scope) }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const access = await requireInventory(cookies);
  if (!access) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const branch = clean(body.branch);
  if (!access.scope.includes(branch)) {
    return new Response(JSON.stringify({ error: 'no eres el encargado del inventario de esa sucursal' }), { status: 403 });
  }
  const name = await actorName(redis, access.session);

  // Confirmación diaria sin cambios: deja constancia de que el inventario se revisó hoy.
  if (body.action === 'confirm') {
    const meta = await touchBranch(redis, branch, name);
    await logAudit(redis, access.session, 'inventario_confirm', branch);
    return new Response(JSON.stringify({ meta }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Conteo físico: cuántas unidades hay de verdad en cada tabla, contra lo registrado.
  if (body.action === 'count') {
    const counts = body.counts && typeof body.counts === 'object' ? body.counts : {};
    const all = await readInventory(redis);
    const rows: CountRow[] = [];
    for (const category of CATEGORIES) {
      const raw = counts[category];
      if (raw === undefined || raw === null || raw === '') {
        return new Response(JSON.stringify({ error: `falta el conteo de "${CATEGORY_LABELS[category]}"` }), { status: 400 });
      }
      const counted = Number(raw);
      if (!Number.isInteger(counted) || counted < 0 || counted > 100000) {
        return new Response(JSON.stringify({ error: `conteo inválido en "${CATEGORY_LABELS[category]}"` }), { status: 400 });
      }
      const registered = all.filter((i) => i.branch === branch && i.category === category).length;
      rows.push({ category, registered, counted });
    }
    const ok = rows.every((r) => r.registered === r.counted);
    const meta = await touchBranch(redis, branch, name, { lastCount: { at: new Date().toISOString(), byName: name, ok, rows } });
    const summary = rows.map((r) => `${CATEGORY_LABELS[r.category]}: ${r.counted}/${r.registered}`).join('; ');
    await logAudit(redis, access.session, ok ? 'inventario_conteo_ok' : 'inventario_conteo_descuadre', branch, summary);
    return new Response(JSON.stringify({ meta }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'audit') {
    if (!canAuditInventory(access.session, access.scope)) {
      return new Response(JSON.stringify({ error: 'solo el auditor de inventario o el administrador pueden auditar' }), { status: 403 });
    }
    const ok = body.ok === true;
    const note = clean(body.note, 300);
    if (!ok && !note) {
      return new Response(JSON.stringify({ error: 'si no cuadró, escribe qué encontraste' }), { status: 400 });
    }
    const current = (await readInventoryMeta(redis))[branch];
    const meta: BranchMeta = {
      lastUpdatedAt: current?.lastUpdatedAt || new Date().toISOString(),
      lastUpdatedByName: current?.lastUpdatedByName || name,
      ...current,
      audit: { at: new Date().toISOString(), byName: name, ok, note },
    };
    await redis.hset(META_KEY, { [branch]: JSON.stringify(meta) });
    await logAudit(redis, access.session, ok ? 'inventario_auditoria_ok' : 'inventario_auditoria_descuadre', branch, note);
    return new Response(JSON.stringify({ meta }), { headers: { 'Content-Type': 'application/json' } });
  }

  const category = clean(body.category) as Category;
  if (!CATEGORIES.includes(category)) {
    return new Response(JSON.stringify({ error: 'categoría inválida' }), { status: 400 });
  }
  const now = new Date().toISOString();
  const item: InventoryItem = {
    id: randomUUID(),
    branch,
    category,
    imei: clean(body.imei, 40),
    sim: clean(body.sim, 40),
    modelo: clean(body.modelo, 60),
    observacion: clean(body.observacion, 300),
    serial: clean(body.serial, 60),
    numeroSim: clean(body.numeroSim, 40),
    createdAt: now,
    createdByName: name,
    updatedAt: now,
    updatedByName: name,
  };
  if (category === 'sim' ? !item.serial && !item.numeroSim : !item.imei) {
    return new Response(JSON.stringify({ error: category === 'sim' ? 'indica el serial o el número de la SIM' : 'el IMEI es obligatorio' }), { status: 400 });
  }

  await redis.hset(REDIS_KEY, { [item.id]: JSON.stringify(item) });
  const meta = await touchBranch(redis, branch, name);
  await logAudit(redis, access.session, 'inventario_create', `${branch} · ${CATEGORY_LABELS[category]}`, describe(item));

  return new Response(JSON.stringify({ item, meta }), { headers: { 'Content-Type': 'application/json' } });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const access = await requireInventory(cookies);
  if (!access) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const raw = await redis.hget<string>(REDIS_KEY, String(body.id || ''));
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const item: InventoryItem = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!access.scope.includes(item.branch)) {
    return new Response(JSON.stringify({ error: 'no eres el encargado del inventario de esa sucursal' }), { status: 403 });
  }

  // Un ítem puede cambiar de tabla (ej. de "por reparar" a "disponible") sin reescribirlo.
  if (body.category !== undefined) {
    const category = clean(body.category) as Category;
    if (!CATEGORIES.includes(category)) {
      return new Response(JSON.stringify({ error: 'categoría inválida' }), { status: 400 });
    }
    item.category = category;
  }
  if (body.imei !== undefined) item.imei = clean(body.imei, 40);
  if (body.sim !== undefined) item.sim = clean(body.sim, 40);
  if (body.modelo !== undefined) item.modelo = clean(body.modelo, 60);
  if (body.observacion !== undefined) item.observacion = clean(body.observacion, 300);
  if (body.serial !== undefined) item.serial = clean(body.serial, 60);
  if (body.numeroSim !== undefined) item.numeroSim = clean(body.numeroSim, 40);
  if (item.category === 'sim' ? !item.serial && !item.numeroSim : !item.imei) {
    return new Response(JSON.stringify({ error: item.category === 'sim' ? 'indica el serial o el número de la SIM' : 'el IMEI es obligatorio' }), { status: 400 });
  }

  const name = await actorName(redis, access.session);
  item.updatedAt = new Date().toISOString();
  item.updatedByName = name;
  await redis.hset(REDIS_KEY, { [item.id]: JSON.stringify(item) });
  const meta = await touchBranch(redis, item.branch, name);
  await logAudit(redis, access.session, 'inventario_update', `${item.branch} · ${CATEGORY_LABELS[item.category]}`, describe(item));

  return new Response(JSON.stringify({ item, meta }), { headers: { 'Content-Type': 'application/json' } });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const access = await requireInventory(cookies);
  if (!access) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const raw = await redis.hget<string>(REDIS_KEY, String(body.id || ''));
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const item: InventoryItem = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!access.scope.includes(item.branch)) {
    return new Response(JSON.stringify({ error: 'no eres el encargado del inventario de esa sucursal' }), { status: 403 });
  }

  await redis.hdel(REDIS_KEY, item.id);
  const meta = await touchBranch(redis, item.branch, await actorName(redis, access.session));
  await logAudit(redis, access.session, 'inventario_delete', `${item.branch} · ${CATEGORY_LABELS[item.category]}`, describe(item));

  return new Response(JSON.stringify({ ok: true, meta }), { headers: { 'Content-Type': 'application/json' } });
};
