import { sendWhatsappTemplate } from './whatsapp';
import { logAudit } from './audit';
import { getUsers, branchesOf, type User } from './auth';
import { readProfiles } from '../pages/api/employees';
import { normalizePhone, type Lead } from '../pages/api/leads';

// Aviso por WhatsApp a la secretaria y al gerente de la sucursal cuando Andrés concreta una
// venta. La campanita, el push y el chat de GPSITO solo se ven con el panel abierto; de noche o
// en la calle el concretado se quedaba horas sin que nadie lo llamara. Como el empleado no le
// ha escrito al número de la empresa, Meta exige una plantilla aprobada (no texto libre).
//
// La plantilla se registra en Meta Business Manager (categoría Utilidad, idioma Español COL) con
// cinco variables: {{1}} nombre del empleado, {{2}} cliente y teléfono, {{3}} ciudad,
// {{4}} fecha preferida, {{5}} resumen de Andrés.
const TEMPLATE_NAME = import.meta.env.META_TEMPLATE_LEAD_CONCRETADO || 'lead_concretado';
const TEMPLATE_LANGUAGE = 'es_CO';
// Meta rechaza el envío si el cuerpo supera 1024 caracteres contando las variables; el resumen es
// la única parte que puede crecer sin control.
const MAX_RESUMEN = 300;

export interface HandoffWhatsappResult {
  sent: string[];
  failed: string[];
  // Secretaria/gerente activos de la sucursal sin celular en su ficha de RR.HH.
  sinCelular: string[];
}

// Meta no acepta saltos de línea, tabulaciones ni más de 4 espacios seguidos dentro de una variable.
function templateParam(value: string, fallback: string, max = 120): string {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function firstName(user: User): string {
  return String(user.name || user.username).trim().split(/\s+/)[0] || 'equipo';
}

export async function notifyHandoffByWhatsapp(
  redis: any,
  lead: Lead,
  branch: string,
  opts: { canal: 'WhatsApp' | 'chat web'; fechaPreferida?: string | null; resumen: string }
): Promise<HandoffWhatsappResult> {
  const result: HandoffWhatsappResult = { sent: [], failed: [], sinCelular: [] };
  try {
    const staff = (await getUsers(redis)).filter((u) => u.active && branchesOf(u).includes(branch));
    const secretaria = staff.find((u) => u.role === 'secretaria');
    const gerente = staff.find((u) => u.role === 'gerente');
    const destinatarios = [secretaria, gerente].filter((u, i, arr): u is User => !!u && arr.indexOf(u) === i);
    if (!destinatarios.length) return result;

    const profiles = await readProfiles(redis);
    const cliente = templateParam(`${lead.name}${lead.phone ? ` (${lead.phone})` : ''}`, 'cliente sin nombre');
    const ciudad = templateParam(lead.city || branch, branch || 'tu sucursal', 60);
    const fecha = templateParam(opts.fechaPreferida || '', 'sin fecha definida', 60);
    const resumen = templateParam(opts.resumen, 'Sin resumen.', MAX_RESUMEN);
    const now = new Date().toISOString();

    for (const person of destinatarios) {
      const phone = normalizePhone(profiles[person.id]?.telefono || '');
      // 57 + 10 dígitos; un fijo o un número a medias haría fallar el envío contra Meta.
      if (phone.length < 12) {
        result.sinCelular.push(person.name);
        continue;
      }
      const res = await sendWhatsappTemplate(phone, TEMPLATE_NAME, TEMPLATE_LANGUAGE, [
        firstName(person),
        cliente,
        ciudad,
        fecha,
        resumen,
      ]);
      if (res.ok) result.sent.push(person.name);
      else result.failed.push(`${person.name} (${res.error || 'error desconocido'})`);
    }

    const partes: string[] = [];
    if (result.sent.length) partes.push(`enviado a ${result.sent.join(' y ')}`);
    if (result.failed.length) partes.push(`falló para ${result.failed.join('; ')}`);
    if (result.sinCelular.length) partes.push(`${result.sinCelular.join(' y ')} sin celular en RR.HH.`);
    if (partes.length) {
      lead.notes = [{ text: `[Sistema] Aviso por WhatsApp del concretado (${opts.canal}): ${partes.join(' · ')}.`, date: now }, ...(lead.notes || [])];
    }
    await logAudit(
      redis,
      { userId: 'sistema', username: 'andres' },
      'lead_handoff_whatsapp',
      lead.name,
      JSON.stringify({ leadId: lead.id, branch, sent: result.sent, failed: result.failed, sinCelular: result.sinCelular })
    );
  } catch {
    // El aviso nunca debe tumbar el procesamiento del mensaje del cliente.
  }
  return result;
}
