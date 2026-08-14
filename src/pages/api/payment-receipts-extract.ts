import type { APIRoute } from 'astro';
import { SESSION_COOKIE, getSession, canAccessPagos, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB
const MODEL = 'claude-haiku-4-5-20251001';
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessPagos(session)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'lectura automática no configurada' }), { status: 503 });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return new Response(JSON.stringify({ error: 'invalid content-type' }), { status: 400 });
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return new Response(JSON.stringify({ error: 'falta la imagen' }), { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return new Response(JSON.stringify({ error: 'la imagen debe pesar menos de 4MB' }), { status: 400 });
  }
  if (!SUPPORTED_TYPES.includes(file.type)) {
    // Formato que el lector no soporta (ej. HEIC): se guarda igual, solo no se autocompleta.
    return new Response(JSON.stringify({ amount: null, paymentDate: null, payerName: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString('base64');
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Este es un comprobante de pago/transferencia de un banco colombiano. Lee la imagen y responde SOLO con un objeto JSON, sin texto adicional ni markdown, con este formato exacto:
{"amount": <monto pagado, número entero en pesos colombianos sin puntos ni símbolos, o null si no se puede leer con confianza>, "paymentDate": "<fecha del pago en formato YYYY-MM-DD, o null si no se puede leer>", "payerName": "<nombre de quien envía/paga tal como aparece, o null si no aparece>"}
Si el comprobante no muestra el año, asume el año actual (hoy es ${today}). Si no logras leer un dato con confianza, usa null en ese campo en vez de adivinar.`;

  let aiResponse: Response;
  try {
    aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: file.type, data: base64 } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
  } catch {
    return new Response(JSON.stringify({ error: 'no se pudo contactar el servicio de lectura' }), { status: 502 });
  }

  if (!aiResponse.ok) {
    return new Response(JSON.stringify({ error: 'el servicio de lectura no pudo procesar la imagen' }), { status: 502 });
  }

  let data: any;
  try {
    data = await aiResponse.json();
  } catch {
    return new Response(JSON.stringify({ error: 'respuesta inválida del servicio de lectura' }), { status: 502 });
  }

  const text: string = data?.content?.[0]?.text || '';
  let parsed: { amount?: unknown; paymentDate?: unknown; payerName?: unknown } = {};
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    parsed = {};
  }

  const amountNum = Number(parsed.amount);
  const amount = Number.isFinite(amountNum) && amountNum > 0 ? Math.round(amountNum) : null;
  const paymentDate = typeof parsed.paymentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.paymentDate) ? parsed.paymentDate : null;
  const payerName = typeof parsed.payerName === 'string' ? parsed.payerName.trim().slice(0, 120) : null;

  return new Response(JSON.stringify({ amount, paymentDate, payerName }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
