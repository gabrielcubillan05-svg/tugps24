import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { sendWhatsappText, isQuietHoursColombia } from '../../lib/whatsapp';
import { readLeads, writeLeads, type Lead } from './leads';
import { appendHistory } from './whatsapp-webhook';
import { SESSION_COOKIE, getSession, canManageAiAgents, verifySameOrigin } from '../../lib/auth';
import { activeInstallPromos, branchForCityName, promoUntilLabel, spokenBranchName, INSTALACION_UNIT, type InstallPromo } from '../../lib/pricing';

export const prerender = false;

// Meta solo permite texto libre dentro de las 24 h siguientes al último mensaje del cliente;
// se deja margen para no pisar el límite.
const WINDOW_HOURS = 23;

function money(n: number): string {
  return '$' + n.toLocaleString('es-CO');
}

function servicingBranchOf(lead: Lead): string | null {
  return lead.convertedBranch || branchForCityName(lead.city);
}

export function buildPromoNotice(lead: Lead, branch: string, promo: InstallPromo): string {
  const firstName = (lead.name || '').trim().split(/\s+/)[0];
  const greeting = firstName && firstName !== lead.phone ? `Hola ${firstName}` : 'Hola';
  return `${greeting}, te escribo de nuevo de TuGPS24 😊 Quiero corregirte algo importante: en ${spokenBranchName(branch)} tenemos la ${promo.label.toLowerCase()} y el equipo con instalación te queda en ${money(promo.price)}, no en ${money(INSTALACION_UNIT)} como te había indicado. Es válida hasta el ${promoUntilLabel(promo)} 📍 ¿Te gustaría que te agendemos la instalación?`;
}

// Acción manual de admin: cuando una promoción por sucursal entra después de que Andrés ya
// atendió clientes con el precio anterior, les manda un aviso corrigiendo el precio. Solo a
// quienes escribieron en las últimas 24 h (texto libre); los demás se devuelven en una lista
// para que la sucursal los contacte a mano.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageAiAgents(session)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { dryRun?: boolean; since?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const dryRun = body.dryRun !== false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.since || ''))) {
    return new Response(JSON.stringify({ error: 'fecha "desde" inválida' }), { status: 400 });
  }
  const sinceIso = `${body.since}T00:00:00-05:00`;

  const promos = activeInstallPromos();
  if (!promos.length) {
    return new Response(JSON.stringify({ error: 'no hay ninguna promoción de instalación vigente' }), { status: 400 });
  }

  if (!dryRun && isQuietHoursColombia()) {
    return new Response(JSON.stringify({ ok: true, dryRun, reason: 'quiet-hours', sent: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const now = Date.now();
  const leads = await readLeads(redis);
  const toSend: { lead: Lead; branch: string; promo: InstallPromo }[] = [];
  const outOfWindow: { name: string; phone: string; branch: string; secretary: string }[] = [];
  let alreadyNotified = 0;

  for (const lead of leads) {
    if (lead.source !== 'whatsapp-ads') continue;
    if (lead.installed || lead.status === 'Instalado' || lead.status === 'Perdido') continue;
    const branch = servicingBranchOf(lead);
    if (!branch) continue;
    const promo = promos.find((p) => p.branches.includes(branch));
    if (!promo) continue;
    // Se compara por instante, no por texto: los ISO vienen en zonas distintas (Z vs -05:00).
    const sinceMs = Date.parse(sinceIso);
    const contactedSince = Date.parse(lead.createdAt) >= sinceMs || (!!lead.lastInboundAt && Date.parse(lead.lastInboundAt) >= sinceMs);
    if (!contactedSince) continue;
    if (lead.promoNoticeSentAt) {
      alreadyNotified++;
      continue;
    }
    const inWindow = !!lead.lastInboundAt && now - new Date(lead.lastInboundAt).getTime() < WINDOW_HOURS * 3600000;
    if (!inWindow) {
      outOfWindow.push({ name: lead.name, phone: lead.phone, branch, secretary: lead.secretary || '' });
      continue;
    }
    toSend.push({ lead, branch, promo });
  }

  let sent = 0;
  let failed = 0;
  const failures: string[] = [];
  if (!dryRun) {
    for (const { lead, branch, promo } of toSend) {
      const message = buildPromoNotice(lead, branch, promo);
      const result = await sendWhatsappText(lead.phone, message);
      if (!result.ok) {
        failed++;
        failures.push(`${lead.name}: ${result.error || 'error'}`);
        continue;
      }
      const nowIso = new Date().toISOString();
      lead.promoNoticeSentAt = nowIso;
      lead.lastOutboundAt = nowIso;
      lead.updatedAt = nowIso;
      lead.notes = [{ text: `[Agente IA] Aviso de ${promo.label.toLowerCase()}: instalación a ${money(promo.price)}`, date: nowIso }, ...(lead.notes || [])];
      await writeLeads(redis, { [lead.id]: JSON.stringify(lead) });
      // Queda en el historial para que Andrés sepa que ya le corrigió el precio si el cliente responde.
      await appendHistory(redis, lead.id, [{ role: 'assistant', content: message }]);
      sent++;
    }
    await logAudit(redis, session, 'whatsapp_promo_notice', `${sent} enviados desde ${body.since}`, `${outOfWindow.length} fuera de ventana, ${failed} fallidos, ${alreadyNotified} ya avisados`);
  }

  const sample = toSend[0] ? buildPromoNotice(toSend[0].lead, toSend[0].branch, toSend[0].promo) : null;

  return new Response(
    JSON.stringify({
      ok: true,
      dryRun,
      promos: promos.map((p) => ({ label: p.label, branches: p.branches, price: p.price, until: promoUntilLabel(p) })),
      eligible: toSend.length,
      eligibleNames: toSend.slice(0, 50).map((t) => `${t.lead.name} (${t.branch})`),
      sent,
      failed,
      failures,
      alreadyNotified,
      outOfWindow,
      sampleMessage: sample,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};
