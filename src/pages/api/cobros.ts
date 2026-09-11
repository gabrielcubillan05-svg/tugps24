import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessCobros, canUploadCobros, findUserById, verifySameOrigin } from '../../lib/auth';
import { sendWhatsappTemplate, isQuietHoursColombia } from '../../lib/whatsapp';
import { normalizePhone } from './leads';

export const prerender = false;

export const REDIS_KEY = 'internal:cobros';
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

const REMINDER_TEMPLATE_NAME = 'recordatorio_pago';
const REMINDER_TEMPLATE_LANGUAGE = 'es_CO'; // la plantilla quedó aprobada como "Spanish (COL)", no "es" genérico

// Mismo historial que lee/escribe whatsapp-webhook.ts (duplicado a propósito, como el resto
// de helpers de los agentes) — para que el envío del recordatorio quede visible en el visor
// de conversaciones aunque el cliente todavía no haya respondido nada.
const COBRO_CONVERSATIONS_KEY = 'internal:cobro-whatsapp-conversations';
const MAX_HISTORY = 60;

async function logCobroReminderSent(redis: any, cobroId: string, nombre: string, deuda: number): Promise<void> {
  const firstName = nombre.trim().split(/\s+/)[0] || nombre;
  const monto = '$' + Math.round(deuda).toLocaleString('es-CO');
  const entry = { role: 'assistant', at: new Date().toISOString(), content: `[Plantilla ${REMINDER_TEMPLATE_NAME}] Hola ${firstName}, tienes un saldo pendiente de ${monto} por el servicio de monitoreo GPS. Escríbenos si quieres resolverlo o tienes alguna duda.` };
  const raw = await redis.hget<string>(COBRO_CONVERSATIONS_KEY, cobroId);
  let current: unknown[] = [];
  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) current = parsed;
    } catch {
      // ignora historial corrupto, empieza de nuevo
    }
  }
  const updated = [...current, entry].slice(-MAX_HISTORY);
  await redis.hset(COBRO_CONVERSATIONS_KEY, { [cobroId]: JSON.stringify(updated) });
}

// Tamaño de cada tanda de recordatorios masivos — tanto el botón manual como el cron
// whatsapp-cobros-bulk-cron.ts usan este mismo tope, para que nunca salga un lote más grande.
export const BULK_REMINDER_BATCH_SIZE = 100;

export interface BulkReminderResult {
  sent: number;
  failed: number;
  remaining: number;
  totalPending: number;
}

// Envía UNA tanda de la plantilla de recordatorio a los cobros pendientes (sin plantilla enviada
// aún). La reparte en tandas quien la llama: el botón manual (una tanda por click) y el cron
// automático (una tanda cada media hora, solo entre 8am y 6pm).
export async function sendReminderBatch(redis: any, batchSize: number): Promise<BulkReminderResult> {
  const allCobros = await readCobros(redis);
  const pending = allCobros.filter((c) => !c.templateSentAt && normalizePhone(c.telefono).length >= 10);
  const batch = pending.slice(0, batchSize);
  let sent = 0;
  let failed = 0;

  for (const cobro of batch) {
    const phone = normalizePhone(cobro.telefono);
    const result = await sendWhatsappTemplate(phone, REMINDER_TEMPLATE_NAME, REMINDER_TEMPLATE_LANGUAGE, [
      cobro.nombre.trim().split(/\s+/)[0] || cobro.nombre,
      '$' + Math.round(cobro.deuda).toLocaleString('es-CO'),
    ]);
    if (result.ok) {
      cobro.templateSentAt = new Date().toISOString();
      cobro.aiStage = 'en_conversacion';
      cobro.updatedAt = cobro.templateSentAt;
      await redis.hset(REDIS_KEY, { [cobro.id]: JSON.stringify(cobro) });
      await logCobroReminderSent(redis, cobro.id, cobro.nombre, cobro.deuda);
      sent++;
    } else {
      failed++;
    }
  }

  return { sent, failed, remaining: pending.length - batch.length, totalPending: pending.length };
}

export interface Cobro {
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
  // --- Agente IA de cobranza por WhatsApp (opcional) ---
  aiStage?: 'sin_iniciar' | 'en_conversacion' | 'acuerdo' | 'escalado';
  templateSentAt?: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  paymentImageSentAt?: string | null;
  // Cuando el cliente pide instalar un vehículo nuevo, Valentina lo deriva a ventas y
  // Andrés toma la conversación de ahí en adelante (no vuelve a Valentina automáticamente).
  derivedToSales?: boolean;
}

export interface AgentStats {
  total: number;
  templateSent: number;
  sinIniciar: number;
  enConversacion: number;
  acuerdo: number;
  escalado: number;
  deudaTotal: number;
  deudaEnAcuerdo: number;
}

// Ya no se reparte entre trabajadores — la agente IA (Valentina) gestiona la cobranza
// primero, así que las estadísticas que importan son por etapa de esa conversación.
export function computeAgentStats(cobros: Cobro[]): AgentStats {
  const stats: AgentStats = {
    total: cobros.length,
    templateSent: 0,
    sinIniciar: 0,
    enConversacion: 0,
    acuerdo: 0,
    escalado: 0,
    deudaTotal: 0,
    deudaEnAcuerdo: 0,
  };
  for (const c of cobros) {
    if (c.templateSentAt) stats.templateSent++;
    stats.deudaTotal += c.deuda || 0;
    switch (c.aiStage) {
      case 'en_conversacion':
        stats.enConversacion++;
        break;
      case 'acuerdo':
        stats.acuerdo++;
        stats.deudaEnAcuerdo += c.deuda || 0;
        break;
      case 'escalado':
        stats.escalado++;
        break;
      default:
        stats.sinIniciar++;
    }
  }
  return stats;
}

async function requireCobros(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessCobros(session)) return null;
  return session;
}

function normalizeNameForMatch(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

// Para usuarios con acceso puntual (username no coincide con el nombre usado al
// repartir, ej. "chrisinstalador" en vez de "Cristofer"), se fija a mano el nombre
// de reparto que le corresponde.
const USERNAME_ASSIGNEE_OVERRIDE: Record<string, string> = {
  alonsopadilla: 'Alonso',
  chrisinstalador: 'Cristofer',
};

// Compara por el primer nombre, igual que el reparto (ej. "Yelitza Redondo" vs "Yelitza").
function isAssignedToUser(assignedTo: string, userName: string): boolean {
  const a = normalizeNameForMatch(assignedTo);
  const u = normalizeNameForMatch(userName).split(/\s+/)[0];
  return !!a && a === u;
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

export async function readCobros(redis: any): Promise<Cobro[]> {
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
    .map((c) => ({ aiStage: 'sin_iniciar', templateSentAt: null, lastInboundAt: null, lastOutboundAt: null, paymentImageSentAt: null, derivedToSales: false, ...c }))
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
  const allCobros = await readCobros(redis);
  const agentStats = computeAgentStats(allCobros);

  // Quien no puede subir listas (secretaria normal) solo ve lo que le toca a ella —
  // no puede cambiarlo desde el navegador, el servidor ya no le manda lo demás.
  let cobros = allCobros;
  if (!canUploadCobros(session)) {
    const user = await findUserById(redis, session.userId);
    const userName = USERNAME_ASSIGNEE_OVERRIDE[session.username] || user?.name || session.username;
    cobros = allCobros.filter((c) => isAssignedToUser(c.assignedTo, userName));
  }

  return new Response(JSON.stringify({ cobros, agentStats }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessCobros(session) || !canUploadCobros(session)) {
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

  // Algunos reportes (ej. exportados directo del software de rastreo) traen una fila de
  // título y una fila en blanco antes del encabezado real — se busca la fila que
  // realmente tiene "Nombre" en vez de asumir que es la primera.
  const headerRowIndex = (() => {
    const maxScan = Math.min(rows.length, 15);
    for (let i = 0; i < maxScan; i++) {
      if (rows[i].map(normalizeHeader).includes('nombre')) return i;
    }
    return 0;
  })();

  const header = rows[headerRowIndex].map(normalizeHeader);
  const nombreCol = header.indexOf('nombre');
  const numeroCol = header.findIndex((h) => h === 'numero' || h === 'número');
  const sucursalCol = header.indexOf('sucursal');
  const telefonoCol = header.findIndex((h) => h === 'telefono' || h === 'teléfono');
  const deudaCol = header.findIndex((h) => h.includes('deuda'));
  const impagasCol = header.findIndex((h) => h.includes('impagas'));
  const ultPagoCol = header.findIndex((h) => h.includes('pago'));

  // Ya no se reparte automáticamente entre trabajadores: el agente de cobranza por WhatsApp
  // se encarga primero. Solo queda asignado a alguien si se escribe explícitamente aquí.
  const assigneesRaw = String(form.get('assignees') || '').trim();
  const assignees = assigneesRaw ? assigneesRaw.split(/[\n,]/).map((n) => n.trim()).filter(Boolean) : [];

  if (nombreCol < 0 || deudaCol < 0) {
    return new Response(
      JSON.stringify({ error: 'no se encontraron las columnas "Nombre" y "Deuda" en el archivo' }),
      { status: 400 }
    );
  }

  const existingCobros = await readCobros(redis);
  const existingByNumero = new Map(existingCobros.filter((c) => c.numero).map((c) => [c.numero, c] as const));

  const now = new Date().toISOString();
  const changedCobros: Record<string, string> = {};
  let count = 0;
  let updated = 0;
  let skippedNoPhone = 0;

  for (const row of rows.slice(headerRowIndex + 1)) {
    if (!row.length || row.every((c) => c === '')) continue;
    const nombre = String(row[nombreCol] ?? '').trim();
    const deuda = Number(row[deudaCol]) || 0;
    if (!nombre) continue;
    const numero = numeroCol >= 0 ? String(row[numeroCol] ?? '') : '';
    const telefonoRaw = telefonoCol >= 0 ? String(row[telefonoCol] ?? '').trim() : '';
    const telefono = telefonoRaw ? normalizePhone(telefonoRaw) : '';
    const sucursal = sucursalCol >= 0 ? String(row[sucursalCol] ?? '').trim() : '';
    const facturasImpagas = impagasCol >= 0 ? Number(row[impagasCol]) || 0 : 0;
    const fechaUltimoPago = ultPagoCol >= 0 ? excelSerialToISO(Number(row[ultPagoCol])) : null;

    // Reportes recurrentes del mismo cliente (mismo "Número") solo traen el saldo
    // actualizado, sin teléfono — se actualiza el registro ya cargado en vez de omitirlo.
    const existing = numero ? existingByNumero.get(numero) : undefined;
    if (existing) {
      existing.deuda = deuda;
      if (facturasImpagas) existing.facturasImpagas = facturasImpagas;
      if (fechaUltimoPago) existing.fechaUltimoPago = fechaUltimoPago;
      if (sucursal) existing.sucursal = sucursal;
      if (telefono) existing.telefono = telefono;
      existing.updatedAt = now;
      changedCobros[existing.id] = JSON.stringify(existing);
      updated++;
      continue;
    }

    if (!telefono) {
      skippedNoPhone++;
      continue;
    }

    const cobro: Cobro = {
      id: randomUUID(),
      nombre,
      numero,
      sucursal,
      facturasImpagas,
      fechaUltimoPago,
      deuda,
      telefono,
      assignedTo: assignees.length ? assignees[count % assignees.length] : '',
      contacted: false,
      contactedAt: null,
      contactedByName: '',
      createdAt: now,
      updatedAt: now,
      aiStage: 'sin_iniciar',
      templateSentAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    };
    if (numero) existingByNumero.set(numero, cobro);
    changedCobros[cobro.id] = JSON.stringify(cobro);
    count++;
  }

  if (!count && !updated) {
    return new Response(
      JSON.stringify({
        error: skippedNoPhone
          ? `no se encontraron filas nuevas para agregar (${skippedNoPhone} sin teléfono y sin un registro previo que lo tenga)`
          : 'no se encontraron filas válidas (nombre y deuda)',
      }),
      { status: 400 }
    );
  }

  // Se agrega/actualiza sobre la lista existente sin borrar nada — para eso está el botón
  // "Borrar todo" aparte.
  await redis.hset(REDIS_KEY, changedCobros);

  await logAudit(
    redis,
    session,
    'cobros_upload',
    file.name,
    `${count} cobros agregados, ${updated} actualizados, ${skippedNoPhone} omitidos sin teléfono`
  );

  return new Response(JSON.stringify({ count, updated, skippedNoPhone }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const existingIds = Object.keys((await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {});
  if (existingIds.length) {
    await redis.hdel(REDIS_KEY, ...existingIds);
  }

  await logAudit(redis, session, 'cobros_delete_all', `${existingIds.length} cobros`);

  return new Response(JSON.stringify({ deleted: existingIds.length }), {
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

  let body: { id?: string; contacted?: boolean; action?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  // Quita la asignación a trabajador de TODOS los cobros — quedan "Sin asignar" para que
  // los gestione primero la agente IA (Valentina), sin importar cómo se hayan repartido antes.
  if (body.action === 'clearAllAssignments') {
    if (session.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'no autorizado' }), { status: 403 });
    }
    const allCobros = await readCobros(redis);
    const toClear = allCobros.filter((c) => c.assignedTo);
    const changed: Record<string, string> = {};
    for (const cobro of toClear) {
      cobro.assignedTo = '';
      cobro.updatedAt = new Date().toISOString();
      changed[cobro.id] = JSON.stringify(cobro);
    }
    if (Object.keys(changed).length) {
      await redis.hset(REDIS_KEY, changed);
    }
    await logAudit(redis, session, 'cobros_clear_assignments', `${toClear.length} cobros`);
    return new Response(JSON.stringify({ cleared: toClear.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Envía UNA tanda (100) de la plantilla a los cobros pendientes — ya no hace todo de una vez:
  // el resto de las tandas las sigue mandando solo whatsapp-cobros-bulk-cron.ts, repartidas
  // cada media hora entre 8am y 6pm, para que un archivo grande (miles de registros) no se
  // vea como spam al salir todo de golpe.
  if (body.action === 'sendWhatsappReminderAll') {
    if (!canUploadCobros(session)) {
      return new Response(JSON.stringify({ error: 'no autorizado' }), { status: 403 });
    }
    if (isQuietHoursColombia()) {
      return new Response(
        JSON.stringify({ error: 'No se pueden enviar recordatorios entre 11pm y 6am (hora Colombia). Intenta de nuevo después de las 6am.' }),
        { status: 400 }
      );
    }
    const result = await sendReminderBatch(redis, BULK_REMINDER_BATCH_SIZE);
    await logAudit(redis, session, 'cobros_whatsapp_reminder_bulk', `${result.sent} enviados`, result.failed ? `${result.failed} fallidos` : '');
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  const id = String(body.id || '');
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const cobro: Cobro = { aiStage: 'sin_iniciar', templateSentAt: null, lastInboundAt: null, lastOutboundAt: null, paymentImageSentAt: null, derivedToSales: false, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };

  const user = await findUserById(redis, session.userId);
  const userName = USERNAME_ASSIGNEE_OVERRIDE[session.username] || user?.name || session.username;

  // Quien no puede subir listas (secretaria normal) solo puede marcar sus propios
  // cobros — el filtro del navegador es solo comodidad, esto es lo que realmente lo impide.
  if (!canUploadCobros(session) && !isAssignedToUser(cobro.assignedTo, userName)) {
    return new Response(JSON.stringify({ error: 'este cobro no está asignado a ti' }), { status: 403 });
  }

  if (body.action === 'sendWhatsappReminder') {
    if (!canUploadCobros(session)) {
      return new Response(JSON.stringify({ error: 'no autorizado' }), { status: 403 });
    }
    if (isQuietHoursColombia()) {
      return new Response(
        JSON.stringify({ error: 'No se pueden enviar recordatorios entre 11pm y 6am (hora Colombia). Intenta de nuevo después de las 6am.' }),
        { status: 400 }
      );
    }
    const phone = normalizePhone(cobro.telefono);
    if (!phone) {
      return new Response(JSON.stringify({ error: 'el teléfono de este cobro no es válido' }), { status: 400 });
    }
    const result = await sendWhatsappTemplate(phone, REMINDER_TEMPLATE_NAME, REMINDER_TEMPLATE_LANGUAGE, [
      cobro.nombre.trim().split(/\s+/)[0] || cobro.nombre,
      '$' + Math.round(cobro.deuda).toLocaleString('es-CO'),
    ]);
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error || 'no se pudo enviar el recordatorio' }), { status: 502 });
    }
    cobro.templateSentAt = new Date().toISOString();
    cobro.aiStage = 'en_conversacion';
    cobro.updatedAt = cobro.templateSentAt;
    await redis.hset(REDIS_KEY, { [id]: JSON.stringify(cobro) });
    await logCobroReminderSent(redis, cobro.id, cobro.nombre, cobro.deuda);
    await logAudit(redis, session, 'cobro_whatsapp_reminder', cobro.nombre, cobro.telefono);
    return new Response(JSON.stringify({ cobro }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.contacted !== undefined) {
    cobro.contacted = Boolean(body.contacted);
    if (cobro.contacted) {
      cobro.contactedAt = new Date().toISOString();
      cobro.contactedByName = userName;
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
