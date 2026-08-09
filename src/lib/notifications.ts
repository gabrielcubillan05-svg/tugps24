import { randomUUID } from 'node:crypto';
import { getRedis } from './redis';
import { getUsers, type Session } from './auth';

const NOTIF_KEY_PREFIX = 'internal:notifications:';
const MAX_NOTIFICATIONS = 200;

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
}

async function readRawNotifications(redis: Redis, userId: string): Promise<NotificationEntry[]> {
  const raw = (await redis.hgetall<Record<string, string>>(keyFor(userId))) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((e): e is NotificationEntry => e !== null);
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
  return new Date(t.dueDate).getTime() < new Date().setHours(0, 0, 0, 0);
}

function isLeadOverdue(l: MiniLead): boolean {
  if (!l.nextFollowUp) return false;
  if (l.status === 'Instalado' || l.status === 'Perdido') return false;
  return new Date(l.nextFollowUp).getTime() < new Date().setHours(0, 0, 0, 0);
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

export async function syncComputedNotifications(redis: Redis, session: Session): Promise<void> {
  const isManager = session.role === 'supervisor' || session.role === 'gerente' || session.role === 'admin';
  const users = await getUsers(redis);
  const me = users.find((u) => u.id === session.userId);
  const myName = me?.name || session.username;

  const computed = new Map<string, { message: string; link: string }>();

  const tasks = await readHashList<MiniTask>(redis, 'internal:tasks');
  tasks.forEach((t) => {
    if (!isTaskOverdue(t)) return;
    const mine = t.assigneeId === session.userId;
    if (mine || isManager) {
      computed.set(`overdue-task:${t.id}`, {
        message: mine ? `Tarea vencida: ${t.title}` : `Tarea vencida de ${t.assigneeName}: ${t.title}`,
        link: '/interno/tareas',
      });
    }
  });

  if (session.role === 'secretaria' || isManager) {
    const leads = await readHashList<MiniLead>(redis, 'internal:leads');
    leads.forEach((l) => {
      if (!isLeadOverdue(l)) return;
      const mine = l.secretary === myName;
      if (mine || isManager) {
        computed.set(`overdue-lead:${l.id}`, {
          message: mine
            ? `Lead sin seguimiento: ${l.name}`
            : `Lead sin seguimiento (${l.secretary || 'sin asignar'}): ${l.name}`,
          link: '/interno/crm',
        });
      }
    });
  }

  if (session.role === 'operador' || isManager) {
    const reports = await readHashList<MiniScheduledReport>(redis, 'internal:scheduled-reports');
    reports.forEach((r) => {
      if (!isScheduledReportPending(r)) return;
      const mine = r.operator === myName;
      if (mine || isManager) {
        computed.set(`overdue-report:${r.id}`, {
          message: mine
            ? `Reporte vencido: ${r.client} — ${r.reportType}`
            : `Reporte vencido (${r.operator}): ${r.client} — ${r.reportType}`,
          link: '/interno/reportes',
        });
      }
    });
  }

  const existing = await readRawNotifications(redis, session.userId);
  const existingComputedKeys = new Set(existing.filter((e) => e.id.startsWith('overdue-')).map((e) => e.id));

  const toDelete: string[] = [];
  existingComputedKeys.forEach((key) => {
    if (!computed.has(key)) toDelete.push(key);
  });
  if (toDelete.length) {
    await redis.hdel(keyFor(session.userId), ...toDelete);
  }

  for (const [key, data] of computed.entries()) {
    if (!existingComputedKeys.has(key)) {
      await pushNotification(redis, session.userId, { type: 'overdue', message: data.message, link: data.link, key });
    }
  }
}

export async function readNotifications(
  redis: Redis,
  userId: string
): Promise<{ notifications: NotificationEntry[]; unreadCount: number }> {
  let entries = await readRawNotifications(redis, userId);
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (entries.length > MAX_NOTIFICATIONS) {
    const toDelete = entries.slice(MAX_NOTIFICATIONS).map((e) => e.id);
    await redis.hdel(keyFor(userId), ...toDelete);
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
