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
    return new Response(JSON.stringify({ amount: null, paymentDate: null, payerName: null, reference: null, mismatch: false }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString('base64');
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Esta imagen puede ser una de estas dos cosas:
1. Una foto simple de un comprobante de transferencia bancaria (banco, monto, fecha, destinatario).
2. Una captura de pantalla del sistema Optimus que muestra el registro interno de un pago (con campos como "Cliente", "Número", "Montos: Total/Aplicado/Pendiente") y que además incluye, dentro de la misma imagen, la foto del comprobante bancario real de esa transferencia (con su propio monto, fecha, banco y número de referencia).

Lee la imagen y responde SOLO con un objeto JSON, sin texto adicional ni markdown, con este formato exacto:
{"amount": <el monto que de verdad se transfirió según el comprobante bancario — NO el "Total" de Optimus si son distintos — número entero en pesos colombianos sin puntos ni símbolos, o null si no se puede leer con confianza>, "paymentDate": "<fecha del pago en formato YYYY-MM-DD, o null si no se puede leer>", "payerName": "<si la imagen trae el campo "Cliente" de un registro de Optimus, usa ese nombre; si no, usa el nombre de quien envía/paga en el comprobante; o null si no aparece>", "reference": "<número de referencia/aprobación del comprobante bancario si aparece, o null>", "optimusAmount": <si la imagen muestra un registro de Optimus con un monto "Total" registrado, ese número entero; o null si la imagen no es de Optimus>}
Si el "optimusAmount" y el "amount" del comprobante no coinciden, repórtalos ambos tal cual los ves — no los ajustes ni asumas cuál es el correcto.
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
  let parsed: { amount?: unknown; paymentDate?: unknown; payerName?: unknown; reference?: unknown; optimusAmount?: unknown } = {};
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
  const reference = typeof parsed.reference === 'string' ? parsed.reference.trim().slice(0, 60) : null;
  const optimusAmountNum = Number(parsed.optimusAmount);
  const optimusAmount = Number.isFinite(optimusAmountNum) && optimusAmountNum > 0 ? Math.round(optimusAmountNum) : null;
  const mismatch = amount !== null && optimusAmount !== null && amount !== optimusAmount;

  return new Response(JSON.stringify({ amount, paymentDate, payerName, reference, optimusAmount, mismatch }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
