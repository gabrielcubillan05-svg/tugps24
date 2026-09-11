import { randomUUID } from 'node:crypto';
import { pushNotification } from './notifications';
import { readConversations, saveConversation, type Conversation } from '../pages/api/conversations';
import { messagesKey, MAX_MESSAGES, type Message } from '../pages/api/messages';
import { GABOT_ID, GABOT_NAME } from './gabot-constants';

export { GABOT_ID, GABOT_NAME };

type Redis = any;

async function getOrCreateGabotConversation(redis: Redis, userId: string): Promise<Conversation> {
  const all = await readConversations(redis);
  const existing = all.find(
    (c) => c.type === 'dm' && c.memberIds.length === 2 && c.memberIds.includes(GABOT_ID) && c.memberIds.includes(userId)
  );
  if (existing) return existing;

  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: randomUUID(),
    type: 'dm',
    name: null,
    memberIds: [GABOT_ID, userId],
    createdBy: GABOT_ID,
    createdAt: now,
    lastMessageAt: null,
    lastMessagePreview: '',
    unread: {},
    lastRead: {},
  };
  await saveConversation(redis, conversation);
  return conversation;
}

// Manda un recordatorio de GaBot a un trabajador por el chat interno — crea la conversación
// DM la primera vez que le escribe a esa persona.
export async function sendGabotMessage(redis: Redis, userId: string, text: string): Promise<void> {
  const conversation = await getOrCreateGabotConversation(redis, userId);

  const message: Message = {
    id: randomUUID(),
    senderId: GABOT_ID,
    senderName: GABOT_NAME,
    text,
    createdAt: new Date().toISOString(),
  };

  const key = messagesKey(conversation.id);
  await redis.rpush(key, JSON.stringify(message));
  await redis.ltrim(key, -MAX_MESSAGES, -1);

  conversation.lastMessageAt = message.createdAt;
  conversation.lastMessagePreview = text.slice(0, 120);
  conversation.unread[userId] = (conversation.unread[userId] || 0) + 1;
  await saveConversation(redis, conversation);

  try {
    const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
    await pushNotification(redis, userId, {
      type: 'chat_message',
      message: `${GABOT_NAME}: ${preview}`,
      link: '/interno/chat',
      key: `chat:${conversation.id}`,
    });
  } catch {
    // no debe tumbar el envío del recordatorio
  }
}
