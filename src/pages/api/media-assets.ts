import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put, del } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, canManageMediaAssets, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:media-assets';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB, dentro del límite de body de las funciones serverless

interface MediaAsset {
  id: string;
  label: string;
  kind: 'image' | 'link';
  url: string;
  blobPathname?: string;
  contentType?: string;
  createdAt: string;
  createdBy: string;
}

async function requireCrm(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'crm')) return null;
  return session;
}

async function readAssets(redis: any): Promise<MediaAsset[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((a): a is MediaAsset => a !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const GET: APIRoute = async ({ cookies }) => {
  if (!(await requireCrm(cookies))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const assets = await readAssets(redis);
  return new Response(JSON.stringify({ assets }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCrm(cookies);
  if (!session || !canManageMediaAssets(session.role)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const contentType = request.headers.get('content-type') || '';
  const now = new Date().toISOString();
  let asset: MediaAsset;

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const label = String(form.get('label') || '').trim();
    const file = form.get('file');
    if (!label) {
      return new Response(JSON.stringify({ error: 'falta el nombre' }), { status: 400 });
    }
    if (!(file instanceof File) || file.size === 0) {
      return new Response(JSON.stringify({ error: 'falta la foto' }), { status: 400 });
    }
    if (!file.type.startsWith('image/')) {
      return new Response(JSON.stringify({ error: 'el archivo debe ser una imagen' }), { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return new Response(JSON.stringify({ error: 'la imagen debe pesar menos de 4MB' }), { status: 400 });
    }
    const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({ error: 'almacenamiento no configurado' }), { status: 503 });
    }
    try {
      const blob = await put(`media/${randomUUID()}-${file.name}`, file, {
        access: 'public',
        token,
        addRandomSuffix: false,
      });
      asset = {
        id: randomUUID(),
        label,
        kind: 'image',
        url: blob.url,
        blobPathname: blob.pathname,
        contentType: file.type,
        createdAt: now,
        createdBy: session.username,
      };
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'fallo al subir la imagen', detail: err instanceof Error ? err.message : String(err) }),
        { status: 500 }
      );
    }
  } else {
    let body: { label?: string; url?: string };
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
    }
    const label = String(body.label || '').trim();
    const url = String(body.url || '').trim();
    if (!label || !url) {
      return new Response(JSON.stringify({ error: 'falta el nombre o el enlace' }), { status: 400 });
    }
    if (!/^https?:\/\//i.test(url)) {
      return new Response(JSON.stringify({ error: 'el enlace debe empezar con http:// o https://' }), { status: 400 });
    }
    asset = {
      id: randomUUID(),
      label,
      kind: 'link',
      url,
      createdAt: now,
      createdBy: session.username,
    };
  }

  await redis.hset(REDIS_KEY, { [asset.id]: JSON.stringify(asset) });
  await logAudit(redis, session, 'media_asset_create', asset.label, asset.kind);

  return new Response(JSON.stringify({ asset }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireCrm(cookies);
  if (!session || !canManageMediaAssets(session.role)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }
  const id = String(body.id || '');
  const raw = await redis.hget<string>(REDIS_KEY, id);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  const asset: MediaAsset = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (asset.kind === 'image' && asset.blobPathname) {
    const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
    if (token) {
      try {
        await del(asset.blobPathname, { token });
      } catch {
        // si falla el borrado del blob, igual quitamos el registro
      }
    }
  }

  await redis.hdel(REDIS_KEY, id);
  await logAudit(redis, session, 'media_asset_delete', asset.label);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
