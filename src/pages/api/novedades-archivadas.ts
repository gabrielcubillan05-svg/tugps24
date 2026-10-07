import type { APIRoute } from 'astro';
import { get, list } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canAccessSection } from '../../lib/auth';
import { isSafeBlobPath, blobTimeout } from '../../lib/blob-path';
import { checkAndIncrementRateLimit } from '../../lib/rate-limit';
import { REDIS_KEY as REPORTS_KEY, SEARCH_MAX_SCAN_CEILING, type Report } from './reports';

export const prerender = false;

// Novedades que la pantalla principal ya no alcanza: las que quedan por detrás del tope de
// búsqueda (las 30.000 más recientes) dentro de la lista, y los archivos anuales que la
// limpieza va dejando en Blob. Es consulta de historial, no de operación diaria: se lee por
// páginas y las búsquedas recorren todo pero con tope de resultados.
const PAGE_SIZE = 200;
const SEARCH_CHUNK = 1000;
const MAX_RESULTS = 500;
const ARCHIVE_PREFIX = 'archive/novedades/';
// Blob puede tardar: ninguna de estas llamadas debe dejar la página en "Cargando..." sin fin.
const BLOB_LIST_TIMEOUT_MS = 10_000;
const SEARCH_BUDGET_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: sin respuesta en ${Math.round(ms / 1000)} s`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

type Source = { kind: 'lista'; offset: number } | { kind: 'archivo'; file: string };
type ArchivedReport = Report & { source: Source };

function parseReports(raw: unknown[]): Report[] {
  return raw
    .map((r) => {
      try {
        return typeof r === 'string' ? JSON.parse(r) : r;
      } catch {
        return null;
      }
    })
    .filter((r): r is Report => !!r && typeof r === 'object')
    .map((r) => ({ images: [], createdByName: '', createdById: '', ...r }));
}

function matches(r: Report, q: string, branch: string): boolean {
  if (branch && r.branch !== branch) return false;
  if (!q) return true;
  return (
    String(r.plate || '').toLowerCase().includes(q) ||
    String(r.note || '').toLowerCase().includes(q) ||
    String(r.branch || '').toLowerCase().includes(q) ||
    String(r.createdByName || '').toLowerCase().includes(q)
  );
}

async function listArchives(token: string) {
  const archives: { pathname: string; size: number; uploadedAt: string; label: string }[] = [];
  let cursor: string | undefined;
  do {
    const res = await list({ token, prefix: ARCHIVE_PREFIX, limit: 1000, cursor, abortSignal: blobTimeout(BLOB_LIST_TIMEOUT_MS) });
    for (const b of res.blobs) {
      const name = b.pathname.slice(ARCHIVE_PREFIX.length);
      // "2025-01-03_a_2025-02-10_1712345678.json" → "3 ene 2025 a 10 feb 2025"
      const m = name.match(/^(\d{4}-\d{2}-\d{2})_a_(\d{4}-\d{2}-\d{2})/);
      archives.push({ pathname: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt).toISOString(), label: m ? `${m[1]} a ${m[2]}` : name });
    }
    cursor = res.hasMore ? res.cursor : undefined;
  } while (cursor);
  // Lo más reciente primero.
  archives.sort((a, b) => b.label.localeCompare(a.label));
  return archives;
}

async function readArchive(token: string, pathname: string): Promise<Report[]> {
  const result = await get(pathname, { access: 'private', token, abortSignal: blobTimeout(BLOB_LIST_TIMEOUT_MS * 2) });
  if (!result || result.statusCode !== 200 || !result.stream) return [];
  const text = await new Response(result.stream).text();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parseReports(parsed) : [];
  } catch {
    return [];
  }
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'novedades-archivadas')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const token = import.meta.env.BLOB_READ_WRITE_TOKEN as string | undefined;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const branch = url.searchParams.get('branch') || '';
  const source = url.searchParams.get('source') || '';
  const total = Number(await redis.llen(REPORTS_KEY)) || 0;
  const beyond = Math.max(0, total - SEARCH_MAX_SCAN_CEILING);

  // Resumen para la cabecera de la página: solo Redis, para que salga al instante.
  if ((!source && !q) || source === 'resumen') {
    return new Response(JSON.stringify({ total, searchable: SEARCH_MAX_SCAN_CEILING, beyond, pageSize: PAGE_SIZE, blobConfigured: !!token }), { headers });
  }

  // Lista de archivos anuales, aparte y con tiempo límite.
  if (source === 'archivos') {
    if (!token) return new Response(JSON.stringify({ archives: [], blobConfigured: false }), { headers });
    try {
      const archives = await withTimeout(listArchives(token), BLOB_LIST_TIMEOUT_MS, 'listar archivos');
      return new Response(JSON.stringify({ archives, blobConfigured: true }), { headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 504, headers });
    }
  }

  // Una página de la cola de la lista principal (lo que está detrás del tope de búsqueda).
  if (source === 'lista') {
    const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0);
    const start = SEARCH_MAX_SCAN_CEILING + page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, total) - 1;
    const raw = end >= start ? (await redis.lrange<string>(REPORTS_KEY, start, end)) || [] : [];
    const items: ArchivedReport[] = parseReports(raw)
      .filter((r) => matches(r, q, branch))
      .map((r, i) => ({ ...r, source: { kind: 'lista', offset: start + i } }));
    return new Response(JSON.stringify({ items, page, pageSize: PAGE_SIZE, beyond, hasMore: end + 1 < total }), { headers });
  }

  // El contenido de un archivo anual.
  if (source === 'archivo') {
    const file = url.searchParams.get('file') || '';
    if (!token) return new Response(JSON.stringify({ error: 'almacenamiento no configurado' }), { status: 503 });
    if (!file.startsWith(ARCHIVE_PREFIX) || !isSafeBlobPath(file)) {
      return new Response(JSON.stringify({ error: 'archivo inválido' }), { status: 400 });
    }
    try {
      const reports = await withTimeout(readArchive(token, file), BLOB_LIST_TIMEOUT_MS * 2, 'leer el archivo');
      const items: ArchivedReport[] = reports.filter((r) => matches(r, q, branch)).map((r) => ({ ...r, source: { kind: 'archivo', file } }));
      return new Response(JSON.stringify({ items, file }), { headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 504, headers });
    }
  }

  // Búsqueda en todo lo archivado: cola de la lista por bloques y todos los archivos de Blob.
  if (q.length < 3) {
    return new Response(JSON.stringify({ error: 'escribe al menos tres letras o números' }), { status: 400 });
  }
  // Cada búsqueda global recorre decenas de miles de novedades y todos los archivos de Blob:
  // un usuario no necesita más de unas pocas cada diez minutos.
  if (!(await checkAndIncrementRateLimit(redis, `internal:novedades-archivadas-rate:${session.userId}`, 10, 600))) {
    return new Response(JSON.stringify({ error: 'demasiadas búsquedas seguidas; espera unos minutos' }), { status: 429, headers });
  }
  const results: ArchivedReport[] = [];
  const offsets: number[] = [];
  for (let offset = SEARCH_MAX_SCAN_CEILING; offset < total; offset += SEARCH_CHUNK) offsets.push(offset);
  for (let i = 0; i < offsets.length && results.length < MAX_RESULTS; i += 8) {
    const parts = await Promise.all(offsets.slice(i, i + 8).map((offset) => redis.lrange<string>(REPORTS_KEY, offset, Math.min(offset + SEARCH_CHUNK, total) - 1)));
    parts.forEach((part, j) => {
      const base = offsets[i + j];
      parseReports(part || []).forEach((r, k) => {
        if (matches(r, q, branch)) results.push({ ...r, source: { kind: 'lista', offset: base + k } });
      });
    });
  }
  let archivesSearched = 0;
  let archivesPending = 0;
  let archivesError = '';
  if (token) {
    const startedAt = Date.now();
    let archives: Awaited<ReturnType<typeof listArchives>> = [];
    try {
      archives = await withTimeout(listArchives(token), BLOB_LIST_TIMEOUT_MS, 'listar archivos');
    } catch (err) {
      archivesError = err instanceof Error ? err.message : String(err);
    }
    for (let i = 0; i < archives.length && results.length < MAX_RESULTS; i += 4) {
      // Lo que no alcance en el presupuesto de tiempo se informa como pendiente, en vez de
      // dejar al usuario esperando sin respuesta.
      if (Date.now() - startedAt > SEARCH_BUDGET_MS) {
        archivesPending = archives.length - i;
        break;
      }
      const batch = archives.slice(i, i + 4);
      const contents = await Promise.all(batch.map((a) => withTimeout(readArchive(token, a.pathname), BLOB_LIST_TIMEOUT_MS, 'leer archivo').catch(() => null)));
      contents.forEach((reports, j) => {
        if (!reports) { archivesPending++; return; }
        archivesSearched++;
        reports.forEach((r) => {
          if (matches(r, q, branch)) results.push({ ...r, source: { kind: 'archivo', file: batch[j].pathname } });
        });
      });
    }
  }
  results.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return new Response(JSON.stringify({ items: results.slice(0, MAX_RESULTS), truncated: results.length > MAX_RESULTS, scannedList: beyond, archivesSearched, archivesPending, archivesError }), { headers });
};
