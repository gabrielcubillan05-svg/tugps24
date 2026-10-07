import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import { getUsers, findUserByUsername, JOSUE_USERNAME, branchesOf } from '../../lib/auth';
import { sendWhatsappText, sendWhatsappMedia, verifyMetaSignature } from '../../lib/whatsapp';
import { transcribeWhatsappAudio } from '../../lib/transcribe';
import { runSalesAgent, type AgentMessage } from '../../lib/sales-agent';
import { runCollectionsAgent } from '../../lib/collections-agent';
import { readLeads, writeLeads, normalizeLead, normalizePhone, mergeLeadIntoCurrent, REDIS_KEY as LEADS_KEY, type Lead } from './leads';
import { runAfterResponse } from '../../lib/background';
import { checkAndIncrementRateLimit } from '../../lib/rate-limit';
import { readCobros, normalizeCobro, writeCobros, REDIS_KEY as COBROS_KEY, type Cobro } from './cobros';
import { reportIncident } from '../../lib/incidents';
import { readAgentMedia } from './whatsapp-agent-media';
import { getExtraInstructions, recordAgentUsage } from '../../lib/agent-usage';
import { sendGabotMessage } from '../../lib/gabot';

export const prerender = false;

export const CONVERSATIONS_KEY = 'internal:lead-whatsapp-conversations';
const COBRO_CONVERSATIONS_KEY = 'internal:cobro-whatsapp-conversations';
// Texto de respaldo cuando el agente no generó una respuesta real (ej. falló la llamada a
// Anthropic) — se exporta para que whatsapp-retry-today.ts pueda detectar a quién de verdad
// nunca le llegó una respuesta sustancial, y no solo mirar quién tiene un mensaje más reciente.
export const GENERIC_FALLBACK_TEXT = 'Gracias por tu mensaje, dame un momento.';
const MAX_HISTORY = 60;
const WHATSAPP_ACTOR = { userId: 'whatsapp-agent', username: 'Agente IA (Andrés)' };
const COLLECTIONS_ACTOR = { userId: 'whatsapp-collections-agent', username: 'Agente IA (Valentina)' };

// Traduce la ciudad que confirma el cliente a la clave de material configurada en
// /interno/whatsapp-agent-media para esa sucursal.
const BRANCH_MEDIA_KEY: Record<string, string> = {
  Riohacha: 'sucursal_riohacha',
  Valledupar: 'sucursal_valledupar',
  'Santa Marta': 'sucursal_santamarta',
  Maicao: 'sucursal_maicao',
  Atlántico: 'sucursal_atlantico',
  Bucaramanga: 'sucursal_bucaramanga',
  Medellín: 'sucursal_medellin',
  Montería: 'sucursal_monteria',
};

// Meta llama a este GET una sola vez para verificar que el webhook es tuyo. Reusa el mismo
// verify_token ya configurado para el webhook de Meta Lead Ads (son dos suscripciones
// distintas del mismo App de Meta, pueden compartir el mismo valor).
export const GET: APIRoute = async ({ url }) => {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = import.meta.env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('forbidden', { status: 403 });
};

export async function readHistory(redis: any, leadId: string): Promise<AgentMessage[]> {
  const raw = await redis.hget<string>(CONVERSATIONS_KEY, leadId);
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Los acuses de Meta ("[Estado WhatsApp] read/failed") se guardan en el historial para
// diagnóstico, pero no son mensajes: no se le muestran al modelo como si fueran suyos, no
// cuentan para la ventana de contexto y no cuentan como "ya le contestamos".
export const STATUS_NOTE_PREFIX = '[Estado WhatsApp]';
export function isStatusNote(m: AgentMessage): boolean {
  return m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith(STATUS_NOTE_PREFIX);
}
export function conversationOnly(history: AgentMessage[]): AgentMessage[] {
  return history.filter((m) => !isStatusNote(m));
}

function trimHistory(entries: AgentMessage[]): AgentMessage[] {
  // La ventana se mide en mensajes reales; los acuses viajan con ellos pero no la consumen.
  let real = 0;
  const kept: AgentMessage[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i];
    if (!isStatusNote(m)) {
      if (real >= MAX_HISTORY) break;
      real++;
    }
    kept.push(m);
  }
  return kept.reverse();
}

export async function appendHistory(redis: any, leadId: string, entries: AgentMessage[]): Promise<void> {
  const current = await readHistory(redis, leadId);
  const stamped = entries.map((e) => ({ at: new Date().toISOString(), ...e }));
  const updated = trimHistory([...current, ...stamped]);
  await redis.hset(CONVERSATIONS_KEY, { [leadId]: JSON.stringify(updated) });
}

export async function readCobroHistory(redis: any, cobroId: string): Promise<AgentMessage[]> {
  const raw = await redis.hget<string>(COBRO_CONVERSATIONS_KEY, cobroId);
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendCobroHistory(redis: any, cobroId: string, entries: AgentMessage[]): Promise<void> {
  const current = await readCobroHistory(redis, cobroId);
  const stamped = entries.map((e) => ({ at: new Date().toISOString(), ...e }));
  const updated = trimHistory([...current, ...stamped]);
  await redis.hset(COBRO_CONVERSATIONS_KEY, { [cobroId]: JSON.stringify(updated) });
}

// Índice teléfono → lead/cobro para los acuses de entrega de Meta. Antes cada acuse (y llegan
// dos o tres por cada mensaje enviado) leía completos los hashes de leads y cobros: en la
// cobranza masiva de cada hora eran cientos de lecturas de varios MB en un minuto, y eso
// dejaba lento todo el panel justo a la hora en punto. El índice se reconstruye como máximo
// una vez cada dos minutos cuando aparece un número que no está; si está en espera, el acuse
// simplemente no se registra (es información de diagnóstico, no un mensaje).
const PHONE_INDEX_KEY = 'internal:whatsapp-phone-index';
const PHONE_INDEX_REBUILD_LOCK = 'internal:whatsapp-phone-index:rebuilt';
const PHONE_INDEX_REBUILD_SECONDS = 120;

type PhoneTarget = { kind: 'lead' | 'cobro'; id: string };

function parsePhoneTarget(raw: unknown): PhoneTarget | null {
  const [kind, id] = String(raw || '').split(':');
  return (kind === 'lead' || kind === 'cobro') && id ? { kind, id } : null;
}

export async function indexPhoneTarget(redis: any, phone: string, target: PhoneTarget): Promise<void> {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  await redis.hset(PHONE_INDEX_KEY, { [normalized]: `${target.kind}:${target.id}` });
}

async function rebuildPhoneIndex(redis: any): Promise<Record<string, string>> {
  const [allCobros, allLeads] = await Promise.all([readCobros(redis), readLeads(redis)]);
  const index: Record<string, string> = {};
  // Los leads van primero y los cobros encima: si un número está en ambos, gana cobranza,
  // igual que antes.
  for (const l of allLeads) {
    const phone = normalizePhone(l.phone);
    if (phone) index[phone] = `lead:${l.id}`;
  }
  for (const c of allCobros) {
    const phone = normalizePhone(c.telefono);
    if (phone) index[phone] = `cobro:${c.id}`;
  }
  const entries = Object.entries(index);
  for (let i = 0; i < entries.length; i += 500) await redis.hset(PHONE_INDEX_KEY, Object.fromEntries(entries.slice(i, i + 500)));
  return index;
}

async function resolvePhoneTarget(redis: any, phone: string): Promise<PhoneTarget | null> {
  const cached = parsePhoneTarget(await redis.hget(PHONE_INDEX_KEY, phone));
  if (cached) return cached;
  const canRebuild = await redis.set(PHONE_INDEX_REBUILD_LOCK, '1', { nx: true, ex: PHONE_INDEX_REBUILD_SECONDS });
  if (!canRebuild) return null;
  const index = await rebuildPhoneIndex(redis);
  return parsePhoneTarget(index[phone]);
}

// Búsqueda por teléfono para los mensajes entrantes: con el índice resuelve el lead o el cobro
// con dos lecturas chicas; solo si el número no está (o cambió de dueño) se recorre la lista
// completa, y de paso se indexa. Antes CADA mensaje entrante leía los dos hashes enteros.
async function findLeadByPhone(redis: any, phone: string): Promise<Lead | null> {
  const cached = parsePhoneTarget(await redis.hget(PHONE_INDEX_KEY, phone));
  if (cached && cached.kind === 'lead') {
    const raw = await redis.hget(LEADS_KEY, cached.id);
    if (raw) {
      const lead = normalizeLead(typeof raw === 'string' ? JSON.parse(raw) : raw);
      if (normalizePhone(lead.phone) === phone) return lead;
    }
  }
  const found = (await readLeads(redis)).find((l) => normalizePhone(l.phone) === phone) || null;
  if (found) await indexPhoneTarget(redis, phone, { kind: 'lead', id: found.id });
  return found;
}

async function findCobroByPhone(redis: any, phone: string): Promise<Cobro | null> {
  const cached = parsePhoneTarget(await redis.hget(PHONE_INDEX_KEY, phone));
  if (cached && cached.kind === 'cobro') {
    const raw = await redis.hget(COBROS_KEY, cached.id);
    if (raw) {
      const cobro = normalizeCobro(typeof raw === 'string' ? JSON.parse(raw) : raw);
      if (normalizePhone(cobro.telefono) === phone) return cobro;
    }
  }
  // Un número ya indexado como lead no está en cobranza: cobros.ts saca del índice cualquier
  // teléfono que entre o cambie en cobranza, así que este atajo es seguro.
  if (cached && cached.kind === 'lead') return null;
  const found = (await readCobros(redis)).find((c) => normalizePhone(c.telefono) === phone) || null;
  if (found) await indexPhoneTarget(redis, phone, { kind: 'cobro', id: found.id });
  return found;
}

export async function findBranchAssignee(redis: any, branch: string) {
  const users = (await getUsers(redis)).filter((u) => u.active && branchesOf(u).includes(branch));
  return users.find((u) => u.role === 'secretaria') || users.find((u) => u.role === 'gerente') || null;
}

async function notifyJosue(redis: any, message: string, type: string = 'crm-whatsapp'): Promise<void> {
  try {
    const josue = await findUserByUsername(redis, JOSUE_USERNAME);
    if (josue) {
      await pushNotification(redis, josue.id, { type, message, link: '/interno/crm' });
    }
  } catch {
    // no debe tumbar el procesamiento del mensaje
  }
}

function newLeadFromWhatsapp(phone: string, name: string, now: string): Lead {
  return {
    id: randomUUID(),
    name: name || phone,
    phone,
    city: '',
    campaign: 'WhatsApp Ads',
    secretary: '',
    status: 'Nuevo',
    nextFollowUp: null,
    convertedBranch: null,
    vehicleType: '',
    motosCount: 0,
    carrosCount: 0,
    installed: false,
    installedAt: null,
    verifiedInstalled: false,
    verifiedInstalledAt: null,
    scheduledInstallDate: null,
    source: 'whatsapp-ads',
    metaLeadId: null,
    createdByName: 'Agente IA (Andrés)',
    notes: [],
    createdAt: now,
    updatedAt: now,
    aiStage: 'sin_iniciar',
    aiHandoffAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
}

const UNSUPPORTED_TYPE_LABELS: Record<string, string> = {
  audio: 'un audio',
  image: 'una foto',
  video: 'un video',
  document: 'un documento',
  sticker: 'un sticker',
  location: 'una ubicación',
};

type ReplyCtx = { replied: boolean };

async function handleUnsupportedMessage(redis: any, fromPhone: string, msgType: string, ctx?: ReplyCtx): Promise<void> {
  const lead = await findLeadByPhone(redis, fromPhone);

  // Si ya lo tiene un humano, solo le avisamos a esa persona — no le respondemos nosotros.
  if (lead && (lead.aiStage === 'entregado' || lead.aiStage === 'escalado')) {
    if (lead.secretary) {
      const users = await getUsers(redis);
      const assignee = users.find((u) => u.name === lead.secretary && u.active);
      if (assignee) {
        await pushNotification(redis, assignee.id, {
          type: 'crm-whatsapp',
          message: `${lead.name} envió ${UNSUPPORTED_TYPE_LABELS[msgType] || 'un archivo'} por WhatsApp (revísalo directo en WhatsApp).`,
          link: '/interno/crm',
          pushBody: 'Un lead tuyo envió un archivo por WhatsApp.',
        });
      }
    } else {
      await notifyJosue(redis, `${lead.name} (escalado) envió ${UNSUPPORTED_TYPE_LABELS[msgType] || 'un archivo'} por WhatsApp.`);
    }
    return;
  }

  const sent = await sendWhatsappText(
    fromPhone,
    `Recibí ${UNSUPPORTED_TYPE_LABELS[msgType] || 'tu archivo'}, pero por ahora solo puedo leer mensajes de texto 😊 ¿Me puedes escribir tu mensaje?`
  );
  if (sent.ok && ctx) ctx.replied = true;
}

async function handleInboundMessage(redis: any, fromPhone: string, text: string, contactName: string, ctx?: ReplyCtx): Promise<void> {
  const now = new Date().toISOString();
  let lead = await findLeadByPhone(redis, fromPhone);
  // Foto del lead tal como estaba antes de tocarlo: al guardar se aplican solo los cambios de
  // este mensaje sobre lo que haya en Redis en ese momento (ver mergeLeadIntoCurrent).
  const snapshot = lead ? structuredClone(lead) : null;
  const isNewLead = !lead;
  if (!lead) {
    lead = newLeadFromWhatsapp(fromPhone, contactName, now);
    // El cliente escribió primero: queda registrado como el acto de autorización, y en la
    // primera respuesta se le indica dónde está la política de datos.
    lead.consentAt = now;
    lead.consentSource = 'whatsapp-ads';
    await indexPhoneTarget(redis, fromPhone, { kind: 'lead', id: lead.id });
  }

  lead.lastInboundAt = now;
  lead.updatedAt = now;

  // Si ya se entregó a una sucursal o se escaló, la IA no vuelve a contestar sola: solo
  // registra el mensaje y avisa a quien lo tenga asignado, para no chocar con la secretaria.
  if (lead.aiStage === 'entregado' || lead.aiStage === 'escalado') {
    lead = await mergeLeadIntoCurrent(redis, snapshot, lead);
    await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
    await appendHistory(redis, lead.id, [{ role: 'user', content: text }]);
    if (lead.secretary) {
      const users = await getUsers(redis);
      const assignee = users.find((u) => u.name === lead!.secretary && u.active);
      if (assignee) {
        await pushNotification(redis, assignee.id, {
          type: 'crm-whatsapp',
          message: `${lead.name} volvió a escribir por WhatsApp: "${text.slice(0, 80)}"`,
          link: '/interno/crm',
          pushBody: 'Un lead tuyo volvió a escribir por WhatsApp.',
        });
      }
    } else {
      await notifyJosue(redis, `${lead.name} (escalado) volvió a escribir por WhatsApp: "${text.slice(0, 80)}"`);
    }
    return;
  }

  if (lead.aiStage === 'sin_iniciar' || !lead.aiStage) lead.aiStage = 'en_conversacion';

  const history = conversationOnly(await readHistory(redis, lead.id));
  const extraInstructions = await getExtraInstructions(redis, 'andres');
  const agentResult = await runSalesAgent(history, text, extraInstructions);
  await recordAgentUsage(redis, 'andres', agentResult.usage, { id: lead.id, channel: 'whatsapp' });
  // Sin respuesta, sin herramientas y sin tokens: Anthropic no contestó (créditos, caída). Se
  // avisa y se marca el lead para que el cron de seguimiento lo reintente solo.
  const agentUnavailable = agentResult.reply === null && agentResult.toolCalls.length === 0 && agentResult.usage.inputTokens === 0;
  if (agentUnavailable) {
    lead.needsRetry = true;
    await reportIncident(redis, 'anthropic_unavailable', 'Andrés no obtuvo respuesta de Anthropic; el cliente recibió el mensaje de respaldo y se reintentará automáticamente.');
  }

  const fallbackByTool: Record<string, string> = {
    escalar_urgente: 'Dame un momento, ya te conecto con alguien de nuestro equipo para ayudarte mejor con esto.',
    marcar_calificado: '¡Perfecto! Ya te dejo agendado con la sucursal para que te confirmen la disponibilidad.',
  };
  let replyText = agentResult.reply;
  if (!replyText) {
    const firstTool = agentResult.toolCalls[0]?.name;
    replyText = (firstTool && fallbackByTool[firstTool]) || GENERIC_FALLBACK_TEXT;
  }

  for (const call of agentResult.toolCalls) {
    if (call.name === 'set_ciudad' && call.input?.ciudad) {
      lead.city = String(call.input.ciudad).trim();
      // La sucursal que realmente lo atiende puede no ser su ciudad literal (ej. Cúcuta lo
      // atiende Bucaramanga) — se guarda aparte para que la asignación a secretaria/gerente
      // y el envío de fotos de sucursal usen la sucursal real, no un texto que no coincide
      // con ninguna de las 8 sucursales.
      if (call.input?.sucursal) lead.convertedBranch = String(call.input.sucursal).trim();
    } else if (call.name === 'set_tipo_vehiculo' && call.input?.tipo) {
      lead.vehicleType = String(call.input.tipo);
      const cantidad = Number(call.input.cantidad);
      if (Number.isFinite(cantidad) && cantidad > 0) {
        // Máquina Amarilla no cuenta como carro — no tiene su propio contador numérico,
        // la cantidad queda igual reflejada en el resumen de marcar_calificado.
        if (lead.vehicleType === 'Moto') lead.motosCount = cantidad;
        else if (lead.vehicleType === 'Carro' || lead.vehicleType === 'Flota') lead.carrosCount = cantidad;
      }
    } else if (call.name === 'marcar_calificado') {
      lead.aiStage = 'entregado';
      lead.aiHandoffAt = now;
      lead.managerAckAt = null;
      lead.managerAckBy = null;
      if (lead.status !== 'Instalado') lead.status = 'Concretado por el agente';
      if (call.input?.fecha_preferida) lead.scheduledInstallDate = String(call.input.fecha_preferida);
      const summary = String(call.input?.resumen || 'Lead calificado por el agente IA.');
      lead.notes = [{ text: `[Agente IA] ${summary}`, date: now }, ...lead.notes];

      // La sucursal que realmente atiende al cliente (puede diferir de su ciudad literal,
      // ej. Cúcuta lo atiende Bucaramanga) — cae de vuelta a lead.city solo por compatibilidad
      // con leads viejos de antes de que existiera convertedBranch.
      const servicingBranch = lead.convertedBranch || lead.city;

      if (servicingBranch) {
        const assignee = await findBranchAssignee(redis, servicingBranch);
        if (assignee) {
          lead.secretary = assignee.name;

          // Aviso inmediato a la secretaria Y al gerente de esa sucursal (no solo a quien haya
          // quedado como responsable del lead) — antes la campanita/sonido/push solo le llegaba
          // a uno de los dos (el que devolviera findBranchAssignee), y el otro solo se enteraba
          // por el chat de GPSITO si llegaba a leerlo.
          try {
            const branchStaff = (await getUsers(redis)).filter((u) => u.active && branchesOf(u).includes(servicingBranch));
            const secretaria = branchStaff.find((u) => u.role === 'secretaria');
            const gerente = branchStaff.find((u) => u.role === 'gerente');
            const fechaPreferida = call.input?.fecha_preferida ? String(call.input.fecha_preferida) : '';
            const gpsitoMessage = `🚨 Andrés concretó una venta: ${lead.name} (${lead.city})${fechaPreferida ? ` — fecha preferida: ${fechaPreferida}` : ''}\n${summary}`;
            const notified = new Set<string>();
            for (const person of [secretaria, gerente]) {
              if (person && !notified.has(person.id)) {
                notified.add(person.id);
                await sendGabotMessage(redis, person.id, gpsitoMessage);
                await pushNotification(redis, person.id, {
                  type: 'crm-urgent',
                  message: `🚨 Lead concretado por el agente IA: ${lead.name} (${lead.city}) — ${summary}`,
                  link: '/interno/crm',
                  pushBody: `🚨 Nuevo lead concretado por el agente IA en ${lead.city || 'tu sucursal'}.`,
                });
              }
            }
          } catch {
            // no debe tumbar el procesamiento del mensaje
          }
        } else {
          await notifyJosue(redis, `Lead concretado sin secretaria/gerente configurado para "${servicingBranch}": ${lead.name} (${lead.phone})`, 'crm-urgent');
        }
      } else {
        await notifyJosue(redis, `Lead concretado sin ciudad definida: ${lead.name} (${lead.phone}) — ${summary}`, 'crm-urgent');
      }
    } else if (call.name === 'escalar_urgente') {
      lead.aiStage = 'escalado';
      lead.aiHandoffAt = now;
      const motivo = String(call.input?.motivo || 'Sin motivo especificado');
      lead.notes = [{ text: `[Agente IA] Escalado: ${motivo}`, date: now }, ...lead.notes];
      await notifyJosue(redis, `Urgente — lead de WhatsApp escalado: ${lead.name} (${lead.phone}) — ${motivo}`);
    } else if (call.name === 'marcar_no_interesado') {
      const motivo = String(call.input?.motivo || 'Sin motivo especificado');
      if (!lead.installed) lead.status = 'Perdido';
      lead.optOut = true;
      lead.notes = [{ text: `[Agente IA] Marcado sin interés: ${motivo} (no recibirá más mensajes automáticos)`, date: now }, ...lead.notes];
    } else if (call.name === 'derivar_a_cobranza') {
      const resumen = String(call.input?.resumen || 'Cliente actual con posible pago pendiente');
      lead.notes = [{ text: `[Agente IA] Derivado a cobranza: ${resumen}`, date: now }, ...lead.notes];
      const allCobros = await readCobros(redis);
      const cobroMatch = allCobros.find((c) => normalizePhone(c.telefono) === fromPhone);
      if (cobroMatch) {
        await notifyCobroAssigneeOrJosue(redis, cobroMatch, `${lead.name} (vía Andrés, ventas) dice tener un pago pendiente: ${resumen}`);
      } else {
        await notifyJosue(redis, `${lead.name} (${lead.phone}) dice ser cliente actual con un pago pendiente, pero no está en Cobranza especial: ${resumen}`);
      }
    } else if (call.name === 'reforzar_con_material' && !lead.mediaSentAt) {
      await sendReinforcementMedia(redis, lead, fromPhone);
      lead.mediaSentAt = new Date().toISOString();
    }
  }

  // Primero se envía y después se registra: si Meta rechaza el envío, el lead no queda como
  // "respondido" (así aparece en "Sin responder" y en el reintento) y se avisa del fallo.
  if (isNewLead) replyText += '\n\nAl escribirnos aceptas nuestra política de datos: tugps24.com/privacidad';
  const sendResult = await sendWhatsappText(fromPhone, replyText);
  lead.updatedAt = new Date().toISOString();
  if (sendResult.ok) {
    lead.lastOutboundAt = lead.updatedAt;
    if (ctx) ctx.replied = true;
  } else {
    lead.needsRetry = true;
    await reportIncident(redis, 'whatsapp_send_failed', `…${fromPhone.slice(-4)}: ${sendResult.error || 'error'}`);
  }

  lead = await mergeLeadIntoCurrent(redis, snapshot, lead);
  await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
  await appendHistory(redis, lead.id, [
    { role: 'user', content: text },
    sendResult.ok
      ? { role: 'assistant', content: replyText }
      : { role: 'assistant', content: `${STATUS_NOTE_PREFIX} failed — ${sendResult.error || 'error al enviar'}` },
  ]);
  await logAudit(redis, WHATSAPP_ACTOR, isNewLead ? 'lead_whatsapp_create' : 'lead_whatsapp_message', lead.id);
  if (!sendResult.ok) return;

  // En cuanto sabemos tipo de vehículo y ciudad, reforzamos con el video de la central de
  // monitoreo (siempre), una recuperación real, y la foto de la sucursal — una sola vez por lead.
  if (!lead.mediaSentAt && lead.vehicleType && lead.city) {
    await sendReinforcementMedia(redis, lead, fromPhone);
    lead.mediaSentAt = new Date().toISOString();
    await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
  }
}

function normalizeNameForMatch(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

async function notifyCobroAssigneeOrJosue(redis: any, cobro: Cobro, message: string): Promise<void> {
  const assignedName = normalizeNameForMatch(cobro.assignedTo).split(/\s+/)[0];
  if (assignedName) {
    const users = await getUsers(redis);
    const assignee = users.find((u) => u.active && normalizeNameForMatch(u.name).split(/\s+/)[0] === assignedName);
    if (assignee) {
      await pushNotification(redis, assignee.id, { type: 'crm-whatsapp', message, link: '/interno/cobros' });
      return;
    }
  }
  await notifyJosue(redis, message);
}

async function handleUnsupportedCobroMessage(redis: any, cobro: Cobro, msgType: string): Promise<void> {
  await notifyCobroAssigneeOrJosue(
    redis,
    cobro,
    `${cobro.nombre} (cobranza) envió ${UNSUPPORTED_TYPE_LABELS[msgType] || 'un archivo'} por WhatsApp (revísalo directo en WhatsApp).`
  );
}

async function handleCollectionsMessage(redis: any, cobro: Cobro, text: string, ctx?: ReplyCtx): Promise<void> {
  const now = new Date().toISOString();
  const fromPhone = normalizePhone(cobro.telefono);
  cobro.lastInboundAt = now;
  cobro.updatedAt = now;

  // Si ya se escaló, la IA no vuelve a contestar sola: solo registra el mensaje y avisa.
  if (cobro.aiStage === 'escalado') {
    await writeCobros(redis, { [cobro.id]: JSON.stringify(cobro) });
    await appendCobroHistory(redis, cobro.id, [{ role: 'user', content: text }]);
    await notifyCobroAssigneeOrJosue(redis, cobro, `${cobro.nombre} (cobranza, escalado) volvió a escribir por WhatsApp: "${text.slice(0, 80)}"`);
    return;
  }

  if (cobro.aiStage === 'sin_iniciar' || !cobro.aiStage) cobro.aiStage = 'en_conversacion';

  const history = conversationOnly(await readCobroHistory(redis, cobro.id));
  const extraInstructions = await getExtraInstructions(redis, 'valentina');
  const agentResult = await runCollectionsAgent(
    history,
    text,
    { nombre: cobro.nombre, deuda: cobro.deuda, facturasImpagas: cobro.facturasImpagas },
    extraInstructions
  );
  await recordAgentUsage(redis, 'valentina', agentResult.usage, { id: cobro.id, channel: 'whatsapp' });

  const fallbackByTool: Record<string, string> = {
    escalar_urgente: 'Dame un momento, ya te comunico con alguien de nuestro equipo para revisar esto.',
    registrar_pago_reportado: 'Perfecto, en breve tesorería confirma tu pago.',
    registrar_acuerdo_pago: 'Listo, quedamos así entonces.',
  };
  let replyText = agentResult.reply;
  if (!replyText) {
    const firstTool = agentResult.toolCalls[0]?.name;
    replyText = (firstTool && fallbackByTool[firstTool]) || GENERIC_FALLBACK_TEXT;
  }

  let sendPaymentImage = false;
  let justDerivedToSales = false;

  for (const call of agentResult.toolCalls) {
    if (call.name === 'registrar_acuerdo_pago') {
      cobro.aiStage = 'acuerdo';
      const resumen = String(call.input?.resumen || 'Acuerdo de pago registrado por el agente IA.');
      await logAudit(redis, COLLECTIONS_ACTOR, 'cobro_acuerdo_pago', cobro.nombre, resumen);
      await notifyCobroAssigneeOrJosue(redis, cobro, `Acuerdo de pago con ${cobro.nombre} (${cobro.telefono}): ${resumen}`);
    } else if (call.name === 'registrar_pago_reportado') {
      const detalle = String(call.input?.detalle || 'Sin detalle');
      await logAudit(redis, COLLECTIONS_ACTOR, 'cobro_pago_reportado', cobro.nombre, detalle);
      await notifyCobroAssigneeOrJosue(redis, cobro, `${cobro.nombre} (${cobro.telefono}) dice que ya pagó — verificar en tesorería: ${detalle}`);
    } else if (call.name === 'escalar_urgente') {
      cobro.aiStage = 'escalado';
      const motivo = String(call.input?.motivo || 'Sin motivo especificado');
      await logAudit(redis, COLLECTIONS_ACTOR, 'cobro_escalado', cobro.nombre, motivo);
      await notifyJosue(redis, `Urgente — cobranza de WhatsApp escalada: ${cobro.nombre} (${cobro.telefono}) — ${motivo}`);
    } else if (call.name === 'derivar_a_ventas') {
      const resumen = String(call.input?.resumen || 'Cliente de cobranza pide instalación de un vehículo nuevo');
      const leadNow = new Date().toISOString();
      const allLeads = await readLeads(redis);
      let leadMatch = allLeads.find((l) => normalizePhone(l.phone) === fromPhone);
      if (!leadMatch) {
        leadMatch = newLeadFromWhatsapp(fromPhone, cobro.nombre, leadNow);
        await indexPhoneTarget(redis, fromPhone, { kind: 'lead', id: leadMatch.id });
      }
      leadMatch.notes = [{ text: `[Valentina, cobranza] Cliente actual pide instalación nueva: ${resumen}`, date: leadNow }, ...leadMatch.notes];
      await writeLeads(redis, { [leadMatch.id]: JSON.stringify(leadMatch) });
      // De aquí en adelante este número lo atiende Andrés (ventas), no Valentina — y Andrés
      // responde ya mismo en este mismo mensaje, en vez de esperar a que alguien vea una notificación.
      cobro.derivedToSales = true;
      justDerivedToSales = true;
    } else if (call.name === 'enviar_medios_pago' && !cobro.paymentImageSentAt) {
      sendPaymentImage = true;
      cobro.paymentImageSentAt = new Date().toISOString();
    }
  }

  const sendResult = await sendWhatsappText(fromPhone, replyText);
  cobro.updatedAt = new Date().toISOString();
  if (sendResult.ok) {
    cobro.lastOutboundAt = cobro.updatedAt;
    if (ctx) ctx.replied = true;
  } else {
    await reportIncident(redis, 'whatsapp_send_failed', `…${fromPhone.slice(-4)}: ${sendResult.error || 'error'}`);
  }

  await writeCobros(redis, { [cobro.id]: JSON.stringify(cobro) });
  await appendCobroHistory(redis, cobro.id, [
    { role: 'user', content: text },
    sendResult.ok
      ? { role: 'assistant', content: replyText }
      : { role: 'assistant', content: `${STATUS_NOTE_PREFIX} failed — ${sendResult.error || 'error al enviar'}` },
  ]);
  await logAudit(redis, COLLECTIONS_ACTOR, 'cobro_whatsapp_message', cobro.id);
  if (!sendResult.ok) return;

  if (sendPaymentImage) {
    try {
      const media = await readAgentMedia(redis);
      if (media.medios_pago) {
        await sendWhatsappMedia(fromPhone, 'image', media.medios_pago, 'Medios de pago disponibles.');
      }
    } catch {
      // no debe tumbar el flujo si falla el envío de la imagen
    }
  }

  // Andrés toma la conversación de inmediato en este mismo mensaje, en vez de dejar que el
  // cliente espere a que alguien vea la notificación de derivación.
  if (justDerivedToSales) {
    await handleInboundMessage(redis, fromPhone, text, cobro.nombre);
  }
}

export async function sendReinforcementMedia(redis: any, lead: Lead, toPhone: string): Promise<void> {
  try {
    const media = await readAgentMedia(redis);

    if (media.central_video) {
      await sendWhatsappMedia(toPhone, 'video', media.central_video, 'Así funciona nuestra central de monitoreo 24/7 — esto es lo que nos diferencia.');
    }
    if (media.recuperacion_video_1) {
      await sendWhatsappMedia(toPhone, 'video', media.recuperacion_video_1, 'Una recuperación real de uno de nuestros clientes.');
    }
    if (media.recuperacion_foto_1) {
      await sendWhatsappMedia(toPhone, 'image', media.recuperacion_foto_1, 'Uno de los vehículos que hemos recuperado.');
    }
    const mediaBranch = lead.convertedBranch || lead.city;
    const branchKey = BRANCH_MEDIA_KEY[mediaBranch];
    if (branchKey && media[branchKey]) {
      await sendWhatsappMedia(toPhone, 'image', media[branchKey], `Nuestra sucursal en ${mediaBranch}.`);
    }
  } catch {
    // no debe tumbar el flujo si falla el envío de material adicional
  }
}

// Candado por número de cliente. Dos mensajes seguidos del mismo cliente llegan como dos
// invocaciones en paralelo: las dos leían el mismo historial y el mismo lead, y la que guardaba
// de última borraba lo de la otra (se perdían mensajes del historial y respuestas del agente).
// Con el candado, el segundo mensaje espera al primero y además lo ve ya en el historial, así
// que Andrés contesta con todo el contexto. Si en un minuto no se libera (una invocación que
// murió), se sigue igual: peor es dejar al cliente sin respuesta.
const PHONE_LOCK_SECONDS = 90;
const PHONE_LOCK_WAIT_MS = 60_000;

async function withPhoneLock<T>(redis: any, phone: string, fn: () => Promise<T>, options: { waitMs?: number; skipIfBusy?: boolean } = {}): Promise<T | undefined> {
  const key = `internal:whatsapp-phone-lock:${phone}`;
  const token = randomUUID();
  const waitMs = options.waitMs ?? PHONE_LOCK_WAIT_MS;
  const started = Date.now();
  let acquired = false;
  for (;;) {
    acquired = !!(await redis.set(key, token, { nx: true, ex: PHONE_LOCK_SECONDS }));
    if (acquired || Date.now() - started >= waitMs) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!acquired && options.skipIfBusy) return undefined;
  try {
    return await fn();
  } finally {
    if (acquired) {
      // Solo se libera si sigue siendo nuestro: si venció y lo tomó otra invocación, no se le quita.
      const owner = await redis.get(key).catch(() => null);
      if (owner === token) await redis.del(key).catch(() => {});
    }
  }
}

type StatusWork = { phone: string; note: string };
type InboundWork = { msg: any; fromPhone: string; contacts: any[] };

// Buzón de mensajes pendientes. Desde que se le responde a Meta antes de procesar, un mensaje
// cuya invocación muera a mitad (tiempo agotado, instancia reciclada) ya no lo reenviaría Meta:
// recibió 200. Cada mensaje entra al buzón en la primera fase y sale cuando se terminó de
// atender; whatsapp-inbox-cron reintenta los que lleven más de unos minutos ahí.
export const INBOX_KEY = 'internal:whatsapp-inbox';
export const INBOX_MAX_ATTEMPTS = 3;
export type InboxEntry = InboundWork & { queuedAt: string; attempts: number };

// Un mismo número no debería mandar más que esto: por encima es un bot, un bucle o alguien
// probando; cada mensaje cuesta una transcripción y una llamada a Anthropic.
const PHONE_HOURLY_MAX = 30;
const PHONE_DAILY_MAX = 80;
const PHONE_AUDIO_HOURLY_MAX = 10;
const RATE_NOTICE_TEXT = 'Hemos recibido muchos mensajes tuyos en poco tiempo. Un asesor revisará la conversación y te escribirá; gracias por la paciencia.';

async function phoneWithinLimits(redis: any, phone: string, isAudio: boolean): Promise<boolean> {
  const hourOk = await checkAndIncrementRateLimit(redis, `internal:whatsapp-rate:h:${phone}`, PHONE_HOURLY_MAX, 3600);
  const dayOk = await checkAndIncrementRateLimit(redis, `internal:whatsapp-rate:d:${phone}`, PHONE_DAILY_MAX, 86400);
  const audioOk = !isAudio || (await checkAndIncrementRateLimit(redis, `internal:whatsapp-rate:a:${phone}`, PHONE_AUDIO_HOURLY_MAX, 3600));
  return hourOk && dayOk && audioOk;
}

async function notifyRateLimited(redis: any, phone: string): Promise<void> {
  // Un solo aviso al día por número, para no responderle a un bucle con otro bucle.
  const first = await redis.set(`internal:whatsapp-rate-notice:${phone}`, '1', { nx: true, ex: 86400 }).catch(() => null);
  if (!first) return;
  await sendWhatsappText(phone, RATE_NOTICE_TEXT).catch(() => {});
  await logAudit(redis, WHATSAPP_ACTOR, 'whatsapp_rate_limited', `…${phone.slice(-4)}`, 'número por encima del límite de mensajes; se dejó de atender hasta que baje').catch(() => {});
  await reportIncident(redis, 'whatsapp_rate_limited', `…${phone.slice(-4)} superó el límite de mensajes por hora o por día`);
}

async function processStatusNotes(redis: any, statuses: StatusWork[]): Promise<void> {
  for (const { phone, note } of statuses) {
    try {
      const target = await resolvePhoneTarget(redis, phone);
      if (!target) continue;
      // Un acuse es diagnóstico: si el número está ocupado procesando un mensaje real, se omite
      // en vez de esperar o de pisarle el historial.
      await withPhoneLock(
        redis,
        phone,
        async () => {
          if (target.kind === 'cobro') await appendCobroHistory(redis, target.id, [{ role: 'assistant', content: note }]);
          else await appendHistory(redis, target.id, [{ role: 'assistant', content: note }]);
        },
        { waitMs: 5_000, skipIfBusy: true }
      );
    } catch (err) {
      console.error('whatsapp-webhook: acuse no registrado …' + phone.slice(-4), err instanceof Error ? err.message : String(err));
    }
  }
}

// Devuelve true si el mensaje quedó atendido (o descartado a propósito) y puede salir del buzón;
// false si debe quedarse para que el cron lo reintente.
export async function processInboundMessage(redis: any, { msg, fromPhone, contacts }: InboundWork): Promise<boolean> {
  const ctx: ReplyCtx = { replied: false };
  try {
    // Si tras un minuto el número sigue ocupado por otra invocación, no se procesa en paralelo
    // (dos respuestas cruzadas al mismo cliente): se deja en el buzón y lo retoma el cron.
    const ran = await withPhoneLock(redis, fromPhone, async () => {
      const contactName = contacts.find((c: any) => c.wa_id === msg.from)?.profile?.name || '';

      // Si el número corresponde a un cobro cargado en Cobranza Masiva, lo maneja la
      // agente de cobranza (Valentina) — salvo que ya se haya derivado a ventas (el
      // cliente pidió instalar un vehículo nuevo), en cuyo caso sigue con Andrés.
      const cobro = await findCobroByPhone(redis, fromPhone);
      const routeToCollections = !!cobro && !cobro.derivedToSales;

      let text = '';
      if (msg.type === 'text') {
        text = msg.text?.body ? String(msg.text.body) : '';
      } else if (msg.type === 'audio' && msg.audio?.id) {
        text = (await transcribeWhatsappAudio(String(msg.audio.id))) || '';
      }

      if (!text) {
        // No se pudo transcribir el audio, o es un tipo que no leemos (foto, video,
        // documento, sticker, ubicación) — avisamos al cliente en vez de dejarlo en
        // silencio, salvo que el caso ya lo tenga un humano.
        if (routeToCollections && cobro) {
          await handleUnsupportedCobroMessage(redis, cobro, msg.type);
        } else {
          await handleUnsupportedMessage(redis, fromPhone, msg.type, ctx);
        }
        return;
      }

      if (routeToCollections && cobro) {
        await handleCollectionsMessage(redis, cobro, text, ctx);
      } else {
        await handleInboundMessage(redis, fromPhone, text, contactName, ctx);
      }
      return true;
    }, { skipIfBusy: true });
    if (!ran) {
      await logAudit(redis, WHATSAPP_ACTOR, 'whatsapp_inbox_deferred', `…${fromPhone.slice(-4)}`, 'número ocupado por otra invocación; se reintenta desde el buzón').catch(() => {});
      return false;
    }
    if (msg.id) await redis.hdel(INBOX_KEY, String(msg.id)).catch(() => {});
    return true;
  } catch (err) {
    // Un mensaje que falla (Anthropic, Redis, Meta) no debe tumbar los demás del mismo
    // paquete. Si al cliente no le llegó respuesta se queda en el buzón para el reintento;
    // si ya se le respondió y falló algo posterior, reprocesar le mandaría otra respuesta.
    const message = err instanceof Error ? err.message : String(err);
    console.error('whatsapp-webhook: fallo procesando mensaje de …' + fromPhone.slice(-4), message);
    await logAudit(redis, WHATSAPP_ACTOR, 'whatsapp_webhook_error', `…${fromPhone.slice(-4)}`, message).catch(() => {});
    await reportIncident(redis, 'whatsapp_webhook_error', message);
    if (ctx.replied) {
      if (msg.id) await redis.hdel(INBOX_KEY, String(msg.id)).catch(() => {});
      return true;
    }
    return false;
  }
}

async function processWebhookWork(redis: any, statuses: StatusWork[], inbound: InboundWork[]): Promise<void> {
  try {
    await processStatusNotes(redis, statuses);
    // Números distintos se atienden en paralelo (cada uno con su candado); los mensajes de un
    // mismo número van en orden, que es el que el cliente espera ver respondido.
    const byPhone = new Map<string, InboundWork[]>();
    for (const item of inbound) {
      const list = byPhone.get(item.fromPhone) || [];
      list.push(item);
      byPhone.set(item.fromPhone, list);
    }
    await Promise.allSettled(
      [...byPhone.values()].map(async (items) => {
        for (const item of items) await processInboundMessage(redis, item);
      })
    );
  } catch (err) {
    await logAudit(redis, WHATSAPP_ACTOR, 'whatsapp_webhook_error', 'error', err instanceof Error ? err.message : String(err)).catch(() => {});
  }
}

export const POST: APIRoute = async ({ request }) => {
  const rawBody = await request.text();
  if (!verifyMetaSignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    return new Response('invalid signature', { status: 403 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  const redis = getRedis();
  if (!redis) {
    // Meta reintenta si no respondemos 200 rápido; sin Redis no hay nada que guardar.
    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  // Primera fase, antes de responder: se decide qué hay que procesar y se marca cada mensaje
  // como visto. Lo pesado (transcribir, Anthropic, enviar) va en la segunda fase, después de
  // responderle a Meta: Meta espera la respuesta pocos segundos y, si tarda, reenvía el paquete
  // y con el tiempo da el webhook por caído. Antes se procesaba todo antes de responder.
  const statuses: StatusWork[] = [];
  const inbound: InboundWork[] = [];
  const rateLimited = new Set<string>();
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      // Si la misma app de Meta llegara a tener otro número, sus mensajes no deben entrar al CRM.
      const ourNumber = import.meta.env.META_PHONE_NUMBER_ID;
      if (ourNumber && value.metadata?.phone_number_id && String(value.metadata.phone_number_id) !== String(ourNumber)) continue;
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];

      // Meta también manda por acá el estado real de entrega de cada mensaje que enviamos —
      // se registra en el historial del cliente para poder diagnosticar si algo se demora o
      // falla. Solo "read" y "failed" aportan algo: "sent" ya lo sabíamos y "delivered" queda
      // implícito en "read". Así el historial no se llena de acuses.
      for (const st of Array.isArray(value.statuses) ? value.statuses : []) {
        const statusLabel = String(st?.status || '');
        const phone = normalizePhone(String(st?.recipient_id || ''));
        if ((statusLabel !== 'read' && statusLabel !== 'failed') || !phone) continue;
        const errorInfo = Array.isArray(st.errors) && st.errors[0] ? ` — ${st.errors[0].title || st.errors[0].code || ''}` : '';
        statuses.push({ phone, note: `${STATUS_NOTE_PREFIX} ${statusLabel}${errorInfo}` });
      }

      for (const msg of messages) {
        const fromPhone = normalizePhone(String(msg.from || ''));
        if (!fromPhone) continue;

        // Meta puede reenviar el mismo mensaje varias veces (reintentos); nos quedamos
        // solo con el primer intento usando el id del mensaje como llave de una sola vez.
        try {
          if (msg.id) {
            const isNew = await redis.set(`internal:whatsapp-msg-seen:${msg.id}`, '1', { nx: true, ex: 86400 });
            if (!isNew) continue;
          }
          if (!(await phoneWithinLimits(redis, fromPhone, msg.type === 'audio'))) {
            rateLimited.add(fromPhone);
            continue;
          }
          if (msg.id) {
            const entry: InboxEntry = { msg, fromPhone, contacts, queuedAt: new Date().toISOString(), attempts: 0 };
            await redis.hset(INBOX_KEY, { [String(msg.id)]: JSON.stringify(entry) });
          }
        } catch (err) {
          // Redis no respondió antes de dejar el mensaje a salvo: se contesta 503 para que Meta
          // reintente el paquete. Los mensajes de este mismo paquete que ya se habían marcado
          // sueltan su marca; si no, el reintento de Meta los daría por vistos y se perderían.
          console.error('whatsapp-webhook: Redis falló al marcar el mensaje', msg.id, err instanceof Error ? err.message : String(err));
          const queuedIds = inbound.map((i) => String(i.msg?.id || '')).filter(Boolean);
          if (msg.id) queuedIds.push(String(msg.id));
          if (queuedIds.length) {
            await redis.del(...queuedIds.map((id) => `internal:whatsapp-msg-seen:${id}`)).catch(() => {});
            await redis.hdel(INBOX_KEY, ...queuedIds).catch(() => {});
          }
          return new Response('retry', { status: 503 });
        }
        inbound.push({ msg, fromPhone, contacts });
      }
    }
  }


  if (statuses.length || inbound.length || rateLimited.size) {
    const work = async () => {
      await Promise.allSettled([...rateLimited].map((phone) => notifyRateLimited(redis, phone)));
      await processWebhookWork(redis, statuses, inbound);
    };
    const pending = runAfterResponse(work());
    if (pending) await pending;
  }

  return new Response('EVENT_RECEIVED', { status: 200 });
};
