import { sendWhatsappTemplate, sendWhatsappText } from './whatsapp';
import { logAudit } from './audit';
import { getUsers, branchesOf, type User } from './auth';
import { readProfiles } from '../pages/api/employees';
import { normalizePhone, type Lead } from '../pages/api/leads';

// Aviso por WhatsApp a las secretarias y gerentes de la sucursal cuando Andrés concreta una
// venta. La campanita, el push y el chat de GPSITO solo se ven con el panel abierto; de noche o
// en la calle el concretado se quedaba horas sin que nadie lo llamara. Como el empleado no le
// ha escrito al número de la empresa, Meta exige una plantilla aprobada (no texto libre).
//
// La plantilla se registra en Meta Business Manager (categoría Utilidad, idioma Español COL) con
// cinco variables: {{1}} nombre del empleado, {{2}} cliente y teléfono, {{3}} ciudad,
// {{4}} fecha preferida, {{5}} resumen de Andrés.
const TEMPLATE_NAME = import.meta.env.META_TEMPLATE_LEAD_CONCRETADO || 'lead_concretado';
// Desde el 14-oct-2026 Meta respondía 132001 ("does not exist in es_CO") y ningún concretado le
// llegaba a la sucursal: la plantilla no estaba aprobada en Español COL. Se prueba primero el
// idioma configurado y, si Meta dice que no existe en ese idioma, los otros españoles en que
// pudo quedar aprobada.
const TEMPLATE_LANGUAGES = [
  import.meta.env.META_TEMPLATE_LEAD_CONCRETADO_LANG || 'es_CO',
  'es',
  'es_ES',
  'es_MX',
].filter((l, i, arr) => arr.indexOf(l) === i);
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

async function sendHandoffTemplate(phone: string, params: string[], textoPlano: string): Promise<{ ok: boolean; error?: string }> {
  let last: { ok: boolean; error?: string } = { ok: false };
  for (const lang of TEMPLATE_LANGUAGES) {
    last = await sendWhatsappTemplate(phone, TEMPLATE_NAME, lang, params);
    if (last.ok || !String(last.error || '').includes('132001')) return last;
  }
  // La plantilla no existe en ningún idioma: el texto libre solo entra si el empleado le escribió
  // a la empresa en las últimas 24 h, pero es mejor que dejar el concretado sin aviso.
  const texto = await sendWhatsappText(phone, textoPlano);
  return texto.ok ? texto : last;
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
    // Todas las secretarias y todos los gerentes de la sucursal, no solo el primero de cada rol:
    // en sucursales con dos secretarias el concretado le llegaba a una sola y la otra no se enteraba.
    const destinatarios = staff.filter((u) => u.role === 'secretaria' || u.role === 'gerente');
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
      const res = await sendHandoffTemplate(
        phone,
        [firstName(person), cliente, ciudad, fecha, resumen],
        `Hola ${firstName(person)}, Andrés concretó una venta: ${cliente}, ${ciudad}. Fecha preferida: ${fecha}. ${resumen} Revisa el panel y contáctalo hoy.`
      );
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
