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

// Se ofrece a TODOS — cualquiera puede crearse una tarea/pendiente a sí mismo. Solo quien
// puede asignar tareas en el panel (supervisor/gerente/admin) puede además dársela a alguien
// más; el resolver en messages.ts es quien hace cumplir esa distinción, no el modelo.
const CREATE_TASK_TOOL = {
  name: 'crear_tarea',
  description: 'Crea una tarea/pendiente nueva en el módulo de Tareas y la asigna a un trabajador por su nombre (o a quien te escribe, si no te dan un nombre distinto).',
  input_schema: {
    type: 'object',
    properties: {
      responsable: { type: 'string', description: 'Nombre (o parte del nombre) del trabajador al que se le asigna la tarea. Si no se especifica, se asume que es para quien te escribe.' },
      titulo: { type: 'string', description: 'Título corto de la tarea' },
      descripcion: { type: 'string', description: 'Detalles de la tarea (opcional)' },
      fecha_vencimiento: { type: 'string', description: 'Fecha de vencimiento en formato YYYY-MM-DD (opcional)' },
    },
    required: ['titulo'],
  },
};

// Se ofrece a TODOS — solo actúa sobre las tareas de quien te escribe (nunca las de otros).
const MARK_TASK_TOOL = {
  name: 'marcar_tarea',
  description:
    'Cambia el estado de una tarea de quien te escribe (identificándola por su título o parte de él). La foto de evidencia es opcional, no hace falta para marcarla Completada.',
  input_schema: {
    type: 'object',
    properties: {
      tarea: { type: 'string', description: 'Título o parte del título de la tarea a identificar' },
      estado: { type: 'string', enum: ['En progreso', 'Completada', 'Cancelada'], description: 'Nuevo estado de la tarea' },
    },
    required: ['tarea', 'estado'],
  },
};

const ADD_TASK_NOTE_TOOL = {
  name: 'agregar_nota_tarea',
  description: 'Agrega una nota de seguimiento a una tarea de quien te escribe (identificándola por su título o parte de él).',
  input_schema: {
    type: 'object',
    properties: {
      tarea: { type: 'string', description: 'Título o parte del título de la tarea a identificar' },
      nota: { type: 'string', description: 'Texto de la nota' },
    },
    required: ['tarea', 'nota'],
  },
};

function buildSystemPrompt(
  userName: string,
  roleLabel: string,
  pendingLines: string[],
  extraInstructions: string | undefined,
  canLookupOthers: boolean,
  canAssignToOthers: boolean
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

## Eres también su asistente personal de Tareas
Cualquiera puede pedirte, sobre SUS PROPIAS tareas:
- Crear una tarea/pendiente nueva para sí mismo (crear_tarea, sin indicar responsable — o dando su propio nombre).
- Marcar una de sus tareas como "En progreso", "Completada" o "Cancelada" (marcar_tarea) — la foto de evidencia es opcional, no hace falta para completarla.
- Agregarle una nota de seguimiento a una de sus tareas (agregar_nota_tarea).
Si menciona una tarea y no tienes claro cuál es por el título, pregunta o usa el que más se parezca — la herramienta te dirá si no encontró ninguna coincidencia.

## Crear tareas para OTROS trabajadores
${canAssignToOthers
    ? `${userName} SÍ puede asignar tareas a otros (supervisor/gerente/admin), así que si te da el nombre de otro trabajador en crear_tarea, créasela a esa persona con gusto.`
    : `${userName} NO puede asignar tareas a otros — solo a sí mismo. Si te pide crear una tarea para otra persona, dile con amabilidad que solo puede crear tareas para sí mismo, y ofrécele hacerla para él/ella en su lugar. Nunca intentes la herramienta crear_tarea con el nombre de otra persona para este usuario.`}

## Límites estrictos
- Nunca inventes datos que no estén en la información que tienes — ni de esta persona ni de otras.
- Aparte de crear/actualizar tareas (ver arriba), todavía no puedes ejecutar otras acciones (marcar algo como hecho en otro módulo, crear un registro, reasignar un caso, etc.) — solo puedes informar y orientar sobre esas. Si te piden ese tipo de cambio, diles con amabilidad que lo hagan desde la sección correspondiente del panel.
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

export interface CreateTaskInput {
  responsable?: string;
  titulo: string;
  descripcion?: string;
  fechaVencimiento?: string;
}

export interface GabotTaskActions {
  createTaskForWorker: (input: CreateTaskInput) => Promise<string>;
  markTaskForWorker: (input: { tarea: string; estado: string }) => Promise<string>;
  addNoteToTaskForWorker: (input: { tarea: string; nota: string }) => Promise<string>;
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
  lookupOtherWorker: (nombre: string) => Promise<string>,
  canAssignToOthers: boolean,
  taskActions: GabotTaskActions
): Promise<AgentResult> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  const noUsage = { inputTokens: 0, outputTokens: 0 };
  if (!apiKey) {
    return { reply: null, usage: noUsage };
  }

  const systemPrompt = buildSystemPrompt(userName, roleLabel, pendingLines, extraInstructions, canLookupOthers, canAssignToOthers);
  const tools = [...(canLookupOthers ? [LOOKUP_TOOL] : []), CREATE_TASK_TOOL, MARK_TASK_TOOL, ADD_TASK_NOTE_TOOL];
  const messages: any[] = [...history, { role: 'user', content: newMessage }];

  const data = await callAnthropic(apiKey, messages, systemPrompt, tools);
  if (!data) {
    return { reply: null, usage: noUsage };
  }
  const usage = usageOf(data);
  const first = extractReplyAndTools(data);

  if (first.toolCalls.length) {
    const toolResults = await Promise.all(
      first.toolCalls.map(async (tc) => {
        let content: string;
        if (tc.name === 'consultar_pendientes_de') {
          content = await lookupOtherWorker(String(tc.input.nombre || ''));
        } else if (tc.name === 'crear_tarea') {
          content = await taskActions.createTaskForWorker({
            responsable: tc.input.responsable ? String(tc.input.responsable) : undefined,
            titulo: String(tc.input.titulo || ''),
            descripcion: tc.input.descripcion ? String(tc.input.descripcion) : undefined,
            fechaVencimiento: tc.input.fecha_vencimiento ? String(tc.input.fecha_vencimiento) : undefined,
          });
        } else if (tc.name === 'marcar_tarea') {
          content = await taskActions.markTaskForWorker({
            tarea: String(tc.input.tarea || ''),
            estado: String(tc.input.estado || ''),
          });
        } else if (tc.name === 'agregar_nota_tarea') {
          content = await taskActions.addNoteToTaskForWorker({
            tarea: String(tc.input.tarea || ''),
            nota: String(tc.input.nota || ''),
          });
        } else {
          content = 'Esa herramienta no está disponible.';
        }
        return { type: 'tool_result', tool_use_id: tc.id, content };
      })
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
