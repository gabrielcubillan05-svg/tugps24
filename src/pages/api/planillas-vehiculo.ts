import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canAccessSection, findUserById, verifySameOrigin, branchesOf } from '../../lib/auth';

export const prerender = false;

const REDIS_KEY = 'internal:planillas-vehiculo';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const CHECKLIST_ITEMS = [
  'Batería',
  'Luces delanteras',
  'Luces traseras',
  'Luces de freno',
  'Luces de cruce',
  'Intermitentes',
  'Tablero (luces)',
  'Bocina',
  'Alarma',
  'Limpiaparabrisas',
  'Tapa de combustible',
  'Retrovisores',
  'Vidrios (funcionamiento)',
  'Reproductor de sonido',
  'Aire acondicionado',
  'Luces del tablero',
];

export const ESTADOS = ['Bueno', 'Regular', 'Malo'];

interface ChecklistItem {
  label: string;
  estado: string;
  detalle: string;
}

export interface PlanillaVehiculo {
  id: string;
  placa: string;
  modelo: string;
  fecha: string;
  hora: string;
  branch: string;
  items: ChecklistItem[];
  nivelCombustible: string;
  observaciones: string;
  tecnicoId: string;
  tecnicoNombre: string;
  tecnicoFirma: string | null;
  clienteNombre: string;
  clienteCedula: string;
  clienteFirma: string | null;
  observacionGarantia: string;
  createdAt: string;
  updatedAt: string;
}

async function requirePlanillas(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canAccessSection(session.role, 'planillas-vehiculo')) return null;
  return session;
}

export async function readPlanillas(redis: any): Promise<PlanillaVehiculo[]> {
  const raw = (await redis.hgetall<Record<string, string>>(REDIS_KEY)) || {};
  return Object.values(raw)
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((p): p is PlanillaVehiculo => p !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await requirePlanillas(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  let planillas = await readPlanillas(redis);

  const isManager = session.role === 'gerente' || session.role === 'admin';
  if (!isManager) {
    planillas = planillas.filter((p) => p.tecnicoId === session.userId);
  } else if (session.role === 'gerente') {
    const me = await findUserById(redis, session.userId);
    const myBranches = branchesOf(me);
    planillas = planillas.filter((p) => myBranches.includes(p.branch));
  }

  if (q) {
    planillas = planillas.filter((p) => p.placa.toLowerCase().includes(q));
  }

  return new Response(
    JSON.stringify({ planillas, checklist: CHECKLIST_ITEMS, estados: ESTADOS }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requirePlanillas(cookies);
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
  const placa = String(form.get('placa') || '').trim().toUpperCase();
  const modelo = String(form.get('modelo') || '').trim();
  const fecha = String(form.get('fecha') || '').trim();
  const hora = String(form.get('hora') || '').trim();
  const nivelCombustible = String(form.get('nivelCombustible') || '').trim();
  const observaciones = String(form.get('observaciones') || '').trim();
  const observacionGarantia = String(form.get('observacionGarantia') || '').trim();
  const clienteNombre = String(form.get('clienteNombre') || '').trim();
  const clienteCedula = String(form.get('clienteCedula') || '').trim();
  const clienteFirmaFile = form.get('clienteFirma');
  const tecnicoFirmaFile = form.get('tecnicoFirma');
  let items: ChecklistItem[] = [];
  try {
    items = JSON.parse(String(form.get('items') || '[]'));
  } catch {
    return new Response(JSON.stringify({ error: 'checklist inválido' }), { status: 400 });
  }

  if (!placa || !fecha || !hora || !clienteNombre || !clienteCedula) {
    return new Response(JSON.stringify({ error: 'faltan campos obligatorios (placa, fecha, hora, cliente)' }), { status: 400 });
  }
  if (!(clienteFirmaFile instanceof File) || clienteFirmaFile.size === 0) {
    return new Response(JSON.stringify({ error: 'falta la firma del cliente' }), { status: 400 });
  }
  if (!Array.isArray(items) || !items.length) {
    return new Response(JSON.stringify({ error: 'checklist vacío' }), { status: 400 });
  }
  for (const it of items) {
    if (it.estado && !ESTADOS.includes(it.estado)) {
      return new Response(JSON.stringify({ error: 'estado inválido en checklist' }), { status: 400 });
    }
  }
  for (const file of [clienteFirmaFile, tecnicoFirmaFile]) {
    if (file instanceof File && file.size > 0) {
      if (!file.type.startsWith('image/')) {
        return new Response(JSON.stringify({ error: 'la firma debe ser una imagen' }), { status: 400 });
      }
      if (file.size > MAX_IMAGE_BYTES) {
        return new Response(JSON.stringify({ error: 'la firma pesa demasiado' }), { status: 400 });
      }
    }
  }

  const token = import.meta.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'almacenamiento no configurado' }), { status: 503 });
  }

  const id = randomUUID();
  let clienteFirma: string | null = null;
  let tecnicoFirma: string | null = null;
  try {
    const clienteBlob = await put(`planillas/${id}-cliente-${randomUUID()}`, clienteFirmaFile, {
      access: 'private',
      token,
      addRandomSuffix: false,
    });
    clienteFirma = clienteBlob.pathname;

    if (tecnicoFirmaFile instanceof File && tecnicoFirmaFile.size > 0) {
      const tecnicoBlob = await put(`planillas/${id}-tecnico-${randomUUID()}`, tecnicoFirmaFile, {
        access: 'private',
        token,
        addRandomSuffix: false,
      });
      tecnicoFirma = tecnicoBlob.pathname;
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'fallo al subir la firma', detail: err instanceof Error ? err.message : String(err) }),
      { status: 500 }
    );
  }

  const tecnico = await findUserById(redis, session.userId);
  const now = new Date().toISOString();

  const planilla: PlanillaVehiculo = {
    id,
    placa,
    modelo,
    fecha,
    hora,
    branch: branchesOf(tecnico)[0] || '',
    items: items.map((it) => ({
      label: String(it.label || ''),
      estado: String(it.estado || ''),
      detalle: String(it.detalle || ''),
    })),
    nivelCombustible,
    observaciones,
    tecnicoId: session.userId,
    tecnicoNombre: tecnico?.name || session.username,
    tecnicoFirma,
    clienteNombre,
    clienteCedula,
    clienteFirma,
    observacionGarantia,
    createdAt: now,
    updatedAt: now,
  };

  await redis.hset(REDIS_KEY, { [planilla.id]: JSON.stringify(planilla) });
  await logAudit(redis, session, 'planilla_vehiculo_create', planilla.placa, planilla.tecnicoNombre);

  return new Response(JSON.stringify({ planilla }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
