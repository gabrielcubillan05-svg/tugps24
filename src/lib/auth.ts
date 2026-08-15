import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { getRedis } from './redis';

export const SESSION_COOKIE = 'interno_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 días
export const LOGIN_PATH = '/interno/login';
export const CHANGE_PASSWORD_PATH = '/interno/cambiar-clave';

const USERS_KEY = 'internal:users';
const SESSIONS_KEY = 'internal:sessions';

type Redis = NonNullable<ReturnType<typeof getRedis>>;

export type Role = 'tecnico' | 'operador' | 'secretaria' | 'supervisor' | 'gerente' | 'admin';
export const ROLES: Role[] = ['tecnico', 'operador', 'secretaria', 'supervisor', 'gerente', 'admin'];

export const ROLE_LABELS: Record<Role, string> = {
  tecnico: 'Técnico',
  operador: 'Operador',
  secretaria: 'Secretaria',
  supervisor: 'Supervisor',
  gerente: 'Gerente',
  admin: 'Administrador',
};

export type Section =
  | 'novedades'
  | 'reportes'
  | 'horario'
  | 'crm'
  | 'cotizaciones'
  | 'tareas'
  | 'auditoria'
  | 'usuarios'
  | 'chat'
  | 'pagos';

export const SECTION_LABELS: Record<Section, string> = {
  novedades: 'Novedades',
  reportes: 'Reportes programados',
  horario: 'Horario',
  crm: 'CRM',
  cotizaciones: 'Cotizaciones',
  tareas: 'Tareas',
  auditoria: 'Auditoría',
  usuarios: 'Usuarios',
  chat: 'Chat',
  pagos: 'Verificación de pagos',
};

export const SECTION_PATHS: Record<Section, string> = {
  novedades: '/interno/novedades',
  reportes: '/interno/reportes',
  horario: '/interno/horario',
  crm: '/interno/crm',
  cotizaciones: '/interno/cotizaciones',
  tareas: '/interno/tareas',
  auditoria: '/interno/auditoria',
  usuarios: '/interno/usuarios',
  chat: '/interno/chat',
  pagos: '/interno/pagos',
};

export const ROLE_SECTIONS: Record<Role, Section[]> = {
  tecnico: ['tareas', 'chat'],
  operador: ['novedades', 'reportes', 'tareas', 'chat'],
  secretaria: ['crm', 'cotizaciones', 'tareas', 'chat'],
  supervisor: ['novedades', 'reportes', 'horario', 'crm', 'cotizaciones', 'tareas', 'chat'],
  gerente: ['novedades', 'reportes', 'horario', 'crm', 'cotizaciones', 'tareas', 'auditoria', 'chat'],
  admin: ['novedades', 'reportes', 'horario', 'crm', 'cotizaciones', 'tareas', 'auditoria', 'usuarios', 'chat', 'pagos'],
};

export function canAccessSection(role: Role, section: Section): boolean {
  return ROLE_SECTIONS[role]?.includes(section) ?? false;
}

export function firstSectionFor(role: Role): Section | null {
  return ROLE_SECTIONS[role]?.[0] ?? null;
}

// Usuarios puntuales con acceso a Verificación de pagos aunque su rol no lo incluya,
// además de admin (que ya lo tiene por ROLE_SECTIONS).
const PAGOS_EXTRA_USERNAMES = ['kellylara', 'wilmararchila'];

export function canAccessPagos(session: Pick<Session, 'role' | 'username'>): boolean {
  return canAccessSection(session.role, 'pagos') || PAGOS_EXTRA_USERNAMES.includes(session.username);
}

export function sectionsFor(session: Pick<Session, 'role' | 'username'>): Section[] {
  const base = ROLE_SECTIONS[session.role] || [];
  if (!base.includes('pagos') && canAccessPagos(session)) {
    return [...base, 'pagos'];
  }
  return base;
}

export function canManageCompDays(role: Role): boolean {
  return role === 'supervisor' || role === 'gerente' || role === 'admin';
}

export function canAssignTasks(role: Role): boolean {
  return role === 'supervisor' || role === 'gerente' || role === 'admin';
}

export function canVerifyInstalls(role: Role): boolean {
  return role === 'supervisor' || role === 'gerente' || role === 'admin';
}

export function canManageMediaAssets(role: Role): boolean {
  return role === 'supervisor' || role === 'gerente' || role === 'admin';
}

export function canManageUsers(role: Role): boolean {
  return role === 'admin';
}

export interface User {
  id: string;
  username: string;
  name: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  mustChangePassword?: boolean;
}

export interface Session {
  userId: string;
  username: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  mustChangePassword?: boolean;
}

// --- Contraseñas ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, derivedHex] = stored.split(':');
  if (!salt || !derivedHex) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(derivedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// --- Sesiones ---

function sessionSecret(): string {
  const secret = import.meta.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET no configurado');
  return secret;
}

function signSessionId(sessionId: string): string {
  return createHmac('sha256', sessionSecret()).update(sessionId).digest('hex');
}

function cookieValueForSession(sessionId: string): string {
  return `${sessionId}.${signSessionId(sessionId)}`;
}

function parseCookieValue(cookieValue: string): string | null {
  const idx = cookieValue.lastIndexOf('.');
  if (idx < 0) return null;
  const sessionId = cookieValue.slice(0, idx);
  const signature = cookieValue.slice(idx + 1);
  let expected: string;
  try {
    expected = signSessionId(sessionId);
  } catch {
    return null;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sessionId;
}

export async function createSession(user: User): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  const sessionId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE * 1000);
  const session: Session = {
    userId: user.id,
    username: user.username,
    role: user.role,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    mustChangePassword: user.mustChangePassword ?? false,
  };
  await redis.hset(SESSIONS_KEY, { [sessionId]: JSON.stringify(session) });
  return cookieValueForSession(sessionId);
}

export async function getSession(cookieValue: string | undefined): Promise<Session | null> {
  if (!cookieValue) return null;
  const sessionId = parseCookieValue(cookieValue);
  if (!sessionId) return null;
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.hget<string>(SESSIONS_KEY, sessionId);
  if (!raw) return null;
  let session: Session;
  try {
    session = typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
  } catch {
    return null;
  }
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await redis.hdel(SESSIONS_KEY, sessionId);
    return null;
  }
  return session;
}

export async function destroySession(cookieValue: string | undefined): Promise<void> {
  if (!cookieValue) return;
  const sessionId = parseCookieValue(cookieValue);
  if (!sessionId) return;
  const redis = getRedis();
  if (!redis) return;
  await redis.hdel(SESSIONS_KEY, sessionId);
}

export async function destroyAllSessionsForUser(redis: Redis, userId: string): Promise<void> {
  const raw = (await redis.hgetall<Record<string, string>>(SESSIONS_KEY)) || {};
  const toDelete: string[] = [];
  for (const [sessionId, v] of Object.entries(raw)) {
    try {
      const session: Session = typeof v === 'string' ? JSON.parse(v) : (v as any);
      if (session.userId === userId) toDelete.push(sessionId);
    } catch {
      // entrada corrupta, se ignora
    }
  }
  if (toDelete.length) await redis.hdel(SESSIONS_KEY, ...toDelete);
}

// --- Usuarios ---

export async function getUsers(redis: Redis): Promise<User[]> {
  const raw = (await redis.hgetall<Record<string, string>>(USERS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((u): u is User => u !== null)
    .sort((a, b) => a.username.localeCompare(b.username));
}

export async function findUserByUsername(redis: Redis, username: string): Promise<User | null> {
  const users = await getUsers(redis);
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

export async function findUserById(redis: Redis, id: string): Promise<User | null> {
  const raw = await redis.hget<string>(USERS_KEY, id);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
  } catch {
    return null;
  }
}

export async function saveUser(redis: Redis, user: User): Promise<void> {
  await redis.hset(USERS_KEY, { [user.id]: JSON.stringify(user) });
}

export async function createBootstrapAdminIfMatches(
  redis: Redis,
  username: string,
  password: string
): Promise<User | null> {
  const bootstrapUsername = import.meta.env.BOOTSTRAP_ADMIN_USERNAME;
  const bootstrapPassword = import.meta.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!bootstrapUsername || !bootstrapPassword) return null;
  if (username !== bootstrapUsername || password !== bootstrapPassword) return null;

  const users = await getUsers(redis);
  if (users.length > 0) return null;

  const now = new Date().toISOString();
  const admin: User = {
    id: randomUUID(),
    username: bootstrapUsername,
    name: 'Administrador',
    passwordHash: hashPassword(bootstrapPassword),
    role: 'admin',
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await saveUser(redis, admin);
  return admin;
}

// --- CSRF ---

export function verifySameOrigin(request: Request): boolean {
  const host = request.headers.get('host');
  if (!host) return false;
  const value = request.headers.get('origin') || request.headers.get('referer');
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.host === host;
  } catch {
    return false;
  }
}
