import type { APIRoute } from 'astro';
import { cronSecretMatches, getUsers, branchesOf, findUserByUsername, JOSUE_USERNAME } from '../../lib/auth';
import { getRedis } from '../../lib/redis';
import { pushNotification } from '../../lib/notifications';
import { sendWhatsappText, isQuietHoursColombia } from '../../lib/whatsapp';
import { activeInstallPromos, promoUntilLabel, spokenBranchName, branchForCityName } from '../../lib/pricing';
import { todayInColombia, addDaysToDateString } from '../../lib/colombia-time';
import { readLeads, writeLeads, type Lead } from './leads';
import { appendHistory, sendReinforcementMedia, readHistory, conversationOnly } from './whatsapp-webhook';
import { runSalesAgent } from '../../lib/sales-agent';
import { getExtraInstructions, recordAgentUsage } from '../../lib/agent-usage';
import { markCronOk, reportIncident } from '../../lib/incidents';

export const prerender = false;

const MIN_HOURS_SINCE_LAST_REPLY = 3; // esperar unas horas de silencio antes de insistir
const MAX_HOURS_SINCE_LAST_INBOUND = 22; // margen de seguridad antes de que cierre la ventana de 24h de Meta
const MAX_FOLLOW_UPS = 2;

// Los dos toques dentro de las 24 h llevan contenido (Gabriel, 2026-10-08): el primero va con el
// video de la central y una recuperación; el segundo, con la promoción de su sucursal si hay una
// vigente, o con la oferta de dejarlo agendado sin compromiso.
function followUpMessage(lead: Lead, index: number): string {
  const branch = lead.convertedBranch || branchForCityName(lead.city) || '';
  if (index === 0) {
    return 'Hola de nuevo 😊 Te dejo un video corto de cómo trabaja nuestra central de monitoreo 24/7 y una recuperación real, para que veas por qué vale la pena. Si te queda alguna duda sobre el GPS o los precios, aquí estoy 📲';
  }
  const promo = branch ? activeInstallPromos().find((p) => p.branches.includes(branch)) : undefined;
  if (promo) {
    return `Solo para que no se te pase: la promoción de instalación a $${promo.price.toLocaleString('es-CO')} en ${spokenBranchName(branch)} va hasta el ${promoUntilLabel(promo)} y los cupos son limitados 🔥 ¿Te separo uno para esta semana? Dime qué día te queda mejor.`;
  }
  return `Para no perder el contacto: si quieres te dejo agendado sin compromiso con nuestra sucursal${branch ? ' de ' + spokenBranchName(branch) : ''} y allá te resuelven cualquier duda antes de instalar ✅ ¿Te queda mejor entre semana o el sábado?`;
}

const HANDOFF_NUDGE_HOURS = 2;

// Secretaria y gerente de la sucursal; si no hay nadie configurado, Josué.
async function notifyBranchStaff(redis: any, branch: string, message: string, key: string): Promise<void> {
  const users = await getUsers(redis);
  const staff = branch ? users.filter((u) => u.active && branchesOf(u).includes(branch)) : [];
  const targets = [staff.find((u) => u.role === 'secretaria'), staff.find((u) => u.role === 'gerente')].filter((u): u is NonNullable<typeof u> => !!u);
  if (!targets.length) {
    const josue = await findUserByUsername(redis, JOSUE_USERNAME);
    if (josue) targets.push(josue);
  }
  const seen = new Set<string>();
  for (const u of targets) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    await pushNotification(redis, u.id, { type: 'crm-urgent', message, link: '/interno/crm', key, pushBody: 'Andrés: un lead concretado necesita atención.' }).catch(() => {});
  }
}

// Vercel llama esto por cron (ver vercel.json). Revisa leads en conversación activa con el
// agente que se quedaron callados, y les manda un empujoncito — siempre DENTRO de las 24h
// desde su último mensaje, para poder usar texto libre sin necesitar una plantilla de Meta.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  // Falla cerrado: si CRON_SECRET no está configurado, el endpoint se bloquea en vez de
  // quedar abierto a cualquiera en internet.
  if (!secret || !cronSecretMatches(authHeader, secret)) {
    return new Response('unauthorized', { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  // No insistimos entre 11pm y 6am hora Colombia — que se quede callado hasta que amanezca.
  if (isQuietHoursColombia()) {
    // El cron sí corrió (solo que no es hora de mandar): cuenta como sano para /api/health.
    await markCronOk(redis, 'whatsapp-followup');
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 'quiet hours' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const lock = await redis.set('internal:followup-lock', '1', { nx: true, ex: 600 });
  if (!lock) {
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 'otra corrida en curso' }), { headers: { 'Content-Type': 'application/json' } });
  }

  const now = Date.now();
  let sent = 0;
  let retried = 0;
  let recordatorios = 0;
  let avisos = 0;
  // Con Anthropic caído cada reintento puede tardar más de dos minutos (3 intentos de 45 s):
  // 20 leads seguidos pasarían los 300 s de la función y el cron moriría a mitad sin soltar
  // el candado. Se para a tiempo y lo que falte sale en la próxima hora.
  const TIME_BUDGET_MS = 200_000;
  const outOfTime = () => Date.now() - now > TIME_BUDGET_MS;
  try {
  const leads = await readLeads(redis);

  // Reintento automático de los que quedaron sin respuesta real (Anthropic caído o Meta
  // rechazó el envío): se vuelve a correr al agente con el último mensaje del cliente,
  // mientras siga abierta la ventana de 24 h. Antes dependía de que alguien pulsara el botón.
  const extraInstructions = await getExtraInstructions(redis, 'andres');
  for (const lead of leads.filter((l) => l.needsRetry && l.aiStage === 'en_conversacion' && l.lastInboundAt).slice(0, 20)) {
    if (outOfTime()) break;
    const hoursSinceInbound = (now - new Date(lead.lastInboundAt!).getTime()) / 3600000;
    if (hoursSinceInbound >= MAX_HOURS_SINCE_LAST_INBOUND) {
      lead.needsRetry = false;
      await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
      continue;
    }
    const history = conversationOnly(await readHistory(redis, lead.id));
    const lastUserIdx = history.map((m) => m.role).lastIndexOf('user');
    if (lastUserIdx < 0) continue;
    const lastUserText = history[lastUserIdx].content;
    const agentResult = await runSalesAgent(history.slice(0, lastUserIdx), lastUserText, extraInstructions);
    await recordAgentUsage(redis, 'andres', agentResult.usage, { id: lead.id, channel: 'whatsapp' });
    if (!agentResult.reply) continue; // sigue caído; se intenta en la próxima hora
    const result = await sendWhatsappText(lead.phone, agentResult.reply);
    if (!result.ok) {
      await reportIncident(redis, 'whatsapp_send_failed', `…${lead.phone.slice(-4)}: ${result.error || 'error'}`);
      continue;
    }
    const nowIso = new Date().toISOString();
    lead.needsRetry = false;
    lead.lastOutboundAt = nowIso;
    lead.updatedAt = nowIso;
    await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
    await appendHistory(redis, lead.id, [{ role: 'assistant', content: agentResult.reply }]);
    retried++;
  }

  for (const lead of leads) {
    if (outOfTime()) break;
    if (lead.source !== 'whatsapp-ads') continue;
    // Un lead ya instalado no debe recibir más mensajes de "¿sigues por ahí?" — antes esto
    // solo se filtraba por aiStage, que no siempre pasa a 'entregado' cuando la instalación
    // se marca por otra vía (ej. un técnico la marca directo desde el CRM).
    if (lead.installed || lead.status === 'Instalado' || lead.optOut) continue;
    if (lead.aiStage !== 'en_conversacion') continue;
    if (!lead.lastInboundAt || !lead.lastOutboundAt) continue;

    const lastInbound = new Date(lead.lastInboundAt).getTime();
    const lastOutbound = new Date(lead.lastOutboundAt).getTime();
    const lastFollowUp = lead.lastFollowUpAt ? new Date(lead.lastFollowUpAt).getTime() : 0;
    const followUpCount = lead.followUpCount || 0;

    if (lastInbound > lastOutbound) continue; // el cliente ya respondió, no hay nada que reenganchar
    if (followUpCount >= MAX_FOLLOW_UPS) continue; // ya se usaron los intentos disponibles

    const sinceLastReply = now - Math.max(lastOutbound, lastFollowUp);
    if (sinceLastReply < MIN_HOURS_SINCE_LAST_REPLY * 3600000) continue; // muy pronto todavía

    const hoursSinceInbound = (now - lastInbound) / 3600000;
    if (hoursSinceInbound >= MAX_HOURS_SINCE_LAST_INBOUND) continue; // ya se acerca a las 24h, no arriesgarse

    const message = followUpMessage(lead, followUpCount);
    const result = await sendWhatsappText(lead.phone, message);
    if (!result.ok) continue;

    const nowIso = new Date(now).toISOString();
    lead.followUpCount = followUpCount + 1;
    lead.lastFollowUpAt = nowIso;
    lead.lastOutboundAt = nowIso;
    lead.updatedAt = nowIso;

    // El primer toque anuncia el video: va justo detrás del texto, si no se le mandó antes.
    if (!lead.mediaSentAt) {
      const r = await sendReinforcementMedia(redis, lead, lead.phone);
      if (r.sent + r.failed > 0) lead.mediaSentAt = nowIso;
    }

    await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
    await appendHistory(redis, lead.id, [{ role: 'assistant', content: message }]);
    sent++;
  }

  // --- Recordatorio de cita: la tarde anterior a la fecha preferida (4 a 8 pm Colombia) ---
  // Al cliente se le escribe solo si sigue abierta la ventana de 24 h de Meta (texto libre);
  // a la sucursal se le avisa siempre.
  const colombiaHour = (new Date().getUTCHours() - 5 + 24) % 24;
  const manana = addDaysToDateString(todayInColombia(), 1);
  if (colombiaHour >= 16 && colombiaHour < 20) {
    for (const lead of leads) {
      if (outOfTime()) break;
      if (lead.aiStage !== 'entregado' || lead.installed || lead.optOut || lead.status === 'Perdido') continue;
      if (lead.aiPreferredDate !== manana || lead.appointmentReminderAt) continue;
      const nowIso = new Date().toISOString();
      const branch = lead.convertedBranch || branchForCityName(lead.city) || '';
      const hoursSinceInbound = lead.lastInboundAt ? (now - new Date(lead.lastInboundAt).getTime()) / 3600000 : Infinity;
      let clientNote = 'fuera de la ventana de 24 h de WhatsApp, no se le pudo escribir';
      if (hoursSinceInbound < MAX_HOURS_SINCE_LAST_INBOUND) {
        const msg = `Hola 😊 Te escribo para recordarte que mañana es la fecha que elegiste para instalar el GPS${branch ? ' con nuestra sucursal de ' + spokenBranchName(branch) : ''} 🚗🔒 ¿Me confirmas que sigue en pie y a qué hora te queda mejor? Así te dejamos todo listo.`;
        const result = await sendWhatsappText(lead.phone, msg);
        if (result.ok) {
          lead.lastOutboundAt = nowIso;
          await appendHistory(redis, lead.id, [{ role: 'assistant', content: msg }]);
          clientNote = 'se le mandó el recordatorio por WhatsApp';
          recordatorios++;
        } else {
          clientNote = 'Meta rechazó el recordatorio: ' + (result.error || 'error');
        }
      }
      lead.appointmentReminderAt = nowIso;
      lead.updatedAt = nowIso;
      lead.notes = [{ text: `[Sistema] Recordatorio de cita para mañana (${lead.aiPreferredDate}): ${clientNote}.`, date: nowIso }, ...lead.notes];
      await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
      await notifyBranchStaff(redis, branch, `📅 Mañana (${lead.aiPreferredDate}) es la fecha preferida de ${lead.name} (${lead.city}) para instalar. ${clientNote.charAt(0).toUpperCase() + clientNote.slice(1)}. Confírmale hora y técnico.`, `cita-manana:${lead.id}`);
    }
  }

  // --- Entregado hace más de 2 h y nadie de la sucursal lo ha tocado: aviso una sola vez ---
  for (const lead of leads) {
    if (outOfTime()) break;
    if (lead.aiStage !== 'entregado' || !lead.aiHandoffAt || lead.handoffNudgeAt || lead.managerAckAt) continue;
    if (lead.installed || lead.status !== 'Concretado por el agente') continue;
    const hoursSinceHandoff = (now - new Date(lead.aiHandoffAt).getTime()) / 3600000;
    if (hoursSinceHandoff < HANDOFF_NUDGE_HOURS || hoursSinceHandoff > 48) continue;
    const handoffAt = lead.aiHandoffAt;
    const humanTouched = (lead.notes || []).some((n) => n.date > handoffAt && !/^\[(Agente IA|Sistema|GaBot|Plantilla)/.test(n.text));
    if (humanTouched) continue;
    const nowIso = new Date().toISOString();
    lead.handoffNudgeAt = nowIso;
    await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
    const branch = lead.convertedBranch || branchForCityName(lead.city) || '';
    await notifyBranchStaff(redis, branch, `⏰ Hace ${Math.round(hoursSinceHandoff)} h Andrés entregó a ${lead.name} (${lead.city})${lead.scheduledInstallDate ? ' — fecha preferida: ' + lead.scheduledInstallDate : ''} y en el CRM nadie lo ha contactado. Llámalo y déjale una nota.`, `entrega-sin-contacto:${lead.id}`);
    avisos++;
  }

  await markCronOk(redis, 'whatsapp-followup');
  } finally {
    await redis.del('internal:followup-lock').catch(() => {});
  }
  return new Response(JSON.stringify({ ok: true, sent, retried, recordatorios, avisos }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
