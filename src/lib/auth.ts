import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { getRedis } from './redis';

export const SESSION_COOKIE = 'interno_session';
export const SESSION_MAX_AGE = 60 * 60 * 24; // 24 horas — cierre forzado diario, sin importar la actividad
const INACTIVITY_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 horas sin usar el panel cierra la sesión antes
export const LOGIN_PATH = '/interno/login';
export const CHANGE_PASSWORD_PATH = '/interno/cambiar-clave';

const USERS_KEY = 'internal:users';
const SESSIONS_KEY = 'internal:sessions';

// La sesión es la lectura más repetida de todo el sistema: el middleware la lee para exigir el
// cambio de clave inicial y acto seguido el endpoint la vuelve a leer, en cada petición de la
// API y en cada sondeo de cada pestaña. Se guarda unos segundos en memoria de la instancia:
// una petición típica pasa de dos idas a Redis a una o ninguna. Cerrar sesión o cambiar de rol
// la saca de la caché en esta instancia; en otra instancia caduca sola en segundos.
const SESSION_CACHE_MS = 5_000;
const sessionCache = new Map<string, { at: number; raw: string | null }>();

async function readSessionRaw(redis: Redis, sessionId: string): Promise<{ raw: string | null; fromCache: boolean }> {
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return { raw: cached.raw, fromCache: true };
  const raw = await redis.hget<string>(SESSIONS_KEY, sessionId);
  const text = raw == null ? null : typeof raw === 'string' ? raw : JSON.stringify(raw);
  sessionCache.set(sessionId, { at: Date.now(), raw: text });
  if (sessionCache.size > 2000) sessionCache.clear();
  return { raw: text, fromCache: false };
}

function forgetSessionCache(sessionId?: string): void {
  if (sessionId) sessionCache.delete(sessionId);
  else sessionCache.clear();
}

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
  | 'novedades-archivadas'
  | 'reportes'
  | 'crm'
  | 'cotizaciones'
  | 'tareas'
  | 'auditoria'
  | 'usuarios'
  | 'chat'
  | 'estadisticas'
  | 'cobros'
  | 'cuadrantes'
  | 'casos-importantes'
  | 'suspensiones'
  | 'solicitudes-administrativas'
  | 'seguimiento-masivos'
  | 'conversaciones-whatsapp'
  | 'agentes-ia'
  | 'pagos-internos'
  | 'planillas-vehiculo'
  | 'esquemas-apagado'
  | 'garantias'
  | 'rrhh'
  | 'almacenamiento'
  | 'sim-consumos'
  | 'inventario'
  | 'verificacion-pagos'
  | 'apagados-programados';

export const SECTION_LABELS: Record<Section, string> = {
  novedades: 'Novedades',
  'novedades-archivadas': 'Novedades archivadas',
  reportes: 'Reportes programados',
  crm: 'CRM',
  cotizaciones: 'Cotizaciones',
  tareas: 'Tareas',
  auditoria: 'Auditoría',
  usuarios: 'Usuarios',
  chat: 'Chat',
  estadisticas: 'Estadísticas',
  cobros: 'Cobranza especial WP',
  cuadrantes: 'Cuadrantes de policía',
  'casos-importantes': 'Casos importantes',
  suspensiones: 'Suspensiones',
  'solicitudes-administrativas': 'Solicitudes Administrativas',
  'seguimiento-masivos': 'Seguimiento a clientes masivos',
  'conversaciones-whatsapp': 'Conversaciones WhatsApp',
  'agentes-ia': 'Agentes IA',
  'pagos-internos': 'Pagos programados',
  'planillas-vehiculo': 'Planilla de vehículo',
  'esquemas-apagado': 'Esquemas de apagado',
  garantias: 'Garantías',
  rrhh: 'Recursos Humanos',
  almacenamiento: 'Almacenamiento',
  'sim-consumos': 'Consumo de SIM',
  inventario: 'Inventario de sucursal',
  'verificacion-pagos': 'Verificación de pagos',
  'apagados-programados': 'Apagados programados',
};

export const SECTION_PATHS: Record<Section, string> = {
  novedades: '/interno/novedades',
  'novedades-archivadas': '/interno/novedades-archivadas',
  reportes: '/interno/reportes',
  crm: '/interno/crm',
  cotizaciones: '/interno/cotizaciones',
  tareas: '/interno/tareas',
  auditoria: '/interno/auditoria',
  usuarios: '/interno/usuarios',
  chat: '/interno/chat',
  estadisticas: '/interno/estadisticas',
  cobros: '/interno/cobros',
  cuadrantes: '/interno/cuadrantes',
  'casos-importantes': '/interno/casos-importantes',
  suspensiones: '/interno/suspensiones',
  'solicitudes-administrativas': '/interno/solicitudes-administrativas',
  'seguimiento-masivos': '/interno/seguimiento-masivos',
  'conversaciones-whatsapp': '/interno/conversaciones-whatsapp',
  'agentes-ia': '/interno/agentes-ia',
  'pagos-internos': '/interno/pagos-internos',
  'planillas-vehiculo': '/interno/planillas-vehiculo',
  'esquemas-apagado': '/interno/esquemas-apagado',
  garantias: '/interno/garantias',
  rrhh: '/interno/rrhh',
  almacenamiento: '/interno/almacenamiento',
  'sim-consumos': '/interno/sim-consumos',
  inventario: '/interno/inventario',
  'verificacion-pagos': '/interno/verificacion-pagos',
  'apagados-programados': '/interno/apagados-programados',
};

export const ROLE_SECTIONS: Record<Role, Section[]> = {
  tecnico: ['tareas', 'chat', 'planillas-vehiculo'],
  operador: ['novedades', 'novedades-archivadas', 'reportes', 'apagados-programados', 'tareas', 'chat', 'cuadrantes', 'casos-importantes', 'suspensiones', 'garantias'],
  secretaria: ['crm', 'cotizaciones', 'tareas', 'chat', 'cuadrantes', 'suspensiones', 'solicitudes-administrativas'],
  supervisor: ['novedades', 'novedades-archivadas', 'reportes', 'apagados-programados', 'crm', 'cotizaciones', 'tareas', 'chat', 'cuadrantes', 'casos-importantes', 'suspensiones', 'solicitudes-administrativas', 'seguimiento-masivos', 'estadisticas'],
  gerente: ['novedades', 'novedades-archivadas', 'reportes', 'apagados-programados', 'crm', 'cotizaciones', 'tareas', 'auditoria', 'chat', 'cobros', 'cuadrantes', 'casos-importantes', 'suspensiones', 'solicitudes-administrativas', 'seguimiento-masivos', 'pagos-internos', 'planillas-vehiculo', 'esquemas-apagado', 'estadisticas'],
  admin: ['novedades', 'novedades-archivadas', 'reportes', 'apagados-programados', 'crm', 'cotizaciones', 'tareas', 'auditoria', 'usuarios', 'chat', 'estadisticas', 'cobros', 'cuadrantes', 'casos-importantes', 'suspensiones', 'solicitudes-administrativas', 'seguimiento-masivos', 'pagos-internos', 'planillas-vehiculo', 'esquemas-apagado', 'garantias', 'rrhh', 'almacenamiento', 'inventario', 'verificacion-pagos'],
};

export function canAccessSection(role: Role, section: Section): boolean {
  return ROLE_SECTIONS[role]?.includes(section) ?? false;
}

export function firstSectionFor(role: Role): Section | null {
  return ROLE_SECTIONS[role]?.[0] ?? null;
}

// Cobranza especial WP quedó restringida a gerente/admin por rol — quien pueda subir listas
// (canUploadCobros, ver más abajo) también puede entrar, aunque su rol no lo incluya.
export function canAccessCobros(session: Pick<Session, 'role' | 'username'>): boolean {
  return canAccessSection(session.role, 'cobros') || canUploadCobros(session);
}

// Josué (da la solución) y Wilmar (tesorería) siempre necesitan ver Suspensiones,
// sin importar su rol, porque son parte fija del flujo de escalamiento.
export const JOSUE_USERNAME = 'josuegonzalez';
export const WILMAR_USERNAME = 'wilmar';
const SUSPENSIONES_EXTRA_USERNAMES = [JOSUE_USERNAME, WILMAR_USERNAME];

// Apagados y encendidos programados: los registran y confirman operadores y supervisores;
// borrar queda para supervisor en adelante, para que una programación vigente no desaparezca
// por un clic equivocado en la central.
export function canAccessShutdownSchedules(session: Pick<Session, 'role'>): boolean {
  return canAccessSection(session.role, 'apagados-programados');
}

export function canDeleteShutdownSchedules(role: Role): boolean {
  return role === 'supervisor' || role === 'gerente' || role === 'admin';
}

// La alarma suena en la central: operadores y supervisores. Gerencia y admin ven el módulo
// pero no les suena cada apagado.
export function shouldRingShutdownAlarms(role: Role): boolean {
  return role === 'operador' || role === 'supervisor';
}

export function canAccessSuspensiones(session: Pick<Session, 'role' | 'username'>): boolean {
  return canAccessSection(session.role, 'suspensiones') || SUSPENSIONES_EXTRA_USERNAMES.includes(session.username);
}

// Kelly y Wilmar son quienes atienden las Solicitudes Administrativas sin importar su rol.
export const KELLY_USERNAME = 'kellylara';
const SOLICITUDES_EXTRA_USERNAMES = [KELLY_USERNAME, WILMAR_USERNAME];

// El visor de conversaciones de WhatsApp es exclusivo de esta cuenta puntual — ni siquiera
// otros administradores deben poder verlo.
const CONVERSATIONS_VIEWER_USERNAME = 'admin';

export function canViewWhatsappConversations(session: Pick<Session, 'username'>): boolean {
  return session.username.toLowerCase() === CONVERSATIONS_VIEWER_USERNAME;
}

// Configurar los agentes de IA (instrucciones extra, costo) es igual de exclusivo que el
// visor de conversaciones — misma cuenta única.
export function canManageAiAgents(session: Pick<Session, 'username'>): boolean {
  return canViewWhatsappConversations(session);
}

export function canAccessSolicitudesAdministrativas(session: Pick<Session, 'role' | 'username'>): boolean {
  return canAccessSection(session.role, 'solicitudes-administrativas') || SOLICITUDES_EXTRA_USERNAMES.includes(session.username);
}

// Josué y Wilmar necesitan poder configurarle la sucursal a cada usuario (para la
// auto-asignación de Suspensiones), sin darles el resto de permisos de administración.
const BRANCH_MANAGER_USERNAMES = [JOSUE_USERNAME, WILMAR_USERNAME];

export function canSetUserBranches(session: Pick<Session, 'username'>): boolean {
  return BRANCH_MANAGER_USERNAMES.includes(session.username.toLowerCase());
}

// Josué y Wilmar también necesitan ver Pagos internos (de todas las sucursales), igual que
// Suspensiones — el resto de gerentes solo ven los de la suya propia (filtrado en la API).
const PAGOS_INTERNOS_EXTRA_USERNAMES = [JOSUE_USERNAME, WILMAR_USERNAME];

export function canAccessPagosInternos(session: Pick<Session, 'role' | 'username'>): boolean {
  return canAccessSection(session.role, 'pagos-internos') || PAGOS_INTERNOS_EXTRA_USERNAMES.includes(session.username);
}

// Ven los pagos internos de TODAS las sucursales (no solo la propia): admin, Josué y Wilmar.
export function canSeeAllPagosInternos(session: Pick<Session, 'role' | 'username'>): boolean {
  return session.role === 'admin' || PAGOS_INTERNOS_EXTRA_USERNAMES.includes(session.username);
}

// Josué ve las Estadísticas completas de todo el país, aunque su rol no sea admin/gerente/
// supervisor — el resto de gerentes/supervisores ven solo lo suyo (acotado en dashboard-stats.ts).
export function canAccessEstadisticas(session: Pick<Session, 'role' | 'username'>): boolean {
  return canAccessSection(session.role, 'estadisticas') || session.username.toLowerCase() === JOSUE_USERNAME;
}

// Recursos Humanos (incluye horarios, compensatorios y contratos, antes en la sección aparte
// "horario") quedó restringido a admin más Josué y Wilmar puntualmente, no a gerente/supervisor
// en general — decisión explícita de Gabriel, no el patrón por rol que se usa en el resto.
const RRHH_EXTRA_USERNAMES = [JOSUE_USERNAME, WILMAR_USERNAME];

export function canAccessRRHH(session: Pick<Session, 'role' | 'username'>): boolean {
  return session.role === 'admin' || RRHH_EXTRA_USERNAMES.includes(session.username);
}

// Planilla de vehículo: además de técnicos, gerentes y admin, la cargan Cristian y Jhony Parra
// (pedido de Gabriel, 2026-10-07). Ven y registran las planillas de sus propias sucursales.
const PLANILLAS_EXTRA_USERNAMES = ['cristianzambrano1', 'jhonyparra'];
// Sucursal fija de las planillas de estos usuarios, por encima de la sucursal de su perfil:
// Cristian llena planillas solo del punto de Bucaramanga (Gabriel, 2026-10-07).
const PLANILLAS_BRANCH_OVERRIDE: Record<string, string> = { cristianzambrano1: 'Bucaramanga' };
export function planillaBranchFor(session: Pick<Session, 'username'>, user: Pick<User, 'branch' | 'branches'> | null | undefined): string {
  return PLANILLAS_BRANCH_OVERRIDE[session.username.toLowerCase()] || branchesOf(user)[0] || '';
}
export function planillaBranchesFor(session: Pick<Session, 'username'>, user: Pick<User, 'branch' | 'branches'> | null | undefined): string[] {
  const fija = PLANILLAS_BRANCH_OVERRIDE[session.username.toLowerCase()];
  return fija ? [fija] : branchesOf(user);
}
export function canAccessPlanillasVehiculo(session: Pick<Session, 'role' | 'username'>): boolean {
  return canAccessSection(session.role, 'planillas-vehiculo') || PLANILLAS_EXTRA_USERNAMES.includes(session.username.toLowerCase());
}
// Quién llena planillas (el formulario de ingreso): los técnicos y los dos nombrados arriba,
// aunque su rol sea gerente. Gerente y admin solo consultan.
export function canFillPlanillaVehiculo(session: Pick<Session, 'role' | 'username'>): boolean {
  return session.role === 'tecnico' || PLANILLAS_EXTRA_USERNAMES.includes(session.username.toLowerCase());
}

// Consumo de SIM: los archivos del operador los suben y analizan Cristian (inventario nacional)
// y Josué; el admin también lo ve.
const SIM_CONSUMOS_USERNAMES = [JOSUE_USERNAME, 'cristianzambrano1'];
export function canAccessSimConsumos(session: Pick<Session, 'role' | 'username'>): boolean {
  return session.role === 'admin' || SIM_CONSUMOS_USERNAMES.includes(session.username.toLowerCase());
}

// Verificación de pagos (decisión de Gabriel, 2026-10-07): la ven solo Kelly, Wilmar, Cristian y el
// admin, todas las sucursales; Kelly, Wilmar y el admin son los únicos que aprueban o rechazan a mano.
const PAGOS_VERIFICACION_RESOLVERS = [KELLY_USERNAME, WILMAR_USERNAME];
const PAGOS_VERIFICACION_VIEWERS = [...PAGOS_VERIFICACION_RESOLVERS, 'cristianzambrano1'];
export function canAccessVerificacionPagos(session: Pick<Session, 'role' | 'username'>): boolean {
  return session.role === 'admin' || PAGOS_VERIFICACION_VIEWERS.includes(session.username.toLowerCase());
}
export function canResolveVerificacionPagos(session: Pick<Session, 'role' | 'username'>): boolean {
  return session.role === 'admin' || PAGOS_VERIFICACION_RESOLVERS.includes(session.username.toLowerCase());
}

export function sectionsFor(session: Pick<Session, 'role' | 'username'>, user?: Pick<User, 'inventoryBranches'> | null): Section[] {
  const base = ROLE_SECTIONS[session.role] || [];
  const extra: Section[] = [];
  if (!base.includes('cobros') && canAccessCobros(session)) extra.push('cobros');
  if (!base.includes('suspensiones') && canAccessSuspensiones(session)) extra.push('suspensiones');
  if (!base.includes('solicitudes-administrativas') && canAccessSolicitudesAdministrativas(session)) extra.push('solicitudes-administrativas');
  if (!base.includes('pagos-internos') && canAccessPagosInternos(session)) extra.push('pagos-internos');
  if (!base.includes('estadisticas') && canAccessEstadisticas(session)) extra.push('estadisticas');
  if (!base.includes('usuarios') && canSetUserBranches(session)) extra.push('usuarios');
  if (!base.includes('rrhh') && canAccessRRHH(session)) extra.push('rrhh');
  if (!base.includes('garantias') && canUploadGarantias(session)) extra.push('garantias');
  if (canViewWhatsappConversations(session)) extra.push('conversaciones-whatsapp');
  if (canManageAiAgents(session)) extra.push('agentes-ia');
  if (canAccessSimConsumos(session)) extra.push('sim-consumos');
  if (!base.includes('verificacion-pagos') && canAccessVerificacionPagos(session)) extra.push('verificacion-pagos');
  if (!base.includes('planillas-vehiculo') && canAccessPlanillasVehiculo(session)) extra.push('planillas-vehiculo');
  // Inventario de sucursal: lo ve el admin (todas las sucursales) y los encargados de
  // inventario, que se marcan por usuario en Usuarios. Como eso vive en el registro del
  // usuario y no en la sesión, el layout pasa el usuario cuando lo tiene a la mano.
  if (!base.includes('inventario') && user && inventoryBranchesOf(user).length) extra.push('inventario');
  return extra.length ? [...base, ...extra] : base;
}

// Sucursales en las que el usuario es el encargado de llevar el inventario físico.
export function inventoryBranchesOf(user: Pick<User, 'inventoryBranches'> | null | undefined): string[] {
  return user?.inventoryBranches && user.inventoryBranches.length ? user.inventoryBranches : [];
}

// Sucursales de inventario que puede ver y editar: el admin todas, el encargado las suyas.
export function inventoryScopeFor(session: Pick<Session, 'role'>, user: Pick<User, 'inventoryBranches'> | null | undefined): string[] {
  if (session.role === 'admin') return BRANCHES.filter((b) => b !== 'Central de Monitoreo');
  return inventoryBranchesOf(user);
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

// Usuarios puntuales con permiso para subir listas de Cobranza especial WP aunque su
// rol no lo incluya, además de supervisor/gerente/admin (que ya lo tienen).
const COBROS_UPLOAD_EXTRA_USERNAMES = ['wilmar'];

export function canUploadCobros(session: Pick<Session, 'role' | 'username'>): boolean {
  return canVerifyInstalls(session.role) || COBROS_UPLOAD_EXTRA_USERNAMES.includes(session.username);
}

export function canManageUsers(role: Role): boolean {
  return role === 'admin';
}

// Solo Wilmar y admin pueden subir el Excel de garantías y repartirlas — pedido puntual de
// Gabriel (no supervisor/gerente en general, a diferencia de Cobros).
export function canUploadGarantias(session: Pick<Session, 'role' | 'username'>): boolean {
  return session.role === 'admin' || session.username === WILMAR_USERNAME;
}

// Los operadores ven la sección para trabajar sus garantías asignadas; Wilmar necesita entrar
// aunque su rol no sea admin, para poder subir el Excel.
export function canAccessGarantias(session: Pick<Session, 'role' | 'username'>): boolean {
  return canAccessSection(session.role, 'garantias') || canUploadGarantias(session);
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
  /** @deprecated usar `branches` — se conserva solo por compatibilidad con datos viejos */
  branch?: string | null;
  branches?: string[];
  // Sucursales donde este usuario es el encargado del inventario físico (ver Inventario).
  inventoryBranches?: string[];
}

export const BRANCHES = ['Riohacha', 'Valledupar', 'Santa Marta', 'Maicao', 'Atlántico', 'Bucaramanga', 'Medellín', 'Montería', 'Central de Monitoreo'];

// Un usuario puede tener varias sucursales asignadas (branches). Esta función normaliza los
// datos viejos que todavía solo tengan el campo singular `branch`, para no requerir migración.
export function branchesOf(user: Pick<User, 'branch' | 'branches'> | null | undefined): string[] {
  if (!user) return [];
  if (user.branches && user.branches.length) return user.branches;
  return user.branch ? [user.branch] : [];
}

export interface Session {
  userId: string;
  username: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  lastActivityAt: string;
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

// Comparación en tiempo constante del secreto de los crons (Authorization: Bearer <secreto>).
export function cronSecretMatches(authHeader: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(String(authHeader));
  return expected.length === given.length && timingSafeEqual(expected, given);
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
    lastActivityAt: now.toISOString(),
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
  const { raw, fromCache } = await readSessionRaw(redis, sessionId);
  if (!raw) return null;
  let session: Session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  const now = Date.now();
  if (new Date(session.expiresAt).getTime() < now) {
    await redis.hdel(SESSIONS_KEY, sessionId);
    forgetSessionCache(sessionId);
    return null;
  }
  if (session.lastActivityAt && now - new Date(session.lastActivityAt).getTime() > INACTIVITY_TIMEOUT_MS) {
    await redis.hdel(SESSIONS_KEY, sessionId);
    forgetSessionCache(sessionId);
    return null;
  }
  // Cada request válido marca actividad, para que las 4 horas de inactividad se cuenten
  // desde el último uso real, no desde el login. Se escribe como mucho una vez por minuto:
  // con los sondeos automáticos del panel, escribirla en cada petición era una escritura a
  // Redis por cada lectura, y a esa precisión nadie la necesita.
  // Solo se escribe cuando la sesión acaba de leerse de Redis: si viniera de la caché en
  // memoria, un cierre de sesión (o borrado por el admin) hecho en otra instancia dentro de
  // esos 5 segundos quedaría deshecho por este HSET y la sesión resucitaría.
  const lastActivity = session.lastActivityAt ? new Date(session.lastActivityAt).getTime() : 0;
  if (!fromCache && now - lastActivity > 60_000) {
    session.lastActivityAt = new Date(now).toISOString();
    const text = JSON.stringify(session);
    await redis.hset(SESSIONS_KEY, { [sessionId]: text });
    sessionCache.set(sessionId, { at: Date.now(), raw: text });
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
  forgetSessionCache(sessionId);
}

// Las sesiones vencidas solo se borran cuando alguien intenta usarlas (getSession). Las que
// nunca vuelven a tocarse (celular cambiado, usuario que no regresa) quedarían para siempre en
// el hash, por eso la limpieza mensual las barre aparte.
export async function purgeExpiredSessions(redis: Redis, dryRun = false): Promise<number> {
  const raw = (await redis.hgetall<Record<string, string>>(SESSIONS_KEY)) || {};
  const now = Date.now();
  const toDelete: string[] = [];
  for (const [sessionId, v] of Object.entries(raw)) {
    try {
      const session: Session = typeof v === 'string' ? JSON.parse(v) : (v as any);
      const expired = new Date(session.expiresAt).getTime() < now;
      const inactive = session.lastActivityAt && now - new Date(session.lastActivityAt).getTime() > INACTIVITY_TIMEOUT_MS;
      if (expired || inactive) toDelete.push(sessionId);
    } catch {
      toDelete.push(sessionId);
    }
  }
  if (toDelete.length && !dryRun) await redis.hdel(SESSIONS_KEY, ...toDelete);
  return toDelete.length;
}

// Cierra las demás sesiones del usuario y conserva la actual (la del cookieValue dado).
// Solo mira la sesión (sin tocar actividad): lo usa el middleware para exigir el cambio de la
// clave inicial también en la API, no solo en las páginas.
export async function sessionMustChangePassword(cookieValue: string | undefined): Promise<boolean> {
  if (!cookieValue) return false;
  const sessionId = parseCookieValue(cookieValue);
  if (!sessionId) return false;
  const redis = getRedis();
  if (!redis) return false;
  try {
    const { raw } = await readSessionRaw(redis, sessionId);
    if (!raw) return false;
    const session: Session = JSON.parse(raw);
    return !!session.mustChangePassword;
  } catch {
    return false;
  }
}

export async function destroyOtherSessionsForUser(redis: Redis, userId: string, currentCookieValue: string | undefined): Promise<void> {
  const keep = currentCookieValue ? parseCookieValue(currentCookieValue) : null;
  const raw = (await redis.hgetall<Record<string, string>>(SESSIONS_KEY)) || {};
  const toDelete: string[] = [];
  for (const [sessionId, v] of Object.entries(raw)) {
    if (sessionId === keep) continue;
    try {
      const session: Session = typeof v === 'string' ? JSON.parse(v) : (v as any);
      if (session.userId === userId) toDelete.push(sessionId);
    } catch {
      // entrada corrupta, se ignora
    }
  }
  if (toDelete.length) await redis.hdel(SESSIONS_KEY, ...toDelete);
  forgetSessionCache();
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
  forgetSessionCache();
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
