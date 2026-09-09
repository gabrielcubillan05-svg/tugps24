const MODEL = 'claude-sonnet-5';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  at?: string;
}

export interface AgentToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface AgentResult {
  reply: string | null;
  toolCalls: AgentToolCall[];
}

const TOOLS = [
  {
    name: 'registrar_acuerdo_pago',
    description:
      'Llamar cuando el cliente acepte un plan concreto para ponerse al día (fecha de pago, o pago en cuotas). No es un pago confirmado, es un compromiso a verificar.',
    input_schema: {
      type: 'object',
      properties: {
        resumen: { type: 'string', description: 'Resumen del acuerdo: monto, fecha(s), si es en cuotas' },
      },
      required: ['resumen'],
    },
  },
  {
    name: 'registrar_pago_reportado',
    description: 'Llamar cuando el cliente diga que YA pagó, para que tesorería lo verifique — no confirmes tú que quedó al día.',
    input_schema: {
      type: 'object',
      properties: {
        detalle: { type: 'string', description: 'Lo que dijo el cliente sobre el pago (fecha, monto, medio)' },
      },
      required: ['detalle'],
    },
  },
  {
    name: 'escalar_urgente',
    description:
      'Llamar de inmediato si el cliente disputa la deuda por completo, se molesta, amenaza, o pide hablar con una persona.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Por qué se está escalando' } },
      required: ['motivo'],
    },
  },
];

function buildSystemPrompt(nombre: string, deuda: number, facturasImpagas: number): string {
  const deudaFmt = '$' + Math.round(deuda).toLocaleString('es-CO');
  return `Eres Valentina, encargada de cobranza de TuGPS24 (empresa colombiana de GPS para vehículos). Le escribes por WhatsApp a ${nombre}, quien tiene un saldo pendiente de ${deudaFmt}${facturasImpagas ? ` (${facturasImpagas} factura(s) sin pagar)` : ''} por el servicio de monitoreo. NUNCA digas que eres una inteligencia artificial ni un bot — eres una persona real del equipo de cartera.

## Objetivo
Que el cliente se ponga al día. No solo exijas el pago — sé una excelente cobradora: firme, insistente, profesional, pero también dispuesta a buscar un acuerdo de pago razonable (una fecha concreta, o cuotas) si el cliente no puede pagar todo de una vez. Prioriza llegar a un compromiso concreto (fecha o plan) antes que solo repetir el monto.

## Tono
Serio pero respetuoso, sin sonar amenazante ni agresivo. No imites el lenguaje coloquial o informal del cliente. Sé directa: no dejes la conversación en el aire, siempre busca cerrar con una fecha o un siguiente paso concreto.

## Formato
Texto plano, sin asteriscos ni markdown. Mensajes cortos, como WhatsApp real.

## Qué SÍ puedes hacer
- Proponer que pague en 2 o 3 cuotas si el cliente dice que no puede pagar todo de una vez, y pedirle fechas concretas para cada cuota.
- Preguntar el motivo del atraso brevemente (sin sonar interrogatorio) para ofrecer la solución adecuada.
- Recordar que el servicio de monitoreo se puede ver afectado (suspensión) si la deuda sigue sin resolverse — sin ser la primera línea del mensaje, solo si hace falta motivar.

## Límites estrictos
- NUNCA confirmes tú que una deuda quedó pagada o en cero — eso lo verifica tesorería. Si el cliente dice que ya pagó, usa registrar_pago_reportado y dile que en breve lo confirman.
- NUNCA ofrezcas condonar o descontar la deuda por tu cuenta.
- En cuanto el cliente acepte una fecha concreta de pago (aunque sea parcial), usa registrar_acuerdo_pago con el resumen.
- Si el cliente disputa la deuda, se molesta, o pide hablar con una persona: usa escalar_urgente de inmediato y avisa que en un momento lo contacta alguien del equipo.
- SIEMPRE responde con un mensaje de texto para el cliente, incluso cuando uses una herramienta.`;
}

async function callAnthropic(apiKey: string, messages: unknown[], systemPrompt: string): Promise<any | null> {
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        tools: TOOLS,
      }),
    });
  } catch (err) {
    console.error('collections-agent: fetch failed', err instanceof Error ? err.message : String(err));
    return null;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('collections-agent: Anthropic respondió', res.status, detail.slice(0, 500));
    return null;
  }

  try {
    return await res.json();
  } catch (err) {
    console.error('collections-agent: respuesta inválida', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function extractReplyAndTools(data: any): { reply: string; toolCalls: AgentToolCall[] } {
  let reply = '';
  const toolCalls: AgentToolCall[] = [];
  for (const block of data?.content || []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      reply += block.text;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push({ name: block.name, input: block.input || {} });
    }
  }
  return { reply: reply.trim(), toolCalls };
}

export async function runCollectionsAgent(
  history: AgentMessage[],
  newMessage: string,
  ctx: { nombre: string; deuda: number; facturasImpagas: number }
): Promise<AgentResult> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { reply: null, toolCalls: [] };
  }

  const systemPrompt = buildSystemPrompt(ctx.nombre, ctx.deuda, ctx.facturasImpagas);
  // Claude no acepta campos extra en los mensajes — se manda solo role/content, la hora
  // (history[].at) es solo para el visor interno.
  const messages: any[] = [...history.map(({ role, content }) => ({ role, content })), { role: 'user', content: newMessage }];

  const data = await callAnthropic(apiKey, messages, systemPrompt);
  if (!data) {
    return { reply: null, toolCalls: [] };
  }

  const first = extractReplyAndTools(data);

  if (!first.reply && first.toolCalls.length && data.content?.some((b: any) => b.type === 'tool_use')) {
    const toolResults = data.content
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => ({ type: 'tool_result', tool_use_id: b.id, content: 'Registrado.' }));

    const followUpMessages = [
      ...messages,
      { role: 'assistant', content: data.content },
      { role: 'user', content: toolResults },
    ];

    const followUpData = await callAnthropic(apiKey, followUpMessages, systemPrompt);
    if (followUpData) {
      const second = extractReplyAndTools(followUpData);
      if (second.reply) {
        return { reply: second.reply, toolCalls: [...first.toolCalls, ...second.toolCalls] };
      }
    }
  }

  return { reply: first.reply || null, toolCalls: first.toolCalls };
}
