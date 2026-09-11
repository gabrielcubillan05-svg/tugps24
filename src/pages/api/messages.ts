import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, findUserById, getUsers, canManageUsers, verifySameOrigin, ROLE_LABELS, JOSUE_USERNAME, WILMAR_USERNAME } from '../../lib/auth';
import { pushNotification } from '../../lib/notifications';
import { logAudit } from '../../lib/audit';
import { getConversation, saveConversation } from './conversations';
import { GABOT_ID, GABOT_NAME } from '../../lib/gabot-constants';
import { runGabotAgent, type AgentMessage } from '../../lib/gabot-agent';
import { collectPendingLines, type GabotData } from '../../lib/gabot-report';
import { getExtraInstructions, recordAgentUsage } from '../../lib/agent-usage';
import { readSuspensiones } from './suspensiones';
import { readSolicitudes } from './solicitudes-administrativas';
import { readPagos } from './pagos-internos';
import { readTasks } from './tasks';
import { readLeads } from './leads';
import { readClientes } from './seguimiento-masivos';
import { readCasos } from './casos-importantes';
import { readScheduledReports } from './scheduled-reports';

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

      const [suspensiones, solicitudes, pagos, tasks, leads, clientesMasivos, casos, scheduledReports, extraInstructions, allUsers] = await Promise.all([
        readSuspensiones(redis),
        readSolicitudes(redis),
        readPagos(redis),
        readTasks(redis),
        readLeads(redis),
        readClientes(redis),
        readCasos(redis),
        readScheduledReports(redis),
        getExtraInstructions(redis, 'gabot'),
        getUsers(redis),
      ]);
      const data: GabotData = { suspensiones, solicitudes, pagos, tasks, leads, clientesMasivos, casos, scheduledReports };
      const pendingLines = collectPendingLines(sender, data);

      // Solo admin, Josué y Wilmar pueden preguntarle a GPSITO por los pendientes de OTRO
      // trabajador — a cualquier otro rol solo se le ofrece información sobre sí mismo (ni
      // siquiera se le manda la herramienta, así que no hay forma de que el modelo la use).
      const canLookupOthers = session.role === 'admin' || [JOSUE_USERNAME, WILMAR_USERNAME].includes(session.username.toLowerCase());

      async function lookupOtherWorker(nombre: string): Promise<string> {
        const target = normalizeNameForMatch(nombre);
        const match = allUsers.find((u) => u.active && normalizeNameForMatch(u.name).includes(target) && target.length > 0);
        if (!match) return `No se encontró ningún trabajador activo que coincida con "${nombre}".`;
        const lines = collectPendingLines(match, data);
        return lines.length
          ? `Pendientes de ${match.name} (${ROLE_LABELS[match.role]}):\n${lines.join('\n')}`
          : `${match.name} (${ROLE_LABELS[match.role]}) no tiene nada pendiente en ningún módulo — está al día.`;
      }

      const result = await runGabotAgent(history, text, sender.name, ROLE_LABELS[sender.role], pendingLines, extraInstructions, canLookupOthers, lookupOtherWorker);
      await recordAgentUsage(redis, 'gabot', result.usage);

      if (result.reply) {
        const botMessage: Message = {
          id: randomUUID(),
          senderId: GABOT_ID,
          senderName: GABOT_NAME,
          text: result.reply,
          createdAt: new Date().toISOString(),
        };
        await redis.rpush(key, JSON.stringify(botMessage));
        await redis.ltrim(key, -MAX_MESSAGES, -1);
        conversation.lastMessageAt = botMessage.createdAt;
        conversation.lastMessagePreview = result.reply.slice(0, 120);
        conversation.unread[session.userId] = (conversation.unread[session.userId] || 0) + 1;
        await saveConversation(redis, conversation);
      }
    } catch (err) {
      console.error('gabot chat reply failed', err instanceof Error ? err.message : String(err));
    }
  }

  return new Response(JSON.stringify({ message }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
