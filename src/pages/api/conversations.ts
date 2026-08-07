import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { removeNotification } from '../../lib/notifications';
import { SESSION_COOKIE, getSession, getUsers, findUserById, canManageUsers, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:conversations';

export interface Conversation {
  id: string;
  type: 'dm' | 'group';
  name: string | null;
  memberIds: string[];
  createdBy: string;
  createdAt: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  unread: Record<string, number>;
  lastRead: Record<string, string>;
}

type Redis = NonNullable<ReturnType<typeof getRedis>>;

const CONVERSATION_DEFAULTS = { unread: {}, lastMessagePreview: '', lastMessageAt: null, lastRead: {} };

export async function readConversations(redis: Redis): Promise<Conversation[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((c): c is Conversation => c !== null)
    .map((c) => ({ ...CONVERSATION_DEFAULTS, ...c }));
}

export async function saveConversation(redis: Redis, conversation: Conversation): Promise<void> {
  await redis.hset(REDIS_KEY, { [conversation.id]: JSON.stringify(conversation) });
}

export async function getConversation(redis: Redis, id: string): Promise<Conversation | null> {
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) return null;
  const c = typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
  return { ...CONVERSATION_DEFAULTS, ...c };
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const all = await readConversations(redis);
  const users = await getUsers(redis);

  if (url.searchParams.get('scope') === 'all') {
    if (!canManageUsers(session.role)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
    const everything = all
      .map((c) => {
        const names = c.memberIds.map((id) => users.find((u) => u.id === id)?.name || 'Usuario');
        return {
          ...c,
          displayName: c.type === 'group' ? c.name : names.join(' · '),
          participantNames: names,
        };
      })
      .sort((a, b) => (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt));

    await logAudit(redis, session, 'chat_oversight_view', 'todas las conversaciones');

    return new Response(JSON.stringify({ conversations: everything }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const mine = all.filter((c) => c.memberIds.includes(session.userId));

  const withDisplay = mine
    .map((c) => {
      let displayName = c.name;
      if (c.type === 'dm') {
        const otherId = c.memberIds.find((id) => id !== session.userId);
        const other = users.find((u) => u.id === otherId);
        displayName = other?.name || 'Usuario';
      }
      return {
        ...c,
        displayName,
        unreadCount: c.unread[session.userId] || 0,
      };
    })
    .sort((a, b) => (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt));

  return new Response(JSON.stringify({ conversations: withDisplay }), {
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

  let body: { type?: string; otherUserId?: string; name?: string; memberIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const type = body.type === 'group' ? 'group' : 'dm';
  const now = new Date().toISOString();

  if (type === 'dm') {
    const otherUserId = String(body.otherUserId || '');
    const other = await findUserById(redis, otherUserId);
    if (!other || otherUserId === session.userId) {
      return new Response(JSON.stringify({ error: 'usuario inválido' }), { status: 400 });
    }

    const all = await readConversations(redis);
    const existing = all.find(
      (c) =>
        c.type === 'dm' &&
        c.memberIds.length === 2 &&
        c.memberIds.includes(session.userId) &&
        c.memberIds.includes(otherUserId)
    );
    if (existing) {
      return new Response(JSON.stringify({ conversation: existing }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const conversation: Conversation = {
      id: randomUUID(),
      type: 'dm',
      name: null,
      memberIds: [session.userId, otherUserId],
      createdBy: session.userId,
      createdAt: now,
      lastMessageAt: null,
      lastMessagePreview: '',
      unread: {},
      lastRead: {},
    };
    await saveConversation(redis, conversation);
    return new Response(JSON.stringify({ conversation }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Grupo
  const name = String(body.name || '').trim();
  const memberIds = Array.isArray(body.memberIds) ? body.memberIds.filter((id) => typeof id === 'string') : [];
  if (!name || memberIds.length === 0) {
    return new Response(JSON.stringify({ error: 'el grupo necesita nombre y al menos un miembro' }), { status: 400 });
  }
  const allMembers = [...new Set([session.userId, ...memberIds])];

  const conversation: Conversation = {
    id: randomUUID(),
    type: 'group',
    name,
    memberIds: allMembers,
    createdBy: session.userId,
    createdAt: now,
    lastMessageAt: null,
    lastMessagePreview: '',
    unread: {},
    lastRead: {},
  };
  await saveConversation(redis, conversation);
  await logAudit(redis, session, 'group_create', name, `${allMembers.length} miembro(s)`);

  return new Response(JSON.stringify({ conversation }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
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

  let body: { id?: string; markRead?: boolean; memberIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const id = String(body.id || '');
  const conversation = await getConversation(redis, id);
  if (!conversation || !conversation.memberIds.includes(session.userId)) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }

  if (body.markRead) {
    conversation.unread[session.userId] = 0;
    conversation.lastRead[session.userId] = new Date().toISOString();
    await removeNotification(redis, session.userId, `chat:${id}`);
  }
  if (body.memberIds !== undefined) {
    const canManage = conversation.createdBy === session.userId || canManageUsers(session.role);
    if (!canManage) {
      return new Response(JSON.stringify({ error: 'solo el creador o un admin puede editar los miembros' }), { status: 403 });
    }
    if (conversation.type !== 'group') {
      return new Response(JSON.stringify({ error: 'solo se puede editar miembros de un grupo' }), { status: 400 });
    }
    const memberIds = [...new Set([conversation.createdBy, ...body.memberIds.filter((v) => typeof v === 'string')])];
    conversation.memberIds = memberIds;
  }

  await saveConversation(redis, conversation);
  return new Response(JSON.stringify({ conversation }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
