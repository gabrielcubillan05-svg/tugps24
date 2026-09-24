import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, findUserById, getUsers, canManageUsers, canAssignTasks, canAccessSection, canAccessRRHH, canAccessSuspensiones, verifySameOrigin, ROLE_LABELS, JOSUE_USERNAME, WILMAR_USERNAME, branchesOf } from '../../lib/auth';
import { pushNotification } from '../../lib/notifications';
import { logAudit, readAudit } from '../../lib/audit';
import { getConversation, saveConversation } from './conversations';
import { GABOT_ID, GABOT_NAME } from '../../lib/gabot-constants';
import { runGabotAgent, type AgentMessage, type CreateTaskInput, type GabotPermissions, type GabotActions } from '../../lib/gabot-agent';
import { collectPendingLines, type GabotData } from '../../lib/gabot-report';
import { getExtraInstructions, recordAgentUsage } from '../../lib/agent-usage';
import { readSuspensiones } from './suspensiones';
import { readSolicitudes } from './solicitudes-administrativas';
import { readPagos } from './pagos-internos';
import { readTasks, createTask, markTaskStatus, addTaskNote } from './tasks';
import { readLeads } from './leads';
import { readClientes } from './seguimiento-masivos';
import { readCasos } from './casos-importantes';
import { readGarantias } from './garantias';
import { readScheduledReports, withStatus } from './scheduled-reports';
import { readSchedule } from './schedule';
import { SHIFT_SUPERVISORS, shiftBucketFor } from '../../lib/shift';
import { getProfile, readProfiles } from './employees';
import { computeVacationBalances, readContracts, withStatus as withContractStatus } from './contracts';
import { readEntries as readVacationRequests } from './vacation-requests';
import { readCuadrantes } from './cuadrantes';
import { readRecentReports } from './reports';

export const prerender = false;

export const MAX_MESSAGES = 500;

export interface Message {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
}

export function messagesKey(conversationId: string): string {
  return `internal:messages:${conversationId}`;
}

function normalizeNameForMatch(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export const GET: APIRoute = async ({ url, cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const conversationId = url.searchParams.get('conversationId') || '';
  const conversation = await getConversation(redis, conversationId);
  const isMember = conversation && conversation.memberIds.includes(session.userId);
  const isOversight = conversation && !isMember && canManageUsers(session.role);
  if (!conversation || (!isMember && !isOversight)) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  if (isOversight) {
    await logAudit(redis, session, 'chat_oversight_view', conversationId);
  }

  const since = url.searchParams.get('since');
  const raw = (await redis.lrange<string>(messagesKey(conversationId), 0, -1)) || [];
  let messages: Message[] = raw
    .map((m) => {
      try {
        return typeof m === 'string' ? JSON.parse(m) : m;
      } catch {
        return null;
      }
    })
    .filter((m): m is Message => m !== null);

  if (since) {
    messages = messages.filter((m) => m.createdAt > since);
  }

  return new Response(JSON.stringify({ messages }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { conversationId?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const conversationId = String(body.conversationId || '');
  const text = String(body.text || '').trim();
  if (!text) {
    return new Response(JSON.stringify({ error: 'el mensaje no puede estar vacío' }), { status: 400 });
  }

  const conversation = await getConversation(redis, conversationId);
  if (!conversation || !conversation.memberIds.includes(session.userId)) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }

  const sender = await findUserById(redis, session.userId);
  const message: Message = {
    id: randomUUID(),
    senderId: session.userId,
    senderName: sender?.name || session.username,
    text,
    createdAt: new Date().toISOString(),
  };

  const key = messagesKey(conversationId);
  await redis.rpush(key, JSON.stringify(message));
  await redis.ltrim(key, -MAX_MESSAGES, -1);

  conversation.lastMessageAt = message.createdAt;
  conversation.lastMessagePreview = text.slice(0, 120);
  const recipients = conversation.memberIds.filter((memberId) => memberId !== session.userId);
  recipients.forEach((memberId) => {
    conversation.unread[memberId] = (conversation.unread[memberId] || 0) + 1;
  });
  await saveConversation(redis, conversation);

  const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
  const notifMessage =
    conversation.type === 'group'
      ? `${message.senderName} en ${conversation.name}: ${preview}`
      : `Nuevo mensaje de ${message.senderName}: ${preview}`;
  for (const memberId of recipients) {
    await pushNotification(redis, memberId, {
      type: 'chat_message',
      message: notifMessage,
      link: '/interno/chat',
      key: `chat:${conversationId}`,
    });
  }

  // Si le está escribiendo a GPSITO (por el widget flotante o desde Chat), le contestamos en la
  // misma conversación con el modelo de IA — con los pendientes reales de esta persona como
  // contexto, para que pueda preguntarle por su propio trabajo en el sistema.
  if (conversation.type === 'dm' && conversation.memberIds.includes(GABOT_ID) && sender) {
    try {
      const rawHistory = (await redis.lrange<string>(key, 0, -1)) || [];
      const allMessages: Message[] = rawHistory
        .map((m) => {
          try {
            return typeof m === 'string' ? JSON.parse(m) : m;
          } catch {
            return null;
          }
        })
        .filter((m): m is Message => m !== null);
      const history: AgentMessage[] = allMessages
        .slice(0, -1)
        .map((m) => ({ role: m.senderId === GABOT_ID ? 'assistant' : 'user', content: m.text }));

      const [suspensiones, solicitudes, pagos, tasks, leads, clientesMasivos, casos, scheduledReports, garantias, extraInstructions, allUsers] = await Promise.all([
        readSuspensiones(redis),
        readSolicitudes(redis),
        readPagos(redis),
        readTasks(redis),
        readLeads(redis),
        readClientes(redis),
        readCasos(redis),
        readScheduledReports(redis),
        readGarantias(redis),
        getExtraInstructions(redis, 'gabot'),
        getUsers(redis),
      ]);
      const data: GabotData = { suspensiones, solicitudes, pagos, tasks, leads, clientesMasivos, casos, scheduledReports, garantias };
      const pendingLines = collectPendingLines(sender, data);

      // Solo admin, Josué y Wilmar pueden preguntarle a GPSITO por los pendientes de OTRO
      // trabajador — a cualquier otro rol solo se le ofrece información sobre sí mismo (ni
      // siquiera se le manda la herramienta, así que no hay forma de que el modelo la use).
      const canLookupOthers = session.role === 'admin' || [JOSUE_USERNAME, WILMAR_USERNAME].includes(session.username.toLowerCase());
      // José Miguel y Junior Cárdenas (supervisores de turno, por username — igual que en
      // tasks.ts) pueden preguntarle a GPSITO por los pendientes de SUS operadores a cargo,
      // aunque no tengan el permiso general de canLookupOthers.
      const shiftSupervisor = SHIFT_SUPERVISORS.find((s) => s.username === session.username.toLowerCase());
      const canLookupTeam = !canLookupOthers && !!shiftSupervisor;
      const permissions: GabotPermissions = {
        canLookupOthers,
        canLookupTeam,
        canAssignToOthers: canAssignTasks(session.role),
        canHorario: canAccessRRHH(session),
        canNovedades: canAccessSection(session.role, 'novedades'),
        canAuditoria: canAccessSection(session.role, 'auditoria'),
        canCrm: canAccessSection(session.role, 'crm'),
        canSuspensiones: canAccessSuspensiones(session),
        canReportes: canAccessSection(session.role, 'reportes'),
      };

      async function lookupOtherWorker(nombre: string): Promise<string> {
        const target = normalizeNameForMatch(nombre);
        const match = allUsers.find((u) => u.active && normalizeNameForMatch(u.name).includes(target) && target.length > 0);
        if (!match) return `No se encontró ningún trabajador activo que coincida con "${nombre}".`;

        if (!canLookupOthers && canLookupTeam) {
          // Solo puede consultar a operadores de su propio turno — no a cualquiera.
          if (match.role !== 'operador') {
            return `${sender.name} solo tiene permiso para consultar a los operadores de su turno a cargo, no a "${match.name}".`;
          }
          const schedule = await readSchedule(redis);
          const bucket = shiftBucketFor(schedule, match.name);
          if (bucket === null || !shiftSupervisor!.buckets.includes(bucket)) {
            return `${match.name} no está en el turno a cargo de ${sender.name}, así que no tiene permiso para consultar sus pendientes.`;
          }
        }

        const lines = collectPendingLines(match, data);
        return lines.length
          ? `Pendientes de ${match.name} (${ROLE_LABELS[match.role]}):\n${lines.join('\n')}`
          : `${match.name} (${ROLE_LABELS[match.role]}) no tiene nada pendiente en ningún módulo — está al día.`;
      }

      async function createTaskForWorker(input: CreateTaskInput): Promise<string> {
        if (!input.titulo.trim()) return 'Falta el título de la tarea.';

        let target = sender;
        if (input.responsable) {
          const normalized = normalizeNameForMatch(input.responsable);
          const isSelf = normalizeNameForMatch(sender.name).includes(normalized) || normalized.length === 0;
          if (!isSelf) {
            if (!permissions.canAssignToOthers) {
              return `${sender.name} no tiene permiso para crear tareas a nombre de otros — solo puede crear tareas para sí mismo.`;
            }
            const match = allUsers.find((u) => u.active && normalizeNameForMatch(u.name).includes(normalized));
            if (!match) return `No se encontró ningún trabajador activo que coincida con "${input.responsable}".`;
            target = match;
          }
        }

        const dueDate = input.fechaVencimiento && /^\d{4}-\d{2}-\d{2}$/.test(input.fechaVencimiento) ? input.fechaVencimiento : null;
        const created = await createTask(redis, {
          title: input.titulo,
          description: input.descripcion || '',
          assigneeId: target.id,
          dueDate,
          assignedById: session.userId,
          assignedByName: sender.name,
          recurrence: input.recurrencia || null,
        });
        if ('error' in created) return `No se pudo crear la tarea: ${created.error}`;
        await logAudit(redis, session, 'task_create', created.task.title, `asignada a ${created.task.assigneeName} (vía GPSITO)`);
        return `Tarea creada: "${created.task.title}" asignada a ${target.name}${dueDate ? `, vence ${dueDate}` : ''}${created.task.recurrence ? ` (se repite ${created.task.recurrence})` : ''}.`;
      }

      function findOwnTask(tareaQuery: string) {
        const q = normalizeNameForMatch(tareaQuery);
        if (!q) return null;
        return (
          data.tasks.find((t) => t.assigneeId === sender.id && normalizeNameForMatch(t.title).includes(q)) ||
          data.tasks.find((t) => t.assigneeId === sender.id && normalizeNameForMatch(t.description).includes(q)) ||
          null
        );
      }

      async function markTaskForWorker(input: { tarea: string; estado: string }): Promise<string> {
        const task = findOwnTask(input.tarea);
        if (!task) return `No encontré ninguna tarea tuya que coincida con "${input.tarea}".`;
        const updated = await markTaskStatus(redis, task.id, input.estado);
        if ('error' in updated) return `No se pudo actualizar "${task.title}": ${updated.error}.`;
        await logAudit(redis, session, 'task_update', updated.task.title, `estado: ${input.estado} (vía GPSITO)`);
        return `Listo — "${updated.task.title}" quedó en estado "${input.estado}".`;
      }

      async function addNoteToTaskForWorker(input: { tarea: string; nota: string }): Promise<string> {
        const task = findOwnTask(input.tarea);
        if (!task) return `No encontré ninguna tarea tuya que coincida con "${input.tarea}".`;
        if (!input.nota.trim()) return 'Falta el texto de la nota.';
        const updated = await addTaskNote(redis, task.id, input.nota.trim(), sender.name);
        if ('error' in updated) return `No se pudo agregar la nota a "${task.title}": ${updated.error}.`;
        return `Nota agregada a "${updated.task.title}".`;
      }

      async function listSinHorario(): Promise<string> {
        const schedule = await readSchedule(redis);
        const configured = new Set(schedule.map((e) => normalizeNameForMatch(e.operator)));
        const faltantes = allUsers.filter((u) => u.active && !configured.has(normalizeNameForMatch(u.name)));
        if (!faltantes.length) return 'Todos los empleados activos ya tienen al menos una franja de horario configurada.';
        return `Empleados activos SIN horario configurado (${faltantes.length}):\n${faltantes.map((u) => `  · ${u.name} (${ROLE_LABELS[u.role]})`).join('\n')}`;
      }

      async function consultarNovedades(busqueda: string): Promise<string> {
        const reports = await readRecentReports(redis, 30);
        const q = normalizeNameForMatch(busqueda);
        const filtered = q
          ? reports.filter((r) => [r.plate, r.branch, r.category, r.note].some((f) => normalizeNameForMatch(f).includes(q)))
          : reports;
        const top = filtered.slice(0, 8);
        if (!top.length) return `No encontré novedades recientes${busqueda ? ` que coincidan con "${busqueda}"` : ''}.`;
        return `Novedades recientes${busqueda ? ` (filtro: "${busqueda}")` : ''}:\n${top
          .map((r) => `  · ${r.plate} (${r.branch}) — ${r.category}: ${r.note.slice(0, 100)}`)
          .join('\n')}`;
      }

      async function consultarCuadrantes(ciudad: string): Promise<string> {
        const cuadrantes = await readCuadrantes(redis);
        const q = normalizeNameForMatch(ciudad);
        const filtered = q ? cuadrantes.filter((c) => normalizeNameForMatch(c.ciudad).includes(q)) : cuadrantes;
        if (!filtered.length) return `No encontré cuadrantes${ciudad ? ` para "${ciudad}"` : ' registrados'}.`;
        return `Cuadrantes${ciudad ? ` de ${ciudad}` : ''}:\n${filtered
          .map((c) => `  · ${c.ciudad} — Cuadrante ${c.numero}: ${c.telefono}${c.nota ? ` (${c.nota})` : ''}`)
          .join('\n')}`;
      }

      async function consultarAuditoria(busqueda: string): Promise<string> {
        const entries = await readAudit(redis, 200);
        const q = normalizeNameForMatch(busqueda);
        const filtered = q
          ? entries.filter((e) => [e.username, e.action, e.target].some((f) => normalizeNameForMatch(f).includes(q)))
          : entries;
        const top = filtered.slice(0, 10);
        if (!top.length) return `No encontré acciones de auditoría${busqueda ? ` que coincidan con "${busqueda}"` : ''}.`;
        return `Auditoría reciente${busqueda ? ` (filtro: "${busqueda}")` : ''}:\n${top
          .map((e) => `  · ${e.username} — ${e.action}: ${e.target}`)
          .join('\n')}`;
      }

      async function consultarCrm(busqueda: string): Promise<string> {
        const q = normalizeNameForMatch(busqueda);
        const qDigits = busqueda.replace(/\D/g, '');
        const filtered = leads.filter((l) => {
          if (normalizeNameForMatch(l.name).includes(q)) return true;
          if (normalizeNameForMatch(l.city).includes(q)) return true;
          if (qDigits.length >= 6 && l.phone.replace(/\D/g, '').includes(qDigits)) return true;
          return false;
        });
        const top = filtered.slice(0, 8);
        if (!top.length) return `No encontré ningún lead que coincida con "${busqueda}".`;
        return `Leads que coinciden con "${busqueda}":\n${top
          .map((l) => {
            const lastNote = l.notes[0]?.text;
            return `  · ${l.name} (${l.phone}) — ${l.city || 'sin ciudad'} — estado: ${l.status}${l.secretary ? ` — asignado a ${l.secretary}` : ''}${l.nextFollowUp ? ` — próximo seguimiento: ${l.nextFollowUp}` : ''}${lastNote ? ` — última nota: ${lastNote}` : ''}`;
          })
          .join('\n')}`;
      }

      async function consultarSuspensiones(busqueda: string): Promise<string> {
        const q = normalizeNameForMatch(busqueda);
        const filtered = q
          ? suspensiones.filter((s) => [s.clientName, s.plate, s.branch].some((f) => normalizeNameForMatch(f).includes(q)))
          : suspensiones;
        const top = filtered.slice(0, 8);
        if (!top.length) return `No encontré ningún caso de suspensión${busqueda ? ` que coincida con "${busqueda}"` : ''}.`;
        return `Suspensiones${busqueda ? ` que coinciden con "${busqueda}"` : ' recientes'}:\n${top
          .map((s) => `  · ${s.clientName} (${s.plate}) — ${s.branch} — estado: ${s.status}${s.assignedToName ? ` — asignado a ${s.assignedToName}` : ''}`)
          .join('\n')}`;
      }

      async function consultarReportesProgramados(busqueda: string): Promise<string> {
        const q = normalizeNameForMatch(busqueda);
        const withBuckets = scheduledReports.map((r) => withStatus(r));
        const filtered = q
          ? withBuckets.filter((r) => [r.client, r.reportType, r.operator].some((f) => normalizeNameForMatch(f).includes(q)))
          : withBuckets.filter((r) => r.bucket !== 'al-dia');
        const top = filtered.slice(0, 8);
        if (!top.length) return `No encontré ningún reporte programado${busqueda ? ` que coincida con "${busqueda}"` : ' pendiente o por realizar — todos están al día'}.`;
        const bucketLabels: Record<string, string> = { pendiente: 'vencido', 'por-realizar': 'por realizar', 'al-dia': 'al día' };
        return `Reportes programados${busqueda ? ` que coinciden con "${busqueda}"` : ' pendientes o por realizar'}:\n${top
          .map((r) => `  · ${r.client} — ${r.reportType} — operador: ${r.operator} — ${bucketLabels[r.bucket]}`)
          .join('\n')}`;
      }

      async function consultarMisVacaciones(): Promise<string> {
        const [profile, entries] = await Promise.all([getProfile(redis, sender.id), readContracts(redis)]);
        const balances = await computeVacationBalances(redis, entries);
        const balance = balances.find((b) => b.employee === sender.name);
        const requests = (await readVacationRequests(redis)).filter((r) => r.employeeId === sender.id);
        const balanceLine = balance
          ? `Días disponibles: ${balance.remainingDays} · Acumulados: ${balance.accruedDays} · Tomados/asignados: ${balance.takenDays}${profile.hireDate ? ` · Antigüedad: ${balance.yearsOfService} año(s)` : ''}`
          : 'Todavía no tiene fecha de ingreso registrada, así que no se puede calcular su balance.';
        const reqLines = requests.length
          ? requests.slice(0, 5).map((r) => `  · ${r.startDate} – ${r.endDate}: ${r.status}`).join('\n')
          : '  (sin solicitudes de vacaciones registradas)';
        return `${balanceLine}\nSus solicitudes de vacaciones más recientes:\n${reqLines}`;
      }

      async function consultarEmpleados(busqueda: string): Promise<string> {
        const q = normalizeNameForMatch(busqueda);
        const profiles = await readProfiles(redis);
        const filtered = allUsers.filter((u) => {
          if (!q) return true;
          const p = profiles[u.id];
          return [u.name, ...branchesOf(u), p?.cargo].some((f) => normalizeNameForMatch(f || '').includes(q));
        });
        const top = filtered.slice(0, 8);
        if (!top.length) return `No encontré ningún empleado${busqueda ? ` que coincida con "${busqueda}"` : ''}.`;
        return `Empleados${busqueda ? ` que coinciden con "${busqueda}"` : ''}:\n${top
          .map((u) => {
            const p = profiles[u.id];
            return `  · ${u.name} — ${branchesOf(u).join(', ') || 'sin sucursal'} — ${p?.cargo || 'sin cargo registrado'}${u.active ? '' : ' (inactivo)'}`;
          })
          .join('\n')}`;
      }

      async function consultarContratosPorVencer(): Promise<string> {
        const entries = await readContracts(redis);
        const withStatuses = entries
          .filter((e) => e.type === 'Contrato')
          .map((e) => withContractStatus(e))
          .filter((e) => e.status === 'vencido' || e.status === 'proximo');
        if (!withStatuses.length) return 'No hay contratos vencidos ni por vencer en el próximo mes.';
        return `Contratos vencidos o por vencer en el próximo mes:\n${withStatuses
          .map((e) => `  · ${e.employee} — ${e.status === 'vencido' ? 'vencido' : 'por vencer'} el ${e.endDate}`)
          .join('\n')}`;
      }

      const actions: GabotActions = {
        lookupOtherWorker,
        createTaskForWorker,
        markTaskForWorker,
        addNoteToTaskForWorker,
        listSinHorario,
        consultarNovedades,
        consultarCuadrantes,
        consultarAuditoria,
        consultarCrm,
        consultarSuspensiones,
        consultarReportesProgramados,
        consultarMisVacaciones,
        consultarEmpleados,
        consultarContratosPorVencer,
      };

      const result = await runGabotAgent(
        history,
        text,
        sender.name,
        ROLE_LABELS[sender.role],
        pendingLines,
        extraInstructions,
        permissions,
        actions
      );
      await recordAgentUsage(redis, 'gabot', result.usage);

      // Si falla la llamada a Anthropic (créditos agotados, rate limit, etc.) igual se le
      // avisa al usuario en vez de dejarlo esperando una respuesta que nunca llega.
      const replyText = result.reply || 'Tuve un problema técnico y no pude responder. Intenta de nuevo en un momento; si sigue fallando, avísale al administrador.';
      const botMessage: Message = {
        id: randomUUID(),
        senderId: GABOT_ID,
        senderName: GABOT_NAME,
        text: replyText,
        createdAt: new Date().toISOString(),
      };
      await redis.rpush(key, JSON.stringify(botMessage));
      await redis.ltrim(key, -MAX_MESSAGES, -1);
      conversation.lastMessageAt = botMessage.createdAt;
      conversation.lastMessagePreview = replyText.slice(0, 120);
      conversation.unread[session.userId] = (conversation.unread[session.userId] || 0) + 1;
      await saveConversation(redis, conversation);
    } catch (err) {
      // Cualquier excepción inesperada aquí (no solo una respuesta vacía de Anthropic, que ya
      // se maneja arriba) antes solo se registraba en el log y dejaba a la persona esperando
      // una respuesta que nunca llegaba — igual que el bug de silencio que ya se había
      // corregido para el caso de "la IA no contestó", pero este catch de más afuera se
      // quedaba sin avisar nada cuando el error pasaba antes de llegar a ese punto.
      console.error('gabot chat reply failed', err instanceof Error ? err.message : String(err));
      try {
        const fallbackMessage: Message = {
          id: randomUUID(),
          senderId: GABOT_ID,
          senderName: GABOT_NAME,
          text: 'Tuve un problema técnico y no pude responder. Intenta de nuevo en un momento; si sigue fallando, avísale al administrador.',
          createdAt: new Date().toISOString(),
        };
        await redis.rpush(key, JSON.stringify(fallbackMessage));
        await redis.ltrim(key, -MAX_MESSAGES, -1);
        conversation.lastMessageAt = fallbackMessage.createdAt;
        conversation.lastMessagePreview = fallbackMessage.text.slice(0, 120);
        conversation.unread[session.userId] = (conversation.unread[session.userId] || 0) + 1;
        await saveConversation(redis, conversation);
      } catch (err2) {
        console.error('gabot chat fallback message also failed', err2 instanceof Error ? err2.message : String(err2));
      }
    }
  }

  return new Response(JSON.stringify({ message }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
