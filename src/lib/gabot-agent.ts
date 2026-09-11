const MODEL = 'claude-sonnet-5';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentResult {
  reply: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

// Solo se ofrece esta herramienta cuando quien escribe puede ver pendientes de otros
// (admin, Josué o Wilmar) — a los demás nunca se les manda esta herramienta, así que el
// modelo ni siquiera tiene la opción de usarla (no depende de que "se porte bien" solo).
const LOOKUP_TOOL = {
  name: 'consultar_pendientes_de',
  description:
    'Consulta los pendientes de OTRO trabajador (no de quien te escribe) por su nombre, en todos los módulos del panel interno. Úsala cuando te pregunten por los pendientes de alguien más.',
  input_schema: {
    type: 'object',
    properties: { nombre: { type: 'string', description: 'Nombre o parte del nombre del trabajador a consultar' } },
    required: ['nombre'],
  },
};

function buildSystemPrompt(
  userName: string,
  roleLabel: string,
  pendingLines: string[],
  extraInstructions: string | undefined,
  canLookupOthers: boolean
): string {
  const pendingBlock = pendingLines.length
    ? pendingLines.join('\n')
    : 'No tiene nada pendiente en este momento en ningún módulo — está al día.';

  return `Eres GPSITO, el asistente interno de TuGPS24 (empresa colombiana de GPS para vehículos). No hablas con clientes — hablas con el propio equipo de trabajo, por el chat interno del panel administrativo (/interno). En este momento estás conversando con ${userName} (${roleLabel}).

## Tu función
Ayudas a los trabajadores a entender y organizar sus pendientes dentro de los módulos del panel interno: Suspensiones, Solicitudes administrativas, Pagos programados, Tareas, CRM, Seguimiento a clientes masivos, Casos importantes y Reportes programados. Ya le mandas recordatorios automáticos varias veces al día — ahora también puede preguntarte directamente sobre esos pendientes.

## Pendientes actuales de ${userName} (información real, obtenida justo antes de este mensaje)
${pendingBlock}

## Formato
Responde en texto plano, breve y directo — como un mensaje de chat de trabajo entre compañeros, no un correo formal ni un guion de ventas. Puedes usar emojis con moderación (✅📋💰🚩), sin exagerar. Nada de markdown, asteriscos ni negritas.

## Permisos sobre pendientes de otros trabajadores
${canLookupOthers
    ? `${userName} SÍ tiene permiso de administrador/supervisión general, así que puedes usar la herramienta consultar_pendientes_de cuando te pregunte por los pendientes de otro trabajador por nombre.`
    : `${userName} NO tiene permiso para ver pendientes de otros trabajadores — solo puedes hablarle de LOS SUYOS (la lista de arriba). Si te pregunta por los pendientes de otra persona, dile con amabilidad que solo puedes ayudarle con sus propios pendientes.`}

## Límites estrictos
- Nunca inventes datos que no estén en la información que tienes — ni de esta persona ni de otras.
- Todavía no puedes ejecutar acciones (marcar algo como hecho, crear un registro, reasignar un caso, etc.) — solo puedes informar y orientar. Si te piden hacer un cambio, diles con amabilidad que lo hagan desde la sección correspondiente del panel.
- Nunca compartas información privada de la empresa, de sus dueños, ni datos personales de otros trabajadores que no tengan que ver con sus pendientes en el sistema.
- Si preguntan algo fuera de estos módulos (dudas generales de trabajo, por ejemplo), ayuda con sentido común pero deja claro que tu fuerte es lo relacionado a pendientes en el sistema.

Hoy es ${new Date().toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })}.` +
    (extraInstructions ? `\n\n## Instrucciones adicionales del administrador\n${extraInstructions}` : '');
}

async function callAnthropic(apiKey: string, messages: unknown[], systemPrompt: string, tools: unknown[]): Promise<any | null> {
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
        max_tokens: 1024,
        system: systemPrompt,
        messages,
        ...(tools.length ? { tools } : {}),
      }),
    });
  } catch (err) {
    console.error('gabot-agent: fetch failed', err instanceof Error ? err.message : String(err));
    return null;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('gabot-agent: Anthropic respondió', res.status, detail.slice(0, 500));
    return null;
  }

  try {
    return await res.json();
  } catch (err) {
    console.error('gabot-agent: respuesta inválida', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function usageOf(data: any): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: Number(data?.usage?.input_tokens) || 0,
    outputTokens: Number(data?.usage?.output_tokens) || 0,
  };
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function extractReplyAndTools(data: any): { reply: string; toolCalls: ToolCall[] } {
  let reply = '';
  const toolCalls: ToolCall[] = [];
  for (const block of data?.content || []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      reply += block.text;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
    }
  }
  return { reply: reply.trim(), toolCalls };
}

export async function runGabotAgent(
  history: AgentMessage[],
  newMessage: string,
  userName: string,
  roleLabel: string,
  pendingLines: string[],
  extraInstructions: string | undefined,
  canLookupOthers: boolean,
  // Resuelve el nombre de OTRO trabajador a un texto con sus pendientes (o un mensaje de
  // "no encontrado") — lo provee messages.ts, que es quien ya tiene la lista de usuarios y
  // los datos de cada módulo cargados.
  lookupOtherWorker: (nombre: string) => Promise<string>
): Promise<AgentResult> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  const noUsage = { inputTokens: 0, outputTokens: 0 };
  if (!apiKey) {
    return { reply: null, usage: noUsage };
  }

  const systemPrompt = buildSystemPrompt(userName, roleLabel, pendingLines, extraInstructions, canLookupOthers);
  const tools = canLookupOthers ? [LOOKUP_TOOL] : [];
  const messages: any[] = [...history, { role: 'user', content: newMessage }];

  const data = await callAnthropic(apiKey, messages, systemPrompt, tools);
  if (!data) {
    return { reply: null, usage: noUsage };
  }
  const usage = usageOf(data);
  const first = extractReplyAndTools(data);

  const lookupCalls = first.toolCalls.filter((tc) => tc.name === 'consultar_pendientes_de');
  if (lookupCalls.length) {
    const toolResults = await Promise.all(
      lookupCalls.map(async (tc) => ({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: await lookupOtherWorker(String(tc.input.nombre || '')),
      }))
    );

    const followUpMessages = [...messages, { role: 'assistant', content: data.content }, { role: 'user', content: toolResults }];
    const followUpData = await callAnthropic(apiKey, followUpMessages, systemPrompt, tools);
    if (followUpData) {
      const followUpUsage = usageOf(followUpData);
      usage.inputTokens += followUpUsage.inputTokens;
      usage.outputTokens += followUpUsage.outputTokens;
      const second = extractReplyAndTools(followUpData);
      if (second.reply) {
        return { reply: second.reply, usage };
      }
    }
  }

  return { reply: first.reply || null, usage };
}
