import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canManageUsers, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:whatsapp-agent-media';

export interface MediaItemDef {
  key: string;
  label: string;
  type: 'image' | 'video';
}

// Estas son las claves que el agente de WhatsApp sabe usar. Súbelas con el script
// scripts/upload-wa-media.mjs y pega aquí la URL pública que te devuelva.
export const MEDIA_ITEMS: MediaItemDef[] = [
  { key: 'central_video', label: 'Video central de monitoreo (IMPORTANTE — se manda siempre)', type: 'video' },
  { key: 'recuperacion_foto_1', label: 'Foto de recuperación reciente', type: 'image' },
  { key: 'recuperacion_video_1', label: 'Video de recuperación reciente', type: 'video' },
  { key: 'sucursal_riohacha', label: 'Foto sucursal Riohacha', type: 'image' },
  { key: 'sucursal_valledupar', label: 'Foto sucursal Valledupar', type: 'image' },
  { key: 'sucursal_santamarta', label: 'Foto sucursal Santa Marta', type: 'image' },
  { key: 'sucursal_maicao', label: 'Foto sucursal Maicao', type: 'image' },
  { key: 'sucursal_atlantico', label: 'Foto sucursal Atlántico (Barranquilla/Soledad)', type: 'image' },
  { key: 'sucursal_bucaramanga', label: 'Foto sucursal Bucaramanga', type: 'image' },
  { key: 'sucursal_medellin', label: 'Foto sucursal Medellín', type: 'image' },
  { key: 'sucursal_monteria', label: 'Foto sucursal Montería', type: 'image' },
  { key: 'medios_pago', label: 'Foto de medios de pago (Valentina, cobranza)', type: 'image' },
];

interface StoredMediaItem {
  key: string;
  url: string;
  updatedAt: string;
  updatedBy: string;
}

async function requireAdmin(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageUsers(session.role)) return null;
  return session;
}

export async function readAgentMedia(redis: any): Promise<Record<string, string>> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  const result: Record<string, string> = {};
  for (const [key, v] of Object.entries(raw)) {
    try {
      const parsed: StoredMediaItem = typeof v === 'string' ? JSON.parse(v) : (v as any);
      if (parsed?.url) result[key] = parsed.url;
    } catch {
      // ignorar entradas corruptas
    }
  }
  return result;
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await requireAdmin(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const urls = await readAgentMedia(redis);
  return new Response(JSON.stringify({ items: MEDIA_ITEMS, urls }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireAdmin(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { key?: string; url?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const key = String(body.key || '').trim();
  const url = String(body.url || '').trim();
  if (!MEDIA_ITEMS.some((m) => m.key === key)) {
    return new Response(JSON.stringify({ error: 'clave inválida' }), { status: 400 });
  }
  if (!url) {
    // borrar la entrada si mandan vacío
    await redis.hdel(REDIS_KEY, key);
    await logAudit(redis, session, 'whatsapp_agent_media_clear', key);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (!/^https:\/\//i.test(url)) {
    return new Response(JSON.stringify({ error: 'la URL debe empezar con https://' }), { status: 400 });
  }

  const item: StoredMediaItem = { key, url, updatedAt: new Date().toISOString(), updatedBy: session.username };
  await redis.hset(REDIS_KEY, { [key]: JSON.stringify(item) });
  await logAudit(redis, session, 'whatsapp_agent_media_set', key);

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
