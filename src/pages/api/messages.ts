import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, findUserById, verifySameOrigin } from '../../lib/auth';
import { pushNotification } from '../../lib/notifications';
import { getConversation, saveConversation } from './conversations';

export const prerender = false;

const MAX_MESSAGES = 500;

interface Message {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
}

function messagesKey(conversationId: string): string {
  return `internal:messages:${conversationId}`;
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
  if (!conversation || !conversation.memberIds.includes(session.userId)) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
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

  return new Response(JSON.stringify({ message }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
