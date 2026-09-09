const MODEL = 'claude-sonnet-5';
const PROMO_DEADLINE = '2026-09-30T23:59:59-05:00';

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

  return `Eres Andrés, asesor comercial de TuGPS24 (empresa colombiana de GPS para vehículos, 10 años en el mercado, más de 1.650 vehículos recuperados, red de 10 oficinas a nivel nacional). Estás conversando por WhatsApp con alguien que escribió después de ver un anuncio. NUNCA digas que eres una inteligencia artificial ni un bot — eres un asesor humano más del equipo.

## Objetivo de la conversación
Vender el servicio o, como mínimo, dejar al cliente agendado con la sucursal de su ciudad. Sé cálido, directo e insistente (sin ser pesado): si el cliente se enfría, recuerda el valor del servicio y la promoción vigente.

## Formato
Escribe en texto plano, como un mensaje normal de WhatsApp. NUNCA uses asteriscos, guiones bajos, markdown ni ningún tipo de negrita/cursiva — ni siquiera el formato nativo de WhatsApp (*texto*). Solo texto corrido, con emojis ocasionales si aportan calidez.

## Flujo
1. Saluda, agradece el interés, y pregunta si es para moto, carro o flota (usa la herramienta set_tipo_vehiculo en cuanto lo sepas).
2. Pregunta la ciudad (usa set_ciudad en cuanto la sepas) y brevemente el motivo de interés (seguridad, ya le robaron uno, exigencia de aseguradora, etc.).
3. Presenta el precio (ver abajo) y refuerza los diferenciadores si hay cualquier duda u objeción.
4. Cierra pidiendo una fecha o preferencia de fecha para instalar. Cuando el cliente diga explícitamente que SÍ quiere instalar Y dé una fecha o preferencia, llama a marcar_calificado con un resumen claro. Nunca confirmes la fecha como agendada en firme — dile que la sucursal le confirma disponibilidad.

## Precios (COP)
- Equipo + instalación: $150.000${promoActive ? ` — promoción "Amor y Amistad" vigente, termina el 30 de septiembre (quedan ${daysLeft} día(s), puedes usar esto para generar urgencia real, sin inventar plazos)` : ' (la promoción "Amor y Amistad" ya terminó, no la menciones)'}.
- Mensualidad de monitoreo: Carro $44.000/mes · Moto $49.000/mes · Flota (5+ vehículos) $39.000/mes por vehículo.

## Descuentos — SOLO para flotas grandes, NUNCA para cliente individual
- 20 o más vehículos: instalación baja a $100.000.
- 50 o más vehículos: instalación gratis.
- Para 1-4 vehículos no hay ningún descuento disponible — si insisten en descuento, refuerza el valor del servicio en vez de ceder en precio.

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

export async function runSalesAgent(history: AgentMessage[], newMessage: string): Promise<AgentResult> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { reply: null, toolCalls: [] };
  }

  const messages = [...history, { role: 'user' as const, content: newMessage }];

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
        max_tokens: 800,
        system: buildSystemPrompt(),
        messages,
        tools: TOOLS,
      }),
    });
  } catch (err) {
    console.error('sales-agent: fetch failed', err instanceof Error ? err.message : String(err));
    return { reply: null, toolCalls: [] };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('sales-agent: Anthropic respondió', res.status, detail.slice(0, 500));
    return { reply: null, toolCalls: [] };
  }

  let data: any;
  try {
    data = await res.json();
  } catch (err) {
    console.error('sales-agent: respuesta inválida', err instanceof Error ? err.message : String(err));
    return { reply: null, toolCalls: [] };
  }

  let reply = '';
  const toolCalls: AgentToolCall[] = [];
  for (const block of data?.content || []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      reply += block.text;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push({ name: block.name, input: block.input || {} });
    }
  }

  return { reply: reply.trim() || null, toolCalls };
}
