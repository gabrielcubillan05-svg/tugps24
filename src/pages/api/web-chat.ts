import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { getUsers, branchesOf } from '../../lib/auth';
import { pushNotification } from '../../lib/notifications';
import { sendGabotMessage } from '../../lib/gabot';
import { getExtraInstructions, recordAgentUsage } from '../../lib/agent-usage';
import { runSalesAgent, type AgentMessage } from '../../lib/sales-agent';
import { readLeads, normalizePhone, REDIS_KEY as LEADS_KEY, type Lead } from './leads';
import { readHistory, appendHistory, findBranchAssignee, GENERIC_FALLBACK_TEXT } from './whatsapp-webhook';
import { getClientIp, checkAndIncrementRateLimit } from '../../lib/rate-limit';

export const prerender = false;

const WEB_ACTOR = { userId: 'web-chat-agent', username: 'Agente IA (Andrés, web)' };

// Protección contra abuso/costo: este endpoint es público (cualquiera en internet puede
// llamarlo, no requiere sesión) — sin esto, alguien podría hacer explotar el gasto de
// Anthropic con requests automatizados. Tres capas: por sesión (fácil de esquivar generando
// otro sessionId), por IP (más difícil de esquivar), y un tope GLOBAL de todo el endpoint
// como último respaldo contra un ataque distribuido desde muchas IPs distintas a la vez.
const MAX_MESSAGES_PER_SESSION_PER_DAY = 40;
const MAX_MESSAGES_PER_IP_PER_DAY = 150;
const MAX_MESSAGES_GLOBAL_PER_DAY = 2000;
const SECONDS_IN_DAY = 24 * 60 * 60;

function newLeadFromWeb(phone: string, name: string, now: string): Lead {
  return {
    id: randomUUID(),
    name: name || phone,
    phone,
    city: '',
    campaign: 'Chat web',
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
    source: 'web-chat',
    metaLeadId: null,
    createdByName: 'Agente IA (Andrés, web)',
    notes: [],
    createdAt: now,
    updatedAt: now,
    aiStage: 'sin_iniciar',
    aiHandoffAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
}

export const POST: APIRoute = async ({ request }) => {
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { sessionId?: string; name?: string; phone?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const sessionId = String(body.sessionId || '').trim();
  const text = String(body.text || '').trim();
  if (!sessionId || !text) {
    return new Response(JSON.stringify({ error: 'faltan campos' }), { status: 400 });
  }
  if (text.length > 2000) {
    return new Response(JSON.stringify({ error: 'mensaje demasiado largo' }), { status: 400 });
  }

  const ip = getClientIp(request);
  const okGlobal = await checkAndIncrementRateLimit(redis, 'internal:web-chat-rate:global', MAX_MESSAGES_GLOBAL_PER_DAY, SECONDS_IN_DAY);
  const okSession = await checkAndIncrementRateLimit(redis, `internal:web-chat-rate:session:${sessionId}`, MAX_MESSAGES_PER_SESSION_PER_DAY, SECONDS_IN_DAY);
  const okIp = await checkAndIncrementRateLimit(redis, `internal:web-chat-rate:ip:${ip}`, MAX_MESSAGES_PER_IP_PER_DAY, SECONDS_IN_DAY);
  if (!okGlobal || !okSession || !okIp) {
    return new Response(
      JSON.stringify({ error: 'Alcanzaste el límite de mensajes por hoy. Escríbenos por WhatsApp o vuelve mañana.' }),
      { status: 429 }
    );
  }

  const now = new Date().toISOString();
  const allLeads = await readLeads(redis);
  // El lead de chat web se identifica por su propio sessionId (guardado como metaLeadId,
  // reutilizado aquí solo como un identificador libre) hasta que da su teléfono real —
  // a partir de ahí también queda deduplicado por teléfono como cualquier otro lead.
  let lead = allLeads.find((l) => l.source === 'web-chat' && l.metaLeadId === sessionId);
  let isNewLead = false;

  if (!lead) {
    const name = String(body.name || '').trim();
    const rawPhone = String(body.phone || '').trim();
    if (!name || !rawPhone) {
      return new Response(JSON.stringify({ error: 'falta el nombre y el WhatsApp para empezar' }), { status: 400 });
    }
    const phone = normalizePhone(rawPhone);
    if (phone.length < 7) {
      return new Response(JSON.stringify({ error: 'el número de WhatsApp no parece válido' }), { status: 400 });
    }
    const existingByPhone = allLeads.find((l) => normalizePhone(l.phone) === phone);
    if (existingByPhone) {
      lead = existingByPhone;
    } else {
      lead = newLeadFromWeb(phone, name, now);
      lead.metaLeadId = sessionId;
      isNewLead = true;
    }
  }

  // Si ya lo tiene un humano (secretaria/gerente o escalado), no le contesta la IA — solo
  // queda registrado, igual que en WhatsApp.
  if (lead.aiStage === 'entregado' || lead.aiStage === 'escalado') {
    await appendHistory(redis, lead.id, [{ role: 'user', content: text }]);
    return new Response(
      JSON.stringify({ reply: 'Ya tienes un asesor asignado — en breve te contacta directamente por WhatsApp o te responde aquí mismo si sigues escribiendo.' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  lead.lastInboundAt = now;
  if (lead.aiStage === 'sin_iniciar' || !lead.aiStage) lead.aiStage = 'en_conversacion';

  const history = await readHistory(redis, lead.id);
  const extraInstructions = await getExtraInstructions(redis, 'andres');
  const agentResult = await runSalesAgent(history, text, extraInstructions, 'web');
  await recordAgentUsage(redis, 'andres', agentResult.usage);

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
      if (call.input?.sucursal) lead.convertedBranch = String(call.input.sucursal).trim();
    } else if (call.name === 'set_tipo_vehiculo' && call.input?.tipo) {
      lead.vehicleType = String(call.input.tipo);
      const cantidad = Number(call.input.cantidad);
      if (Number.isFinite(cantidad) && cantidad > 0) {
        if (lead.vehicleType === 'Moto') lead.motosCount = cantidad;
        else if (lead.vehicleType === 'Carro' || lead.vehicleType === 'Flota') lead.carrosCount = cantidad;
      }
    } else if (call.name === 'marcar_calificado') {
      lead.aiStage = 'entregado';
      lead.aiHandoffAt = now;
      if (lead.status !== 'Instalado') lead.status = 'Concretado por el agente';
      if (call.input?.fecha_preferida) lead.scheduledInstallDate = String(call.input.fecha_preferida);
      const summary = String(call.input?.resumen || 'Lead calificado por el agente IA (chat web).');
      lead.notes = [{ text: `[Agente IA - web] ${summary}`, date: now }, ...lead.notes];

      const servicingBranch = lead.convertedBranch || lead.city;
      if (servicingBranch) {
        const assignee = await findBranchAssignee(redis, servicingBranch);
        if (assignee) {
          lead.secretary = assignee.name;
          try {
            await pushNotification(redis, assignee.id, {
              type: 'crm-urgent',
              message: `🚨 Lead concretado por el agente IA (chat web): ${lead.name} (${lead.city}) — ${summary}`,
              link: '/interno/crm',
            });
          } catch {
            // no debe tumbar el procesamiento del mensaje
          }
          try {
            const branchStaff = (await getUsers(redis)).filter((u) => u.active && branchesOf(u).includes(servicingBranch));
            const secretaria = branchStaff.find((u) => u.role === 'secretaria');
            const gerente = branchStaff.find((u) => u.role === 'gerente');
            const fechaPreferida = call.input?.fecha_preferida ? String(call.input.fecha_preferida) : '';
            const gpsitoMessage = `🚨 Andrés (chat web) concretó una venta: ${lead.name} (${lead.city})${fechaPreferida ? ` — fecha preferida: ${fechaPreferida}` : ''}\n${summary}`;
            const notified = new Set<string>();
            for (const person of [secretaria, gerente]) {
              if (person && !notified.has(person.id)) {
                notified.add(person.id);
                await sendGabotMessage(redis, person.id, gpsitoMessage);
              }
            }
          } catch {
            // no debe tumbar el procesamiento del mensaje
          }
        }
      }
    } else if (call.name === 'escalar_urgente') {
      lead.aiStage = 'escalado';
      lead.aiHandoffAt = now;
      const motivo = String(call.input?.motivo || 'Sin motivo especificado');
      lead.notes = [{ text: `[Agente IA - web] Escalado: ${motivo}`, date: now }, ...lead.notes];
    } else if (call.name === 'marcar_no_interesado') {
      const motivo = String(call.input?.motivo || 'Sin motivo especificado');
      if (!lead.installed) lead.status = 'Perdido';
      lead.notes = [{ text: `[Agente IA - web] Marcado sin interés: ${motivo}`, date: now }, ...lead.notes];
    }
    // derivar_a_cobranza y reforzar_con_material no aplican aquí: el chat web no tiene acceso
    // al historial de cobranza por teléfono todavía, ni forma de mandar imágenes/video por chat.
  }

  lead.updatedAt = new Date().toISOString();
  lead.lastOutboundAt = lead.updatedAt;

  await redis.hset(LEADS_KEY, { [lead.id]: JSON.stringify(lead) });
  await appendHistory(redis, lead.id, [
    { role: 'user', content: text },
    { role: 'assistant', content: replyText },
  ]);
  await logAudit(redis, WEB_ACTOR, isNewLead ? 'lead_web_chat_create' : 'lead_web_chat_message', lead.name, lead.phone);

  return new Response(JSON.stringify({ reply: replyText }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
