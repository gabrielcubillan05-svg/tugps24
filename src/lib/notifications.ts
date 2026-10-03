import { randomUUID } from 'node:crypto';
import { getRedis } from './redis';
import { getUsers, type Session } from './auth';
import { sendPushToUser } from './push';
import { isOverdueInColombia } from './colombia-time';

export const NOTIF_KEY_PREFIX = 'internal:notifications:';
export const MAX_NOTIFICATIONS = 200;
// Margen antes de recortar al escribir: así no se relee el hash completo en cada aviso, solo
// cuando ya se pasó un poco del tope.
const TRIM_SLACK = 50;
const WRITE_TRIM_MAX = 2000;

export interface NotificationEntry {
  id: string;
  type: string;
  message: string;
  link: string;
  read: boolean;
  createdAt: string;
}

type Redis = NonNullable<ReturnType<typeof getRedis>>;

function keyFor(userId: string): string {
  return `${NOTIF_KEY_PREFIX}${userId}`;
}

export async function pushNotification(
  redis: Redis,
  userId: string,
  data: { type: string; message: string; link: string; key?: string }
): Promise<void> {
  const id = data.key || randomUUID();
  const entry: NotificationEntry = {
    id,
    type: data.type,
    message: data.message,
    link: data.link,
    read: false,
    createdAt: new Date().toISOString(),
  };
  await redis.hset(keyFor(userId), { [id]: JSON.stringify(entry) });

  // El tope solo se aplicaba al abrir la campanita: a quien no la abría se le acumulaban
  // miles de avisos (84.000 entre 49 usuarios cuando se detectó). Ahora se recorta al escribir.
  try {
    const size = Number(await redis.hlen(keyFor(userId))) || 0;
    // Los hashes gigantes heredados (miles de avisos) los recorta la limpieza diaria, que corre
    // sin prisa; aquí solo se mantiene a raya el día a día.
    if (size > MAX_NOTIFICATIONS + TRIM_SLACK && size <= WRITE_TRIM_MAX) await trimNotifications(redis, userId);
  } catch {
    // recortar nunca debe tumbar el aviso
  }

  // Además del aviso dentro de la campanita, manda push real (llega aunque tenga la app
  // cerrada) — no bloquea ni rompe nada si el usuario no se ha suscrito todavía.
  try {
    await sendPushToUser(redis, userId, { title: 'TuGPS24 Interno', body: data.message, link: data.link });
  } catch {
    // nunca debe tumbar la notificación normal
  }
}

// Se lee por páginas (hscan) y no con hgetall: a los usuarios con decenas de miles de avisos
// acumulados un hgetall les superaba el tope de 10 MB por petición de Upstash y fallaba.
async function readRawNotifications(redis: Redis, userId: string): Promise<NotificationEntry[]> {
  const entries: NotificationEntry[] = [];
  let cursor: string | number = 0;
  do {
    const [next, flat] = await redis.hscan(keyFor(userId), cursor, { count: 500 });
    cursor = next;
    const pairs = Array.isArray(flat) ? flat : [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const v = pairs[i + 1];
      try {
        const parsed = typeof v === 'string' ? JSON.parse(v) : v;
        if (parsed && typeof parsed === 'object') entries.push(parsed as NotificationEntry);
      } catch {
        // entrada corrupta, se ignora
      }
    }
  } while (String(cursor) !== '0');
  return entries;
}

// --- Lectura mínima autocontenida de tareas/leads/reportes ---
// (deliberadamente no reutiliza los helpers de src/pages/api/*.ts para evitar un import circular,
// ya que esos mismos archivos llaman a pushNotification()).

interface MiniTask { id: string; assigneeId: string; assigneeName: string; title: string; dueDate: string | null; status: string }
interface MiniLead { id: string; name: string; secretary: string; nextFollowUp: string | null; status: string }
interface MiniScheduledReport { id: string; client: string; reportType: string; operator: string; frequency: string; lastDoneAt: string | null; createdAt: string }

function isTaskOverdue(t: MiniTask): boolean {
  if (!t.dueDate) return false;
  if (t.status === 'Completada' || t.status === 'Cancelada') return false;
  return isOverdueInColombia(t.dueDate.slice(0, 10));
}

function isLeadOverdue(l: MiniLead): boolean {
  if (!l.nextFollowUp) return false;
  if (l.status === 'Instalado' || l.status === 'Perdido') return false;
  return isOverdueInColombia(l.nextFollowUp.slice(0, 10));
}

const REPORT_FREQUENCIES: Record<string, number> = { Diario: 1, Semanal: 7, Quincenal: 15, Mensual: 30 };
function isScheduledReportPending(r: MiniScheduledReport): boolean {
  const intervalDays = REPORT_FREQUENCIES[r.frequency] || 7;
  const base = new Date(r.lastDoneAt || r.createdAt);
  const nextDue = new Date(base.getTime() + intervalDays * 24 * 60 * 60 * 1000);
  return nextDue.getTime() <= Date.now();
}

async function readHashList<T>(redis: Redis, key: string): Promise<T[]> {
  const raw = (await redis.hgetall<Record<string, string>>(key)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((e): e is T => e !== null);
}

// Avisos calculados ("vencidos"). Antes se recalculaban POR USUARIO: cada campanita releía
// tareas, leads y reportes completos y, para supervisores y gerencia, creaba un aviso por cada
// lead sin seguimiento o tarea vencida de toda la empresa (cientos), cada uno con su push al
// celular. Como el tope de 200 por usuario los recortaba, al siguiente ciclo se volvían a crear:
// un bucle de cientos de escrituras y pushes cada cinco minutos por cada jefe, que fue lo que
// acumuló 84.000 avisos y tenía la base saturada. Ahora se calcula UNA vez para todos cada
// cinco minutos, con un resumen por categoría en vez de un aviso por ítem, y sin push.
const SYNC_THROTTLE_SECONDS = 300;
const SYNC_LOCK_KEY = 'internal:notif-sync:global';
// Lo propio sí se lista uno por uno hasta este tope; de ahí en adelante va un solo resumen.
const OWN_ITEMS_MAX = 12;
const COMPUTED_PREFIX = 'overdue-';

type Computed = Map<string, { message: string; link: string }>;

function topNames(counts: Map<string, number>, max = 3): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name, n]) => `${name || 'sin asignar'} ${n}`)
    .join(', ');
}

function countBy<T>(items: T[], by: (t: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of items) out.set(by(i), (out.get(by(i)) || 0) + 1);
  return out;
}

function addOwnOrDigest<T extends { id: string }>(
  computed: Computed,
  items: T[],
  keyPrefix: string,
  link: string,
  itemMessage: (t: T) => string,
  digestMessage: (n: number) => string
): void {
  if (!items.length) return;
  if (items.length <= OWN_ITEMS_MAX) {
    for (const t of items) computed.set(`${keyPrefix}:${t.id}`, { message: itemMessage(t), link });
  } else {
    computed.set(`${keyPrefix}-digest`, { message: digestMessage(items.length), link });
  }
}

function computedForUser(
  user: { id: string; name: string; role: string },
  overdueTasks: MiniTask[],
  overdueLeads: MiniLead[],
  pendingReports: MiniScheduledReport[]
): Computed {
  const computed: Computed = new Map();
  const isManager = user.role === 'supervisor' || user.role === 'gerente' || user.role === 'admin';

  addOwnOrDigest(
    computed,
    overdueTasks.filter((t) => t.assigneeId === user.id),
    'overdue-task',
    '/interno/tareas',
    (t) => `Tarea vencida: ${t.title}`,
    (n) => `Tienes ${n} tareas vencidas`
  );
  if (user.role === 'secretaria' || isManager) {
    addOwnOrDigest(
      computed,
      overdueLeads.filter((l) => l.secretary === user.name),
      'overdue-lead',
      '/interno/crm',
      (l) => `Lead sin seguimiento: ${l.name}`,
      (n) => `Tienes ${n} leads sin seguimiento`
    );
  }
  if (user.role === 'operador' || isManager) {
    addOwnOrDigest(
      computed,
      pendingReports.filter((r) => r.operator === user.name),
      'overdue-report',
      '/interno/reportes',
      (r) => `Reporte vencido: ${r.client} — ${r.reportType}`,
      (n) => `Tienes ${n} reportes programados vencidos`
    );
  }

  if (isManager) {
    const teamTasks = overdueTasks.filter((t) => t.assigneeId !== user.id);
    if (teamTasks.length) {
      computed.set('overdue-tasks-team', {
        message: `${teamTasks.length} tareas vencidas en el equipo (${topNames(countBy(teamTasks, (t) => t.assigneeName))})`,
        link: '/interno/tareas',
      });
    }
    const teamLeads = overdueLeads.filter((l) => l.secretary !== user.name);
    if (teamLeads.length) {
      computed.set('overdue-leads-team', {
        message: `${teamLeads.length} leads sin seguimiento (${topNames(countBy(teamLeads, (l) => l.secretary))})`,
        link: '/interno/crm',
      });
    }
    const teamReports = pendingReports.filter((r) => r.operator !== user.name);
    if (teamReports.length) {
      computed.set('overdue-reports-team', {
        message: `${teamReports.length} reportes programados vencidos (${topNames(countBy(teamReports, (r) => r.operator))})`,
        link: '/interno/reportes',
      });
    }
  }
  return computed;
}

async function applyComputed(redis: Redis, userId: string, computed: Computed): Promise<void> {
  const existing = await readRawNotifications(redis, userId);
  const existingComputed = new Map(existing.filter((e) => e.id.startsWith(COMPUTED_PREFIX)).map((e) => [e.id, e]));

  const toDelete = [...existingComputed.keys()].filter((key) => !computed.has(key));
  if (toDelete.length) await redis.hdel(keyFor(userId), ...toDelete);

  const toWrite: Record<string, string> = {};
  for (const [key, data] of computed.entries()) {
    const current = existingComputed.get(key);
    // Si el texto no cambió se deja tal cual (conserva el "leído"); si cambió el conteo, se
    // vuelve a marcar como no leído.
    if (current && current.message === data.message) continue;
    const entry: NotificationEntry = { id: key, type: 'overdue', message: data.message, link: data.link, read: false, createdAt: new Date().toISOString() };
    toWrite[key] = JSON.stringify(entry);
  }
  if (Object.keys(toWrite).length) await redis.hset(keyFor(userId), toWrite);
}

export async function syncComputedNotifications(redis: Redis, _session?: Session): Promise<void> {
  const claimed = await redis.set(SYNC_LOCK_KEY, '1', { nx: true, ex: SYNC_THROTTLE_SECONDS });
  if (!claimed) return;

  const [users, tasks, leads, reports] = await Promise.all([
    getUsers(redis),
    readHashList<MiniTask>(redis, 'internal:tasks'),
    readHashList<MiniLead>(redis, 'internal:leads'),
    readHashList<MiniScheduledReport>(redis, 'internal:scheduled-reports'),
  ]);
  const overdueTasks = tasks.filter(isTaskOverdue);
  const overdueLeads = leads.filter(isLeadOverdue);
  const pendingReports = reports.filter(isScheduledReportPending);

  for (const user of users.filter((u) => u.active)) {
    try {
      // Los hashes heredados con miles de avisos se recortan aquí mismo (hlen es gratis): si no,
      // cada campanita de ese usuario seguiría leyendo megas cada 45 s hasta la limpieza diaria.
      const size = Number(await redis.hlen(keyFor(user.id))) || 0;
      if (size > MAX_NOTIFICATIONS + TRIM_SLACK) await trimNotifications(redis, user.id);
      await applyComputed(redis, user.id, computedForUser(user, overdueTasks, overdueLeads, pendingReports));
    } catch (err) {
      console.error('notif-sync: fallo con usuario', user.id, err instanceof Error ? err.message : String(err));
    }
  }
}

// Deja solo las MAX_NOTIFICATIONS más recientes del usuario. Devuelve cuántas borró.
export async function trimNotifications(redis: Redis, userId: string): Promise<number> {
  const entries = await readRawNotifications(redis, userId);
  if (entries.length <= MAX_NOTIFICATIONS) return 0;
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const toDelete = entries.slice(MAX_NOTIFICATIONS).map((e) => e.id);
  for (let i = 0; i < toDelete.length; i += 500) {
    await redis.hdel(keyFor(userId), ...toDelete.slice(i, i + 500));
  }
  return toDelete.length;
}

export async function readNotifications(
  redis: Redis,
  userId: string
): Promise<{ notifications: NotificationEntry[]; unreadCount: number }> {
  let entries = await readRawNotifications(redis, userId);
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (entries.length > MAX_NOTIFICATIONS) {
    await trimNotifications(redis, userId);
    entries = entries.slice(0, MAX_NOTIFICATIONS);
  }
  const unreadCount = entries.filter((e) => !e.read).length;
  return { notifications: entries, unreadCount };
}

export async function removeNotification(redis: Redis, userId: string, id: string): Promise<void> {
  await redis.hdel(keyFor(userId), id);
}

export async function markNotificationRead(redis: Redis, userId: string, id: string): Promise<void> {
  const raw = await redis.hget<string>(keyFor(userId), id);
  if (!raw) return;
  const entry: NotificationEntry = typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
  entry.read = true;
  await redis.hset(keyFor(userId), { [id]: JSON.stringify(entry) });
}

export async function markAllNotificationsRead(redis: Redis, userId: string): Promise<void> {
  const entries = await readRawNotifications(redis, userId);
  const updates: Record<string, string> = {};
  entries.forEach((e) => {
    if (!e.read) {
      e.read = true;
      updates[e.id] = JSON.stringify(e);
    }
  });
  if (Object.keys(updates).length) await redis.hset(keyFor(userId), updates);
}
