import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put, del } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, verifySameOrigin } from '../../lib/auth';

export const prerender = false;

export const REDIS_KEY = 'internal:payment-receipts';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB
const STATUSES: ReceiptStatus[] = ['pendiente', 'verificado', 'no-encontrado'];

export type ReceiptStatus = 'pendiente' | 'verificado' | 'no-encontrado';

export interface PaymentReceipt {
  id: string;
  amount: number;
  paymentDate: string; // YYYY-MM-DD, tal como aparece en el archivo de movimientos del banco
  payerName: string;
  reference: string; // informativo (número de aprobación del comprobante); el banco no lo exporta, no se usa para verificar
  note: string;
  blobPathname: string;
  contentType: string;
  status: ReceiptStatus;
  matchedDetail: string;
  verifiedAt: string | null;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
  updatedAt: string;
}

async function requirePagos(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'pagos')) return null;
  return session;
}

export async function readReceipts(redis: any): Promise<PaymentReceipt[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((r): r is PaymentReceipt => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await requirePagos(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }
  const receipts = await readReceipts(redis);
  const withUrls = receipts.map((r) => ({
    ...r,
    imageUrl: '/api/blob-file?path=' + encodeURIComponent(r.blobPathname),
  }));
  return new Response(JSON.stringify({ receipts: withUrls }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requirePagos(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return new Response(JSON.stringify({ error: 'invalid content-type' }), { status: 400 });
  }

  const form = await request.formData();
  const amount = Number(form.get('amount'));
  const paymentDate = String(form.get('paymentDate') || '').trim();
  const payerName = String(form.get('payerName') || '').trim();
  const reference = String(form.get('reference') || '').trim();
  const note = String(form.get('note') || '').trim();
  const file = form.get('file');

  if (!Number.isFinite(amount) || amount <= 0) {
    return new Response(JSON.stringify({ error: 'el monto no es válido' }), { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    return new Response(JSON.stringify({ error: 'la fecha de pago no es válida' }), { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return new Response(JSON.stringify({ error: 'falta la foto del comprobante' }), { status: 400 });
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

  let blobPathname: string;
  try {
    const blob = await put(`payments/${randomUUID()}`, file, {
      access: 'private',
      token,
      addRandomSuffix: false,
    });
    blobPathname = blob.pathname;
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'fallo al subir la imagen', detail: err instanceof Error ? err.message : String(err) }),
      { status: 500 }
    );
  }

  const now = new Date().toISOString();
  const receipt: PaymentReceipt = {
    id: randomUUID(),
    amount,
    paymentDate,
    payerName,
    reference,
    note,
    blobPathname,
    contentType: file.type,
    status: 'pendiente',
    matchedDetail: '',
    verifiedAt: null,
    uploadedBy: session.username,
    uploadedByName: session.username,
    createdAt: now,
    updatedAt: now,
  };

  await redis.hset(REDIS_KEY, { [receipt.id]: JSON.stringify(receipt) });
  await logAudit(redis, session, 'payment_receipt_create', `$${receipt.amount}`, receipt.paymentDate);

  return new Response(JSON.stringify({ receipt: { ...receipt, imageUrl: '/api/blob-file?path=' + encodeURIComponent(blobPathname) } }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requirePagos(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: { id?: string; status?: string };
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
  const receipt: PaymentReceipt = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (!body.status || !STATUSES.includes(body.status as ReceiptStatus)) {
    return new Response(JSON.stringify({ error: 'estado inválido' }), { status: 400 });
  }
  const status = body.status as ReceiptStatus;
  receipt.status = status;
  receipt.matchedDetail = status === 'verificado' ? 'Verificado manualmente' : '';
  receipt.verifiedAt = status === 'verificado' ? new Date().toISOString() : null;
  receipt.updatedAt = new Date().toISOString();

  await redis.hset(REDIS_KEY, { [id]: JSON.stringify(receipt) });
  await logAudit(redis, session, 'payment_receipt_status_manual', `$${receipt.amount}`, status);

  return new Response(JSON.stringify({ receipt }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requirePagos(cookies);
  if (!session) {
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
  const receipt: PaymentReceipt = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    try {
      await del(receipt.blobPathname, { token });
    } catch {
      // si falla el borrado del blob, igual quitamos el registro
    }
  }

  await redis.hdel(REDIS_KEY, id);
  await logAudit(redis, session, 'payment_receipt_delete', `$${receipt.amount}`);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
