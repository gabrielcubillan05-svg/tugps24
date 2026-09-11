const MODEL = 'claude-sonnet-5';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentResult {
  reply: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

function buildSystemPrompt(userName: string, roleLabel: string, pendingLines: string[], extraInstructions?: string): string {
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

## Límites estrictos
- Solo tienes información sobre los pendientes de ESTA persona (la lista de arriba) — nunca inventes datos que no estén ahí, ni des información de pendientes de otros trabajadores.
- Todavía no puedes ejecutar acciones (marcar algo como hecho, crear un registro, reasignar un caso, etc.) — solo puedes informar y orientar. Si te piden hacer un cambio, diles con amabilidad que lo hagan desde la sección correspondiente del panel.
- Nunca compartas información privada de la empresa, de sus dueños o de otros trabajadores.
- Si preguntan algo fuera de estos módulos (dudas generales de trabajo, por ejemplo), ayuda con sentido común pero deja claro que tu fuerte es lo relacionado a sus pendientes en el sistema.

Hoy es ${new Date().toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })}.` +
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
        max_tokens: 1024,
        system: systemPrompt,
        messages,
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

function extractReply(data: any): string {
  let reply = '';
  for (const block of data?.content || []) {
    if (block.type === 'text' && typeof block.text === 'string') reply += block.text;
  }
  return reply.trim();
}

export async function runGabotAgent(
  history: AgentMessage[],
  newMessage: string,
  userName: string,
  roleLabel: string,
  pendingLines: string[],
  extraInstructions?: string
): Promise<AgentResult> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  const noUsage = { inputTokens: 0, outputTokens: 0 };
  if (!apiKey) {
    return { reply: null, usage: noUsage };
  }

  const systemPrompt = buildSystemPrompt(userName, roleLabel, pendingLines, extraInstructions);
  const messages = [...history, { role: 'user' as const, content: newMessage }];

  const data = await callAnthropic(apiKey, messages, systemPrompt);
  if (!data) {
    return { reply: null, usage: noUsage };
  }

  return { reply: extractReply(data) || null, usage: usageOf(data) };
}
