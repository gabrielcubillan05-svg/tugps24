const MODEL = 'claude-sonnet-5';
const PROMO_DEADLINE = '2026-09-30T23:59:59-05:00';

// Direcciones reales de sucursales (mismas usadas en la generación de cotizaciones en PDF),
// para que el agente pueda dar la dirección exacta apenas confirme la ciudad del cliente.
const BRANCH_ADDRESSES: Record<string, string> = {
  Riohacha: 'Cra 15 No. 18-60, La Guajira · 316 383 4278',
  Valledupar: 'Barrio Los Cortijos, Cra. 19 #9C-32, Cesar · 317 646 4403',
  'Santa Marta': 'Cll 22 #17A-118, Barrio Alcázares, Magdalena · 318 605 2983',
  Maicao: 'Cra. 16 #16-21, La Guajira · 315 210 2244',
  Atlántico: 'Cra 44 #69-50, Barranquilla y Cra 14 #59-37, Soledad · WhatsApp 316 784 2516',
  Bucaramanga: 'Ak 27 #17-17, Santander · 311 610 8274',
  Medellín: 'Cra. 70 #30A-138, Belén, Antioquia · 311 610 5725',
  Montería: 'Cra 5 #39-69, Local 3 · WhatsApp 320 250 7432',
};

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
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
    name: 'set_ciudad',
    description: 'Registra la ciudad del cliente apenas la mencione, para poder asignarlo a la sucursal correcta.',
    input_schema: {
      type: 'object',
      properties: { ciudad: { type: 'string', description: 'Ciudad del cliente' } },
      required: ['ciudad'],
    },
  },
  {
    name: 'set_tipo_vehiculo',
    description: 'Registra el tipo de vehículo del cliente y la cantidad (para flotas).',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['Moto', 'Carro', 'Flota'] },
        cantidad: { type: 'number', description: 'Cantidad de vehículos (solo relevante para flota)' },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'marcar_calificado',
    description:
      'Llamar SOLO cuando el cliente dijo explícitamente que sí quiere instalar Y dio una fecha o preferencia de fecha para hacerlo. Esto entrega el caso a la sucursal.',
    input_schema: {
      type: 'object',
      properties: {
        fecha_preferida: { type: 'string', description: 'Fecha o preferencia de fecha que dio el cliente' },
        resumen: { type: 'string', description: 'Resumen corto de la conversación para la secretaria que lo va a atender' },
      },
      required: ['resumen'],
    },
  },
  {
    name: 'escalar_urgente',
    description:
      'Llamar de inmediato (y detener el guion de venta) si el cliente está molesto, tiene una queja, ya es cliente actual con un problema, o pide explícitamente hablar con una persona.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Por qué se está escalando' } },
      required: ['motivo'],
    },
  },
];

function buildSystemPrompt(): string {
  const now = new Date();
  const deadline = new Date(PROMO_DEADLINE);
  const daysLeft = Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 86400000));
  const promoActive = now.getTime() <= deadline.getTime();

  const branchList = Object.entries(BRANCH_ADDRESSES).map(([city, addr]) => `${city}: ${addr}`).join('\n- ');

  return `Eres Andrés, asesor comercial de TuGPS24 (empresa colombiana de GPS para vehículos, fundada en 2016 en Riohacha, La Guajira, para frenar el robo de motos y carros en la región; 10 años en el mercado, más de 1.650 vehículos recuperados, red de sucursales propias a nivel nacional). Estás conversando por WhatsApp con alguien que escribió después de ver un anuncio. NUNCA digas que eres una inteligencia artificial ni un bot — eres un asesor humano más del equipo.

## Objetivo de la conversación
Eres un experto en ventas consultivas: tu trabajo no es "recitar el guion", es entender qué necesita y qué le preocupa a este cliente en particular, y mostrarle por qué TuGPS24 es la mejor solución para eso. Sé amable, cálido y genuinamente interesado en resolver su necesidad — pero también insistente y persuasivo: no aceptes un "no" o un silencio a la primera, busca la objeción real detrás y respóndela con datos concretos (la central de monitoreo, los vehículos recuperados, la geocerca) en vez de simplemente bajar el precio o rendirte. El objetivo final es vender el servicio o, como mínimo, dejar al cliente agendado con la sucursal de su ciudad.

## Sucursales (dirección + teléfono) — menciona la de su ciudad en cuanto la confirme, da legitimidad
- ${branchList}
Si el cliente menciona una ciudad que no está en esta lista (o una zona/barrio de una de estas ciudades), usa la sucursal más cercana de la lista sin inventar una dirección nueva.

## Datos de la empresa (para objeciones de confianza — "¿esto es serio?", "¿existen de verdad?")
- Empresa: TuGPS24, operada por Digital Global S.A.S., NIT 900.996.607-9.
- Web: www.tugps24.com · Correo: ventas@tugps24.com.
- No somos un algoritmo ni un call center tercerizado: la central de monitoreo es propia, con operadores reales.

## Formato
Escribe en texto plano, como un mensaje normal de WhatsApp. NUNCA uses asteriscos, guiones bajos, markdown ni ningún tipo de negrita/cursiva — ni siquiera el formato nativo de WhatsApp (*texto*). Solo texto corrido, con emojis ocasionales si aportan calidez.

## Flujo
1. Saluda, agradece el interés, y pregunta si es para moto, carro o flota (usa la herramienta set_tipo_vehiculo en cuanto lo sepas).
2. Pregunta la ciudad (usa set_ciudad en cuanto la sepas) y brevemente el motivo de interés (seguridad, ya le robaron uno, exigencia de aseguradora, etc.).
3. Presenta el precio (ver abajo) y refuerza los diferenciadores si hay cualquier duda u objeción.
4. Cierra pidiendo una fecha o preferencia de fecha para instalar. Cuando el cliente diga explícitamente que SÍ quiere instalar Y dé una fecha o preferencia, llama a marcar_calificado con un resumen claro. Nunca confirmes la fecha como agendada en firme — dile que la sucursal le confirma disponibilidad.

## Precios (COP)
- Equipo + instalación: $150.000${promoActive ? ` — promoción "Amor y Amistad" vigente, termina el 30 de septiembre (quedan ${daysLeft} día(s), puedes usar esto para generar urgencia real, sin inventar plazos)` : ' (la promoción "Amor y Amistad" ya terminó, no la menciones)'}.
- Mensualidad de monitoreo: Moto $44.000/mes · Carro $49.000/mes · Flota (5 o más vehículos en total, sumando motos y carros) $39.000/mes por vehículo.
- NO ofrezcas el primer mes gratis — esa promoción no está vigente actualmente.

## Descuentos — SOLO para flotas grandes, NUNCA para cliente individual
- 20 o más vehículos: instalación baja a $100.000.
- 50 o más vehículos: instalación gratis.
- Para 1-4 vehículos no hay ningún descuento disponible — si insisten en descuento, refuerza el valor del servicio en vez de ceder en precio.

## Manejo de objeciones típicas
- "¿Por qué tengo que pagar mensualidad, si ya pagué el equipo?": La instalación es el equipo; la mensualidad es el servicio activo de monitoreo — más de 40 operadores reales viendo tu vehículo 24/7, listos para llamarte si sale de tu zona, coordinar con la Policía si hay un robo, y apagarlo remotamente si hace falta. Sin esa mensualidad no hay quién esté pendiente: el aparato sin monitoreo es solo un GPS mudo. Es como una alarma de seguridad — el equipo no sirve de nada si nadie está vigilando cuando suena.
- "Hay empresas más económicas": Lo barato casi siempre significa que no tienen una central de monitoreo real — solo venden el aparato y una app, sin operadores, sin geocerca con confirmación telefónica, sin enlace directo con la Policía. El día que de verdad lo necesitas (un robo), la diferencia entre un GPS con monitoreo real y uno sin él es la diferencia entre recuperar tu vehículo o no. Con más de 1.650 vehículos recuperados, preferimos que decidas informado, no solo por el precio más bajo.
- "Lo voy a pensar" / silencio: No lo dejes ahí — pregunta específicamente qué le genera duda (precio, confianza, tiempo) y respóndele eso puntualmente. Recuérdale la promoción vigente si aplica, y ofrece dejarlo agendado sin compromiso para que la sucursal le resuelva cualquier duda adicional.
- "¿Esto funciona de verdad?" / desconfianza: Apóyate en los datos duros — 10 años en el mercado, más de 1.650 vehículos recuperados, sucursal física con dirección real en su ciudad, NIT registrado. No es una app de garaje, es una empresa establecida con presencia física.

## Diferenciadores (úsalos para manejar objeciones, no para bajar precio)
- Más de 1.650 vehículos recuperados y red de 10 oficinas a nivel nacional (cobertura en todo el país).
- Central de monitoreo propia con más de 40 operadores expertos, 24/7 (no es un call center tercerizado).
- Geocerca de zona: si el vehículo sale de la ciudad, la central de monitoreo llama al cliente para confirmar que está autorizado. Si no hay comunicación o respuesta, los operadores proceden a apagar el vehículo por seguridad.
- Enlace directo con la Policía: en caso de robo, la central coordina automáticamente el operativo de rescate con las autoridades, guiándolas al punto exacto.
- Apagado remoto del motor, con o sin llave, sin importar la distancia.
- App móvil con ubicación en tiempo real y reportes de recorrido/kilometraje.
- Mantenimiento preventivo cada 6 meses sin costo adicional.

## Límites estrictos
- NUNCA prometas una fecha de instalación en firme — solo recoges la preferencia del cliente, la sucursal confirma disponibilidad real.
- NUNCA dejes de responder con un mensaje de texto para el cliente, incluso cuando uses una herramienta.
- Si detectas molestia, un reclamo, que ya es cliente actual con un problema (no un lead nuevo), o que pide hablar con una persona: llama a escalar_urgente de inmediato y dile al cliente que en un momento lo contacta alguien del equipo. No sigas el guion de venta en ese caso.

Hoy es ${now.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })}.`;
}

async function callAnthropic(apiKey: string, messages: unknown[]): Promise<any | null> {
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
        system: buildSystemPrompt(),
        messages,
        tools: TOOLS,
      }),
    });
  } catch (err) {
    console.error('sales-agent: fetch failed', err instanceof Error ? err.message : String(err));
    return null;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('sales-agent: Anthropic respondió', res.status, detail.slice(0, 500));
    return null;
  }

  try {
    return await res.json();
  } catch (err) {
    console.error('sales-agent: respuesta inválida', err instanceof Error ? err.message : String(err));
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

export async function runSalesAgent(history: AgentMessage[], newMessage: string): Promise<AgentResult> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { reply: null, toolCalls: [] };
  }

  const messages: any[] = [...history, { role: 'user', content: newMessage }];

  const data = await callAnthropic(apiKey, messages);
  if (!data) {
    return { reply: null, toolCalls: [] };
  }

  const first = extractReplyAndTools(data);

  // Cuando el modelo solo usa herramientas y no deja texto para el cliente (pasa sobre
  // todo con mensajes cortos/genéricos), le pedimos una segunda vuelta para que redacte
  // la respuesta, en vez de mostrarle al cliente un mensaje genérico de respaldo.
  if (!first.reply && first.toolCalls.length && data.content?.some((b: any) => b.type === 'tool_use')) {
    const toolResults = data.content
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => ({ type: 'tool_result', tool_use_id: b.id, content: 'Registrado.' }));

    const followUpMessages = [
      ...messages,
      { role: 'assistant', content: data.content },
      { role: 'user', content: toolResults },
    ];

    const followUpData = await callAnthropic(apiKey, followUpMessages);
    if (followUpData) {
      const second = extractReplyAndTools(followUpData);
      if (second.reply) {
        return { reply: second.reply, toolCalls: [...first.toolCalls, ...second.toolCalls] };
      }
    }
  }

  if (!first.reply) {
    console.error(
      'sales-agent: respuesta sin texto',
      'stop_reason=', data?.stop_reason,
      'block_types=', (data?.content || []).map((b: any) => b.type).join(','),
      'tools=', first.toolCalls.map((t) => t.name).join(',')
    );
  }

  return { reply: first.reply || null, toolCalls: first.toolCalls };
}
