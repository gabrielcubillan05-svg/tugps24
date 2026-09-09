import { createHmac, timingSafeEqual } from 'node:crypto';

const GRAPH_VERSION = 'v21.0';

export function verifyMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = import.meta.env.META_APP_SECRET;
  if (!appSecret || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const providedHex = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(providedHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function sendWhatsappText(to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  // Reusa el token de Meta ya configurado para Lead Ads si no hay uno específico de WhatsApp
  // (un mismo token de Usuario del Sistema puede tener ambos permisos a la vez).
  const token = import.meta.env.META_WHATSAPP_TOKEN || import.meta.env.META_PAGE_ACCESS_TOKEN;
  const phoneNumberId = import.meta.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { ok: false, error: 'WhatsApp no configurado (falta META_PHONE_NUMBER_ID o el token)' };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `Meta respondió ${res.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendWhatsappMedia(
  to: string,
  type: 'image' | 'video',
  link: string,
  caption?: string
): Promise<{ ok: boolean; error?: string }> {
  const token = import.meta.env.META_WHATSAPP_TOKEN || import.meta.env.META_PAGE_ACCESS_TOKEN;
  const phoneNumberId = import.meta.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { ok: false, error: 'WhatsApp no configurado (falta META_PHONE_NUMBER_ID o el token)' };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type,
        [type]: caption ? { link, caption } : { link },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `Meta respondió ${res.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Manda una plantilla aprobada por Meta — necesaria para escribirle primero a alguien
// que no nos ha escrito en las últimas 24h (ej. un recordatorio de cobranza).
export async function sendWhatsappTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[]
): Promise<{ ok: boolean; error?: string }> {
  const token = import.meta.env.META_WHATSAPP_TOKEN || import.meta.env.META_PAGE_ACCESS_TOKEN;
  const phoneNumberId = import.meta.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { ok: false, error: 'WhatsApp no configurado (falta META_PHONE_NUMBER_ID o el token)' };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: bodyParams.length
            ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
            : [],
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `Meta respondió ${res.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
