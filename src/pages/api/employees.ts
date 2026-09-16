import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import {
  SESSION_COOKIE,
  getSession,
  canAccessRRHH,
  verifySameOrigin,
  getUsers,
  findUserById,
  branchesOf,
} from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:employee-profiles';

export interface EmployeeProfile {
  cedula: string;
  fechaNacimiento: string;
  hijos: number;
  hijosEdades: string;
  telefono: string;
  direccion: string;
  correo: string;
  area: string;
  cargo: string;
  jefeDirecto: string;
  hireDate: string | null;
  eps: string;
  cajaCompensacion: boolean;
  cuentaNomina: boolean;
  nesagaviria: boolean;
}

export const EMPTY_PROFILE: EmployeeProfile = {
  cedula: '',
  fechaNacimiento: '',
  hijos: 0,
  hijosEdades: '',
  telefono: '',
  direccion: '',
  correo: '',
  area: '',
  cargo: '',
  jefeDirecto: '',
  hireDate: null,
  eps: '',
  cajaCompensacion: false,
  cuentaNomina: false,
  nesagaviria: false,
};

async function requireRRHH(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessRRHH(session)) return null;
  return session;
}

export async function readProfiles(redis: any): Promise<Record<string, EmployeeProfile>> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  const out: Record<string, EmployeeProfile> = {};
  for (const [id, v] of Object.entries(raw)) {
    try {
      out[id] = { ...EMPTY_PROFILE, ...(typeof v === 'string' ? JSON.parse(v) : v) };
    } catch {
      // ignora perfiles corruptos
    }
  }
  return out;
}

export async function getHireDate(redis: any, userId: string): Promise<string | null> {
  const raw = await redis.hget<string>(REDIS_KEY, userId);
  if (!raw) return null;
  try {
    const profile = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return profile.hireDate || null;
  } catch {
    return null;
  }
}

export async function getProfile(redis: any, userId: string): Promise<EmployeeProfile> {
  const raw = await redis.hget<string>(REDIS_KEY, userId);
  if (!raw) return { ...EMPTY_PROFILE };
  try {
    return { ...EMPTY_PROFILE, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export async function saveProfile(redis: any, userId: string, profile: EmployeeProfile): Promise<void> {
  await redis.hset(REDIS_KEY, { [userId]: JSON.stringify(profile) });
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await requireRRHH(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const [users, profiles] = await Promise.all([getUsers(redis), readProfiles(redis)]);

  // Solo admin, Wilmar y Josué llegan hasta aquí (canAccessRRHH) — igual que Pagos internos,
  // ven todas las sucursales, sin filtrar por la propia.
  const employees = users.map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    active: u.active,
    branches: branchesOf(u),
    profile: profiles[u.id] || EMPTY_PROFILE,
  }));

  return new Response(JSON.stringify({ employees }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireRRHH(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const id = String(body?.id || '');
  if (!id) {
    return new Response(JSON.stringify({ error: 'falta el empleado' }), { status: 400 });
  }

  const target = await findUserById(redis, id);
  if (!target) {
    return new Response(JSON.stringify({ error: 'empleado no encontrado' }), { status: 404 });
  }

  const raw = await redis.hget<string>(REDIS_KEY, id);
  let existing: EmployeeProfile = { ...EMPTY_PROFILE };
  if (raw) {
    try {
      existing = { ...EMPTY_PROFILE, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
    } catch {
      // usa el perfil vacío si el registro guardado está corrupto
    }
  }

  const fields = body?.fields && typeof body.fields === 'object' ? body.fields : {};
  const updated: EmployeeProfile = { ...existing };
  for (const key of Object.keys(EMPTY_PROFILE) as (keyof EmployeeProfile)[]) {
    if (fields[key] === undefined) continue;
    if (key === 'hijos') updated.hijos = Number(fields.hijos) || 0;
    else if (key === 'cajaCompensacion' || key === 'cuentaNomina' || key === 'nesagaviria') {
      (updated as any)[key] = Boolean(fields[key]);
    } else if (key === 'hireDate') {
      updated.hireDate = fields.hireDate ? String(fields.hireDate) : null;
    } else {
      (updated as any)[key] = String(fields[key]);
    }
  }

  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(updated) });
  await logAudit(redis, session, 'employee_profile_update', target.name, '');

  return new Response(JSON.stringify({ ok: true, profile: updated }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
