// Inventario y limpieza del almacenamiento (Redis + Vercel Blob). Lo usan el reporte de la
// sección Almacenamiento (solo admin) y el cron mensual de limpieza. Toda regla de retención
// vive aquí, en las constantes de abajo, para que cambiarla sea un solo lugar.

import { del, list, put } from '@vercel/blob';
import { readLeads, deleteLeads, type Lead } from '../pages/api/leads';
import { readTasks, REDIS_KEY as TASKS_KEY, type Task } from '../pages/api/tasks';
import { CONVERSATIONS_KEY as LEAD_CONVERSATIONS_KEY } from '../pages/api/whatsapp-webhook';
import { purgeExpiredSessions } from './auth';
import { NOTIF_KEY_PREFIX, trimNotifications } from './notifications';
import { todayInColombia } from './colombia-time';
import { bumpVersion, REPORTS_VERSION_KEY } from './versions';

// ---------------------------------------------------------------- Reglas de retención
export const RETENTION = {
  // Auditoría: la pantalla solo muestra las últimas 500 entradas; lo demás solo ocupa.
  auditKeepDays: 90,
  // Novedades: el texto es barato (27 MB por 77.000 registros) y se conserva un año; las fotos
  // son casi todo el Blob (1,8 GB en dos meses) y se borran antes, dejando el registro sin
  // imágenes. Pasado el año, el texto se archiva a un JSON en Blob (carpeta archive/).
  reportsPhotosKeepDays: 90,
  reportsArchiveAfterDays: 365,
  // Leads sin cerrar (Nuevo/Contactado) o perdidos, sin movimiento en este tiempo: pasan a
  // internal:leads-archive y se borra su historial de WhatsApp. Si el cliente vuelve a
  // escribir, Andrés lo atiende como lead nuevo.
  leadsArchiveAfterDays: 180,
  leadsArchivableStatuses: ['Nuevo', 'Contactado', 'Perdido'],
  // Tareas completadas o canceladas: pasan a internal:tasks-archive y se borra la foto de
  // evidencia.
  tasksArchiveAfterDays: 180,
};

// Topes por corrida para que el cron termine dentro del tiempo de una función serverless.
// Si queda más por limpiar, lo toma la corrida del mes siguiente.
const MAX_AUDIT_SCAN = 20000;
const MAX_REPORTS_PER_RUN = 5000;
// Novedades a las que se les borran las fotos por corrida: entran unas 1.300 al día, así que
// con la corrida diaria esto deja margen para ponerse al día si alguna falla.
const MAX_PHOTO_REPORTS_PER_RUN = 3000;
const MAX_NOTIFICATION_USERS = 500;
const MAX_LEADS_PER_RUN = 2000;
const MAX_TASKS_PER_RUN = 2000;
const LIST_CHUNK = 500;
const BLOB_DEL_BATCH = 100;

const AUDIT_KEY = 'internal:audit';
const REPORTS_KEY = 'internal:reports';
// Cuántas entradas del final de la lista de novedades ya quedaron sin fotos. Permite que cada
// corrida empiece a revisar justo donde terminó la anterior en vez de recorrer decenas de
// miles de entradas ya procesadas (los índices negativos no se mueven con los lpush del frente).
const REPORTS_PHOTOS_PURGED_COUNT_KEY = 'internal:reports-photos-purged-count';
const LEADS_ARCHIVE_KEY = 'internal:leads-archive';
const TASKS_ARCHIVE_KEY = 'internal:tasks-archive';

export interface CleanupSummary {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  audit: { removed: number };
  reports: { archived: number; imagesDeleted: number; archiveFile: string | null; moreLeft: boolean; photosPurged: number; reportsWithoutPhotos: number };
  leads: { archived: number; conversationsDeleted: number };
  tasks: { archived: number; proofsDeleted: number };
  notifications: { removed: number; usersTrimmed: number };
  sessions: { removed: number };
  errors: string[];
}

function parseEntry(raw: unknown): any | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Las listas de auditoría y novedades se llenan con lpush (lo nuevo al frente), así que lo
// viejo está contiguo al final. Se recorre desde la cola hacia atrás, saltando `skip` entradas
// ya procesadas, y se para en la primera entrada que ya no sea vieja. Devuelve las entradas
// viejas de la más antigua a la más nueva, cada una con su índice negativo (estable aunque
// entren entradas nuevas al frente mientras tanto).
async function collectOldTail(
  redis: any,
  key: string,
  isOld: (entry: any) => boolean,
  maxScan: number,
  skip = 0
): Promise<{ entry: any; index: number }[]> {
  const old: { entry: any; index: number }[] = [];
  let scanned = skip;
  while (scanned - skip < maxScan) {
    const end = -1 - scanned;
    const start = end - LIST_CHUNK + 1;
    const chunk: unknown[] = (await redis.lrange(key, start, end)) || [];
    if (!chunk.length) break;
    let stop = false;
    for (let i = chunk.length - 1; i >= 0; i--) {
      const entry = parseEntry(chunk[i]);
      const index = end - (chunk.length - 1 - i);
      if (entry && isOld(entry)) old.push({ entry, index });
      else {
        stop = true;
        break;
      }
    }
    scanned += chunk.length;
    if (stop || chunk.length < LIST_CHUNK) break;
  }
  return old;
}

async function deleteBlobs(pathnames: string[], token: string, errors: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < pathnames.length; i += BLOB_DEL_BATCH) {
    const batch = pathnames.slice(i, i + BLOB_DEL_BATCH);
    try {
      await del(batch, { token });
      deleted += batch.length;
    } catch (err) {
      errors.push(`Blob: no se pudieron borrar ${batch.length} archivos (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return deleted;
}

// Última entrada real de la lista: si no coincide con la última que se recorrió, otra corrida
// (cron y "Ejecutar ahora" a la vez) ya movió la cola y recortar por conteo borraría de más.
async function tailMatches(redis: any, key: string, expectedId: string | undefined): Promise<boolean> {
  if (!expectedId) return false;
  const raw = await redis.lindex(key, -1);
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return !!parsed && parsed.id === expectedId;
  } catch {
    return false;
  }
}

export async function runCleanup(redis: any, options: { dryRun: boolean }): Promise<CleanupSummary> {
  const { dryRun } = options;
  if (!dryRun) {
    const lock = await redis.set('internal:cleanup-lock', '1', { nx: true, ex: 900 });
    if (!lock) {
      const now = new Date().toISOString();
      return {
        dryRun, startedAt: now, finishedAt: now,
        audit: { removed: 0 }, reports: { archived: 0, imagesDeleted: 0, archiveFile: null, moreLeft: false, photosPurged: 0, reportsWithoutPhotos: 0 },
        leads: { archived: 0, conversationsDeleted: 0 }, tasks: { archived: 0, proofsDeleted: 0 }, notifications: { removed: 0, usersTrimmed: 0 }, sessions: { removed: 0 },
        errors: ['Ya hay otra limpieza en curso; no se hizo nada para no recortar dos veces.'],
      };
    }
  }
  try {
    return await runCleanupUnlocked(redis, options);
  } finally {
    if (!dryRun) await redis.del('internal:cleanup-lock').catch(() => {});
  }
}

async function runCleanupUnlocked(redis: any, options: { dryRun: boolean }): Promise<CleanupSummary> {
  const { dryRun } = options;
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  const summary: CleanupSummary = {
    dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    audit: { removed: 0 },
    reports: { archived: 0, imagesDeleted: 0, archiveFile: null, moreLeft: false, photosPurged: 0, reportsWithoutPhotos: 0 },
    leads: { archived: 0, conversationsDeleted: 0 },
    tasks: { archived: 0, proofsDeleted: 0 },
    notifications: { removed: 0, usersTrimmed: 0 },
    sessions: { removed: 0 },
    errors: [],
  };

  // ---- Auditoría: recortar lo más viejo que el plazo
  try {
    const cutoff = daysAgoIso(RETENTION.auditKeepDays);
    const old = (await collectOldTail(redis, AUDIT_KEY, (e) => typeof e.at === 'string' && e.at < cutoff, MAX_AUDIT_SCAN)).map((o) => o.entry);
    summary.audit.removed = old.length;
    // ltrim con índices negativos recorta desde la cola, así no importa que entren entradas
    // nuevas al frente mientras corre.
    if (old.length && !dryRun) {
      if (!(await tailMatches(redis, AUDIT_KEY, old[old.length - 1]?.id))) throw new Error('la cola cambió durante la revisión; se reintenta en la próxima corrida');
      await redis.ltrim(AUDIT_KEY, 0, -(old.length + 1));
    }
  } catch (err) {
    summary.errors.push(`Auditoría: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Novedades: archivar a Blob, recortar la lista, borrar fotos
  try {
    const cutoff = daysAgoIso(RETENTION.reportsArchiveAfterDays);
    const old = (await collectOldTail(redis, REPORTS_KEY, (e) => typeof e.createdAt === 'string' && e.createdAt < cutoff, MAX_REPORTS_PER_RUN + LIST_CHUNK)).map((o) => o.entry);
    const batch = old.slice(0, MAX_REPORTS_PER_RUN);
    summary.reports.moreLeft = old.length > batch.length;
    summary.reports.archived = batch.length;
    const images = batch.flatMap((r) => (Array.isArray(r.images) ? r.images.filter((p: unknown) => typeof p === 'string') : []));
    if (batch.length && !dryRun) {
      if (!token) throw new Error('falta BLOB_READ_WRITE_TOKEN, no se archiva sin respaldo');
      const first = batch[0].createdAt.slice(0, 10);
      const last = batch[batch.length - 1].createdAt.slice(0, 10);
      // Primero el respaldo, después el recorte: si el respaldo falla no se toca la lista.
      const file = await put(`archive/novedades/${first}_a_${last}_${Date.now()}.json`, JSON.stringify(batch), {
        access: 'private',
        token,
        addRandomSuffix: false,
        contentType: 'application/json',
      });
      summary.reports.archiveFile = file.pathname;
      if (!(await tailMatches(redis, REPORTS_KEY, batch[batch.length - 1]?.id))) throw new Error('la lista de novedades cambió durante el respaldo; no se recortó (el archivo queda como copia extra)');
      await redis.ltrim(REPORTS_KEY, 0, -(batch.length + 1));
      await bumpVersion(redis, REPORTS_VERSION_KEY);
      // Las archivadas salieron de la cola: el contador de "ya sin fotos" baja en esa cantidad.
      const purgedCount = Number(await redis.get(REPORTS_PHOTOS_PURGED_COUNT_KEY)) || 0;
      await redis.set(REPORTS_PHOTOS_PURGED_COUNT_KEY, Math.max(0, purgedCount - batch.length));
      summary.reports.imagesDeleted = await deleteBlobs(images, token, summary.errors);
    } else if (dryRun) {
      summary.reports.imagesDeleted = images.length;
    }
  } catch (err) {
    summary.errors.push(`Novedades: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Fotos de novedades: se borran antes que el texto, dejando el registro sin imágenes
  try {
    const cutoff = daysAgoIso(RETENTION.reportsPhotosKeepDays);
    // Si el contador quedara por encima del largo real (borrados manuales), se corrige al largo
    // de la lista para no quedarse ciego revisando índices que no existen.
    const listLength = Number(await redis.llen(REPORTS_KEY)) || 0;
    const alreadyPurged = Math.min(Number(await redis.get(REPORTS_PHOTOS_PURGED_COUNT_KEY)) || 0, listLength);
    const old = await collectOldTail(
      redis,
      REPORTS_KEY,
      (e) => typeof e.createdAt === 'string' && e.createdAt < cutoff,
      MAX_PHOTO_REPORTS_PER_RUN,
      alreadyPurged
    );
    const batch = old.slice(0, MAX_PHOTO_REPORTS_PER_RUN);
    const withPhotos = batch.filter((o) => Array.isArray(o.entry.images) && o.entry.images.length > 0);
    const photos = withPhotos.flatMap((o) => o.entry.images.filter((p: unknown) => typeof p === 'string'));
    summary.reports.reportsWithoutPhotos = batch.length;
    if (dryRun) {
      summary.reports.photosPurged = photos.length;
    } else if (batch.length) {
      if (!token && photos.length) throw new Error('falta BLOB_READ_WRITE_TOKEN para borrar fotos');
      // Primero se limpia la referencia en Redis y luego el archivo: si algo falla a mitad,
      // queda a lo sumo una foto huérfana en Blob, nunca una novedad apuntando a una foto borrada.
      // Antes de cada lset se comprueba que en esa posición siga la misma novedad: si otra
      // corrida recortó la lista en medio, los índices se corren y se pisaría la equivocada.
      const confirmed: typeof withPhotos = [];
      for (let i = 0; i < withPhotos.length; i += 200) {
        const slice = withPhotos.slice(i, i + 200);
        const check = redis.pipeline();
        for (const o of slice) check.lindex(REPORTS_KEY, o.index);
        const current: unknown[] = await check.exec();
        slice.forEach((o, j) => {
          try {
            const parsed = typeof current[j] === 'string' ? JSON.parse(current[j] as string) : current[j];
            if (parsed && (parsed as any).id === o.entry.id) confirmed.push(o);
          } catch {
            // no coincide, se deja para la próxima corrida
          }
        });
      }
      for (let i = 0; i < confirmed.length; i += 200) {
        const pipeline = redis.pipeline();
        for (const o of confirmed.slice(i, i + 200)) {
          pipeline.lset(REPORTS_KEY, o.index, JSON.stringify({ ...o.entry, images: [], photosPurgedAt: new Date().toISOString() }));
        }
        await pipeline.exec();
      }
      const confirmedPhotos = confirmed.flatMap((o) => o.entry.images.filter((p: unknown) => typeof p === 'string'));
      summary.reports.photosPurged = token ? await deleteBlobs(confirmedPhotos, token, summary.errors) : 0;
      if (confirmed.length) await bumpVersion(redis, REPORTS_VERSION_KEY);
      await redis.set(REPORTS_PHOTOS_PURGED_COUNT_KEY, alreadyPurged + batch.length);
    }
  } catch (err) {
    summary.errors.push(`Fotos de novedades: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Notificaciones: tope de 200 por usuario también para quien nunca abre la campanita
  try {
    let cursor: string | number = 0;
    const keys: string[] = [];
    do {
      const [next, batch] = await redis.scan(cursor, { match: NOTIF_KEY_PREFIX + '*', count: 200 });
      cursor = next;
      keys.push(...(batch as string[]));
    } while (String(cursor) !== '0' && keys.length < MAX_NOTIFICATION_USERS);
    for (const key of keys) {
      const userId = key.slice(NOTIF_KEY_PREFIX.length);
      const size = Number(await redis.hlen(key)) || 0;
      if (size <= 200) continue;
      summary.notifications.usersTrimmed += 1;
      summary.notifications.removed += dryRun ? size - 200 : await trimNotifications(redis, userId);
    }
  } catch (err) {
    summary.errors.push(`Notificaciones: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Leads fríos o perdidos: mover al archivo y soltar su conversación
  try {
    const cutoff = daysAgoIso(RETENTION.leadsArchiveAfterDays);
    const leads = await readLeads(redis);
    const old = leads
      .filter((l: Lead) => !l.installed && RETENTION.leadsArchivableStatuses.includes(l.status))
      .filter((l: Lead) => {
        const lastMove = [l.updatedAt, l.lastInboundAt, l.lastOutboundAt, l.createdAt].filter((d): d is string => typeof d === 'string').sort().pop();
        return !!lastMove && lastMove < cutoff;
      })
      .slice(0, MAX_LEADS_PER_RUN);
    summary.leads.archived = old.length;
    summary.leads.conversationsDeleted = old.length;
    if (old.length && !dryRun) {
      const ids = old.map((l) => l.id);
      await redis.hset(LEADS_ARCHIVE_KEY, Object.fromEntries(old.map((l) => [l.id, JSON.stringify(l)])));
      await deleteLeads(redis, ids);
      await redis.hdel(LEAD_CONVERSATIONS_KEY, ...ids);
    }
  } catch (err) {
    summary.errors.push(`Leads: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Tareas cerradas: mover al archivo y borrar la evidencia
  try {
    const cutoff = daysAgoIso(RETENTION.tasksArchiveAfterDays);
    const tasks = await readTasks(redis);
    const old = tasks
      .filter((t: Task) => (t.status === 'Completada' || t.status === 'Cancelada') && (t.completedAt || t.updatedAt || t.createdAt) < cutoff)
      .slice(0, MAX_TASKS_PER_RUN);
    summary.tasks.archived = old.length;
    const proofs = old.map((t) => t.proof?.pathname).filter((p): p is string => typeof p === 'string');
    if (old.length && !dryRun) {
      await redis.hset(TASKS_ARCHIVE_KEY, Object.fromEntries(old.map((t) => [t.id, JSON.stringify(t)])));
      await redis.hdel(TASKS_KEY, ...old.map((t) => t.id));
      summary.tasks.proofsDeleted = token ? await deleteBlobs(proofs, token, summary.errors) : 0;
    } else if (dryRun) {
      summary.tasks.proofsDeleted = proofs.length;
    }
  } catch (err) {
    summary.errors.push(`Tareas: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Sesiones vencidas
  try {
    summary.sessions.removed = await purgeExpiredSessions(redis, dryRun);
  } catch (err) {
    summary.errors.push(`Sesiones: ${err instanceof Error ? err.message : String(err)}`);
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

// ---------------------------------------------------------------- Inventario
export interface RedisGroup {
  group: string;
  type: string;
  keys: number;
  entries: number;
  approxBytes: number;
  sampled: boolean;
}

export interface BlobGroup {
  folder: string;
  files: number;
  bytes: number;
  oldest: string | null;
  newest: string | null;
}

export interface StorageReport {
  generatedAt: string;
  redis: { groups: RedisGroup[]; keysScanned: number; truncated: boolean; totalBytes: number };
  blob: { groups: BlobGroup[]; files: number; bytes: number; truncated: boolean; configured: boolean };
  archives: { pathname: string; size: number; uploadedAt: string }[];
  retention: typeof RETENTION;
}

const MAX_KEYS = 5000;
// Por encima de esto se estima por muestra: un hgetall de un hash grande puede pasar el tope
// de 10 MB por petición de Upstash.
const HASH_FULL_READ_MAX = 1000;
const SAMPLE = 200;
const MAX_BLOB_PAGES = 40;

// Las llaves por usuario/día/conversación se agrupan por familia para que el reporte no
// tenga cientos de filas: "internal:notifications:<id>" -> "internal:notifications:*".
function groupNameFor(key: string): string {
  const parts = key.split(':');
  return parts.length >= 3 ? `${parts[0]}:${parts[1]}:*` : key;
}

function byteLength(value: unknown): number {
  return typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length;
}

async function measureKey(redis: any, key: string): Promise<{ type: string; entries: number; bytes: number; sampled: boolean }> {
  const type: string = await redis.type(key);
  if (type === 'string') {
    const len = await redis.strlen(key);
    return { type, entries: 1, bytes: Number(len) || 0, sampled: false };
  }
  if (type === 'hash') {
    const entries = Number(await redis.hlen(key)) || 0;
    if (entries <= HASH_FULL_READ_MAX) {
      const all = (await redis.hgetall(key)) || {};
      const bytes = Object.entries(all).reduce((acc, [f, v]) => acc + f.length + byteLength(v), 0);
      return { type, entries, bytes, sampled: false };
    }
    const [, flat] = await redis.hscan(key, 0, { count: SAMPLE });
    const pairs = Array.isArray(flat) ? flat : [];
    let sampleBytes = 0;
    for (let i = 0; i + 1 < pairs.length; i += 2) sampleBytes += byteLength(pairs[i]) + byteLength(pairs[i + 1]);
    const sampledEntries = Math.max(1, pairs.length / 2);
    return { type, entries, bytes: Math.round((sampleBytes / sampledEntries) * entries), sampled: true };
  }
  if (type === 'list') {
    const entries = Number(await redis.llen(key)) || 0;
    const sample: unknown[] = (await redis.lrange(key, 0, SAMPLE - 1)) || [];
    const sampleBytes = sample.reduce((acc: number, v) => acc + byteLength(v), 0);
    const avg = sample.length ? sampleBytes / sample.length : 0;
    return { type, entries, bytes: Math.round(avg * entries), sampled: entries > sample.length };
  }
  if (type === 'set') {
    const entries = Number(await redis.scard(key)) || 0;
    return { type, entries, bytes: entries * 48, sampled: true };
  }
  if (type === 'zset') {
    const entries = Number(await redis.zcard(key)) || 0;
    return { type, entries, bytes: entries * 64, sampled: true };
  }
  return { type, entries: 0, bytes: 0, sampled: true };
}

export async function computeStorageReport(redis: any): Promise<StorageReport> {
  // ---- Redis
  const keys: string[] = [];
  let cursor: string | number = 0;
  let truncated = false;
  do {
    const [next, batch] = await redis.scan(cursor, { match: 'internal:*', count: 500 });
    cursor = next;
    keys.push(...(batch as string[]));
    if (keys.length >= MAX_KEYS) {
      truncated = true;
      break;
    }
  } while (String(cursor) !== '0');

  const groups = new Map<string, RedisGroup>();
  const BATCH = 20;
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const measured = await Promise.all(slice.map((k) => measureKey(redis, k).catch(() => ({ type: '?', entries: 0, bytes: 0, sampled: true }))));
    slice.forEach((k, idx) => {
      const name = groupNameFor(k);
      const m = measured[idx];
      const g = groups.get(name) || { group: name, type: m.type, keys: 0, entries: 0, approxBytes: 0, sampled: false };
      g.keys += 1;
      g.entries += m.entries;
      g.approxBytes += m.bytes;
      g.sampled = g.sampled || m.sampled;
      groups.set(name, g);
    });
  }
  const redisGroups = [...groups.values()].sort((a, b) => b.approxBytes - a.approxBytes);

  // ---- Blob
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  const blobGroups = new Map<string, BlobGroup>();
  const archives: StorageReport['archives'] = [];
  let blobFiles = 0;
  let blobBytes = 0;
  let blobTruncated = false;
  if (token) {
    let blobCursor: string | undefined;
    for (let page = 0; page < MAX_BLOB_PAGES; page++) {
      const res = await list({ token, limit: 1000, cursor: blobCursor });
      for (const b of res.blobs) {
        const folder = b.pathname.includes('/') ? b.pathname.slice(0, b.pathname.indexOf('/')) : '(raíz)';
        const uploaded = new Date(b.uploadedAt).toISOString();
        const g = blobGroups.get(folder) || { folder, files: 0, bytes: 0, oldest: null, newest: null };
        g.files += 1;
        g.bytes += b.size;
        if (!g.oldest || uploaded < g.oldest) g.oldest = uploaded;
        if (!g.newest || uploaded > g.newest) g.newest = uploaded;
        blobGroups.set(folder, g);
        blobFiles += 1;
        blobBytes += b.size;
        if (b.pathname.startsWith('archive/')) archives.push({ pathname: b.pathname, size: b.size, uploadedAt: uploaded });
      }
      if (!res.hasMore) break;
      blobCursor = res.cursor;
      if (page === MAX_BLOB_PAGES - 1) blobTruncated = true;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    redis: {
      groups: redisGroups,
      keysScanned: keys.length,
      truncated,
      totalBytes: redisGroups.reduce((acc, g) => acc + g.approxBytes, 0),
    },
    blob: {
      groups: [...blobGroups.values()].sort((a, b) => b.bytes - a.bytes),
      files: blobFiles,
      bytes: blobBytes,
      truncated: blobTruncated,
      configured: !!token,
    },
    archives: archives.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
    retention: RETENTION,
  };
}

export function describeCleanup(s: CleanupSummary): string {
  const parts = [
    `${s.audit.removed} entradas de auditoría`,
    `${s.reports.photosPurged} fotos de novedades`,
    `${s.reports.archived} novedades archivadas`,
    `${s.leads.archived} leads archivados`,
    `${s.tasks.archived} tareas archivadas (${s.tasks.proofsDeleted} evidencias)`,
    `${s.notifications.removed} notificaciones viejas`,
    `${s.sessions.removed} sesiones vencidas`,
  ];
  const head = s.dryRun ? `Simulación de limpieza (${todayInColombia()})` : `Limpieza automática (${todayInColombia()})`;
  return `${head}: ${parts.join(' · ')}${s.errors.length ? ` · ${s.errors.length} error(es)` : ''}`;
}
