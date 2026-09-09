import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { pushNotification } from '../../lib/notifications';
import { getUsers, findUserByUsername, JOSUE_USERNAME } from '../../lib/auth';
import { sendWhatsappText, verifyMetaSignature } from '../../lib/whatsapp';
import { runSalesAgent, type AgentMessage } from '../../lib/sales-agent';
import { readLeads, normalizePhone, REDIS_KEY as LEADS_KEY, type Lead } from './leads';

export const prerender = false;

const CONVERSATIONS_KEY = 'internal:lead-whatsapp-conversations';
const MAX_HISTORY = 60;
const WHATSAPP_ACTOR = { userId: 'whatsapp-agent', username: 'Agente IA (Andrés)' };

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

async function readHistory(redis: any, leadId: string): Promise<AgentMessage[]> {
  const raw = await redis.hget<string>(CONVERSATIONS_KEY, leadId);
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendHistory(redis: any, leadId: string, entries: AgentMessage[]): Promise<void> {
  const current = await readHistory(redis, leadId);
  const updated = [...current, ...entries].slice(-MAX_HISTORY);
  await redis.hset(CONVERSATIONS_KEY, { [leadId]: JSON.stringify(updated) });
}

async function findBranchAssignee(redis: any, branch: string) {
  const users = (await getUsers(redis)).filter((u) => u.active && u.branch === branch);
  return users.find((u) => u.role === 'secretaria') || users.find((u) => u.role === 'gerente') || null;
}

async function notifyJosue(redis: any, message: string): Promise<void> {
  try {
    const josue = await findUserByUsername(redis, JOSUE_USERNAME);
    if (josue) {
      await pushNotification(redis, josue.id, { type: 'crm-whatsapp', message, link: '/interno/crm' });
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

async function handleInboundMessage(redis: any, fromPhone: string, text: string, contactName: string): Promise<void> {
  const now = new Date().toISOString();
  const allLeads = await readLeads(redis);
  let lead = allLeads.find((l) => normalizePhone(l.phone) === fromPhone);
  const isNewLead = !lead;
  if (!lead) {
    lead = newLeadFromWhatsapp(fromPhone, contactName, now);
  }

  lead.lastInboundAt = now;
  lead.updatedAt = now;

  // Si ya se entregó a una sucursal o se escaló, la IA no vuelve a contestar sola: solo
  // registra el mensaje y avisa a quien lo tenga asignado, para no chocar con la secretaria.
  if (lead.aiStage === 'entregado' || lead.aiStage === 'escalado') {
    await redis.hset(LEADS_KEY, { [lead.id]: JSON.stringify(lead) });
    await appendHistory(redis, lead.id, [{ role: 'user', content: text }]);
    if (lead.secretary) {
      const users = await getUsers(redis);
      const assignee = users.find((u) => u.name === lead!.secretary && u.active);
      if (assignee) {
        await pushNotification(redis, assignee.id, {
          type: 'crm-whatsapp',
          message: `${lead.name} volvió a escribir por WhatsApp: "${text.slice(0, 80)}"`,
          link: '/interno/crm',
        });
      }
    } else {
      await notifyJosue(redis, `${lead.name} (escalado) volvió a escribir por WhatsApp: "${text.slice(0, 80)}"`);
    }
    return;
  }

  if (lead.aiStage === 'sin_iniciar' || !lead.aiStage) lead.aiStage = 'en_conversacion';

  const history = await readHistory(redis, lead.id);
  const agentResult = await runSalesAgent(history, text);

  const fallbackByTool: Record<string, string> = {
    escalar_urgente: 'Dame un momento, ya te conecto con alguien de nuestro equipo para ayudarte mejor con esto.',
    marcar_calificado: '¡Perfecto! Ya te dejo agendado con la sucursal para que te confirmen la disponibilidad.',
  };
  let replyText = agentResult.reply;
  if (!replyText) {
    const firstTool = agentResult.toolCalls[0]?.name;
    replyText = (firstTool && fallbackByTool[firstTool]) || 'Gracias por tu mensaje, dame un momento.';
  }

  for (const call of agentResult.toolCalls) {
    if (call.name === 'set_ciudad' && call.input?.ciudad) {
      lead.city = String(call.input.ciudad).trim();
    } else if (call.name === 'set_tipo_vehiculo' && call.input?.tipo) {
      lead.vehicleType = String(call.input.tipo);
      const cantidad = Number(call.input.cantidad);
      if (Number.isFinite(cantidad) && cantidad > 0) {
        if (lead.vehicleType === 'Moto') lead.motosCount = cantidad;
        else lead.carrosCount = cantidad;
      }
    } else if (call.name === 'marcar_calificado') {
      lead.aiStage = 'entregado';
      lead.aiHandoffAt = now;
      if (lead.status === 'Nuevo') lead.status = 'Contactado';
      if (call.input?.fecha_preferida) lead.scheduledInstallDate = String(call.input.fecha_preferida);
      const summary = String(call.input?.resumen || 'Lead calificado por el agente IA.');
      lead.notes = [{ text: `[Agente IA] ${summary}`, date: now }, ...lead.notes];

      if (lead.city) {
        const assignee = await findBranchAssignee(redis, lead.city);
        if (assignee) {
          lead.secretary = assignee.name;
          try {
            await pushNotification(redis, assignee.id, {
              type: 'crm-whatsapp',
              message: `Lead calificado por el agente IA: ${lead.name} (${lead.city}) — ${summary}`,
              link: '/interno/crm',
            });
          } catch {
            // no debe tumbar el procesamiento del mensaje
          }
        } else {
          await notifyJosue(redis, `Lead calificado sin secretaria/gerente configurado para "${lead.city}": ${lead.name} (${lead.phone})`);
        }
      } else {
        await notifyJosue(redis, `Lead calificado sin ciudad definida: ${lead.name} (${lead.phone}) — ${summary}`);
      }
    } else if (call.name === 'escalar_urgente') {
      lead.aiStage = 'escalado';
      lead.aiHandoffAt = now;
      const motivo = String(call.input?.motivo || 'Sin motivo especificado');
      lead.notes = [{ text: `[Agente IA] Escalado: ${motivo}`, date: now }, ...lead.notes];
      await notifyJosue(redis, `Urgente — lead de WhatsApp escalado: ${lead.name} (${lead.phone}) — ${motivo}`);
    }
  }

  lead.updatedAt = new Date().toISOString();
  lead.lastOutboundAt = lead.updatedAt;

  await redis.hset(LEADS_KEY, { [lead.id]: JSON.stringify(lead) });
  await appendHistory(redis, lead.id, [
    { role: 'user', content: text },
    { role: 'assistant', content: replyText },
  ]);
  await logAudit(redis, WHATSAPP_ACTOR, isNewLead ? 'lead_whatsapp_create' : 'lead_whatsapp_message', lead.name, lead.phone);

  await sendWhatsappText(fromPhone, replyText);
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

  try {
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        for (const msg of messages) {
          if (msg.type !== 'text') continue; // fase 1: solo mensajes de texto
          const fromPhone = normalizePhone(String(msg.from || ''));
          const text = msg.text?.body ? String(msg.text.body) : '';
          if (!fromPhone || !text) continue;
          const contactName = contacts.find((c: any) => c.wa_id === msg.from)?.profile?.name || '';
          await handleInboundMessage(redis, fromPhone, text, contactName);
        }
      }
    }
  } catch (err) {
    await logAudit(redis, WHATSAPP_ACTOR, 'whatsapp_webhook_error', 'error', err instanceof Error ? err.message : String(err));
  }

  return new Response('EVENT_RECEIVED', { status: 200 });
};
