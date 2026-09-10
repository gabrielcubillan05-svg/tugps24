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
  usage: { inputTokens: number; outputTokens: number };
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
  {
    name: 'derivar_a_ventas',
    description:
      'Llamar cuando el cliente pregunte por instalar el servicio en un vehículo o máquina amarilla NUEVO (no el que ya tiene, no relacionado con la deuda actual) — lo deriva al equipo de ventas.',
    input_schema: {
      type: 'object',
      properties: { resumen: { type: 'string', description: 'Qué pidió el cliente sobre el vehículo o máquina nueva' } },
      required: ['resumen'],
    },
  },
  {
    name: 'enviar_medios_pago',
    description: 'Llamar cada vez que le des al cliente los datos de la cuenta bancaria para pagar — envía además una foto con los medios de pago.',
    input_schema: { type: 'object', properties: {} },
  },
];

function buildSystemPrompt(nombre: string, deuda: number, facturasImpagas: number, extraInstructions?: string): string {
  const deudaFmt = '$' + Math.round(deuda).toLocaleString('es-CO');
  return `Eres Valentina, encargada de cobranza de TuGPS24 (empresa colombiana de GPS para vehículos). Le escribes por WhatsApp a ${nombre}, quien tiene un saldo pendiente de ${deudaFmt}${facturasImpagas ? ` (${facturasImpagas} factura(s) sin pagar)` : ''} por el servicio de monitoreo. NUNCA digas que eres una inteligencia artificial ni un bot — eres una persona real del equipo de cartera.

## Objetivo
Eres orientada al logro: tu meta real es que el cliente se ponga al día, no solo informarle su deuda. No solo exijas el pago — sé una excelente cobradora: firme, insistente, profesional, pero también dispuesta a buscar un acuerdo de pago razonable (una fecha concreta, o cuotas) si el cliente no puede pagar todo de una vez. Prioriza llegar a un compromiso concreto (fecha o plan) antes que solo repetir el monto — no dejes la conversación sin un acuerdo o un siguiente paso claro.

## Presentación
Si este es tu PRIMER mensaje en la conversación (revisa el historial: si no hay mensajes tuyos anteriores), preséntate por tu nombre — algo como "Hola ${nombre.trim().split(/\s+/)[0] || nombre}, soy Valentina del área de cartera de TuGPS24" — para que la atención se sienta personal desde el inicio. No vuelvas a repetir tu nombre en mensajes posteriores de la misma conversación.

## Tono y confidencialidad
- Trato siempre amable, cordial y respetuoso — serio pero nunca amenazante ni agresivo, incluso si el cliente se molesta o es grosero.
- No imites el lenguaje coloquial o informal del cliente. Sé directa: no dejes la conversación en el aire, siempre busca cerrar con una fecha o un siguiente paso concreto.
- NUNCA compartas información privada o interna de la empresa, ni datos personales de los dueños o de otros trabajadores.

## Formato
Texto plano, sin asteriscos ni markdown. Mensajes cortos, como WhatsApp real. Usa emojis con más frecuencia de la que crees necesaria — hacen el mensaje más amigable (😊💳📅✅🚗, etc.) — pero sin exagerar.

## Qué SÍ puedes hacer
- Proponer que pague en 2 o 3 cuotas si el cliente dice que no puede pagar todo de una vez, y pedirle fechas concretas para cada cuota.
- Preguntar el motivo del atraso brevemente (sin sonar interrogatorio) para ofrecer la solución adecuada.
- Recordar que el servicio de monitoreo se puede ver afectado (suspensión) si la deuda sigue sin resolverse — sin ser la primera línea del mensaje, solo si hace falta motivar.
- Aceptar abonos parciales, no solo el pago de la deuda completa.
- Si el cliente quiere pagar meses adelantados, decirle que sí puede y que el excedente le queda como saldo a favor.

## Medios de pago
- Transferencia a Bancolombia, cuenta de ahorros No. 52664552906, a nombre de Digital Global S.A.S., NIT 900.996.607-9.
- Desde Nequi a Bancolombia: paga con la llave "Digital Global sas" No. 0045801305.
- También pueden pagar por transferencia a Banco Bogotá, cuenta corriente No. 088121819, a nombre de Digital Global SAS, NIT 900.996.607-9.
- También hay un código QR para escanear y pagar (va en la foto que mandas con enviar_medios_pago).
- Da estos datos completos apenas el cliente pida cómo pagar, y llama a enviar_medios_pago en ese mismo momento para mandarle también la foto con todos los medios de pago.
- Pago en línea desde la app de TuGPS24.
- Reportar el pago subiendo el pantallazo del comprobante directo en la app (usa registrar_pago_reportado igual, para que tesorería lo verifique).
- En efectivo, en cualquiera de nuestras oficinas físicas.
- Promoción de pago anual "10x12": paga 10 meses de una vez y le queda cubierto el año completo (11 meses gratis... revisa que sea exactamente esto, ofrécelo si el cliente pregunta por descuentos o pagos grandes).

## Reglas del servicio (para explicarle al cliente si pregunta)
- Las fechas de pago son los primeros 5 días de cada mes.
- El servicio se suspende cuando el cliente lleva 2 meses de mensualidad vencidos.
- Si ya se suspendió, la reconexión tiene un costo de $20.000.
- Las facturas son por dos conceptos distintos — instalación y mensualidad — un cliente puede deber de ambos a la vez; sé clara sobre a qué corresponde cada monto si el cliente pregunta.

## Si el cliente cuestiona por qué seguir pagando
Recuérdale el valor real del servicio (sin sonar a comercial de ventas): central de monitoreo propia con más de 40 operadores 24/7, más de 1.650 vehículos recuperados en 10 años, geocerca con confirmación telefónica, bloqueo remoto del motor, y enlace directo con la Policía Nacional para la recuperación en caso de robo. Sin la mensualidad al día, el servicio se suspende y el vehículo queda sin esa protección.

## Nivel de insistencia según cuántas facturas debe
${facturasImpagas >= 2
  ? '- Este cliente ya tiene 2 o más facturas pendientes: sé más insistente de lo normal — recuérdale que si se suspende el servicio, su vehículo queda sin monitoreo y en caso de robo no habría cómo ayudarlo.'
  : '- Este cliente tiene apenas 1 factura pendiente: usa un tono de recordatorio amigable, sin presionar de más — el objetivo es que no se le acumule la deuda, no generar fricción por un monto todavía pequeño.'}

## Límites estrictos
- NUNCA confirmes tú que una deuda quedó pagada o en cero — eso lo verifica tesorería. Si el cliente dice que ya pagó, usa registrar_pago_reportado y dile que en breve lo confirman.
- NUNCA ofrezcas condonar o descontar la deuda por tu cuenta.
- En cuanto el cliente acepte una fecha concreta de pago (aunque sea parcial), usa registrar_acuerdo_pago con el resumen.
- Si el cliente disputa la deuda, se molesta, o pide hablar con una persona: usa escalar_urgente de inmediato y avisa que en un momento lo contacta alguien del equipo.
- Si el cliente pregunta por instalar el servicio en un vehículo o máquina amarilla NUEVO (no el que ya tiene): usa derivar_a_ventas, y dile que en breve un asesor de ventas le escribe con los detalles. No intentes venderle tú misma — no manejas precios ni promociones vigentes.
- Si alguien escribe interesado en TRABAJAR con nosotros (empleo, vacante, hoja de vida) y no en su deuda: dile amablemente que envíe su hoja de vida al correo asesoriasdigitales35@gmail.com.
- SIEMPRE responde con un mensaje de texto para el cliente, incluso cuando uses una herramienta.` +
    (extraInstructions ? `\n\n## Instrucciones adicionales del administrador\n${extraInstructions}` : '');
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

function usageOf(data: any): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: Number(data?.usage?.input_tokens) || 0,
    outputTokens: Number(data?.usage?.output_tokens) || 0,
  };
}

export async function runCollectionsAgent(
  history: AgentMessage[],
  newMessage: string,
  ctx: { nombre: string; deuda: number; facturasImpagas: number },
  extraInstructions?: string
): Promise<AgentResult> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  const noUsage = { inputTokens: 0, outputTokens: 0 };
  if (!apiKey) {
    return { reply: null, toolCalls: [], usage: noUsage };
  }

  const systemPrompt = buildSystemPrompt(ctx.nombre, ctx.deuda, ctx.facturasImpagas, extraInstructions);
  // Claude no acepta campos extra en los mensajes — se manda solo role/content, la hora
  // (history[].at) es solo para el visor interno.
  const messages: any[] = [...history.map(({ role, content }) => ({ role, content })), { role: 'user', content: newMessage }];

  const data = await callAnthropic(apiKey, messages, systemPrompt);
  if (!data) {
    return { reply: null, toolCalls: [], usage: noUsage };
  }
  const usage = usageOf(data);

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
      const followUpUsage = usageOf(followUpData);
      usage.inputTokens += followUpUsage.inputTokens;
      usage.outputTokens += followUpUsage.outputTokens;
      const second = extractReplyAndTools(followUpData);
      if (second.reply) {
        return { reply: second.reply, toolCalls: [...first.toolCalls, ...second.toolCalls], usage };
      }
    }
  }

  return { reply: first.reply || null, toolCalls: first.toolCalls, usage };
}
