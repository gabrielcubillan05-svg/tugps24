import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { isQuietHoursColombia } from '../../lib/whatsapp';
import { getUsers, KELLY_USERNAME, WILMAR_USERNAME } from '../../lib/auth';
import { sendGabotMessage } from '../../lib/gabot';
import { readSuspensiones, OPEN_STATUSES } from './suspensiones';
import { readSolicitudes } from './solicitudes-administrativas';
import { readPagos } from './pagos-internos';
import { readTasks, computeOverdue } from './tasks';

export const prerender = false;

function fmtDateOnly(value: string | null): string {
  if (!value) return 'sin fecha';
  const iso = value.length <= 10 ? value + 'T00:00:00' : value;
  return new Date(iso).toLocaleDateString('es-CO', { dateStyle: 'medium' });
}

function fmtMoney(n: number): string {
  return '$' + Math.round(n || 0).toLocaleString('es-CO');
}

// Vercel llama esto cada varias horas (ver vercel.json). GaBot, el asistente interno, revisa
// los pendientes de cada trabajador (Suspensiones abiertas asignadas, Solicitudes
// administrativas de Kelly/Wilmar, Pagos internos y Tareas sin cerrar) y le manda UN solo
// recordatorio consolidado por el chat interno — solo si le queda algo pendiente.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (secret && authHeader !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  // No molestamos de madrugada, ni siquiera por el chat interno.
  if (isQuietHoursColombia()) {
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 'quiet hours' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const [users, suspensiones, solicitudes, pagos, tasks] = await Promise.all([
    getUsers(redis),
    readSuspensiones(redis),
    readSolicitudes(redis),
    readPagos(redis),
    readTasks(redis),
  ]);

  const solicitudesPendientes = solicitudes.filter((s) => s.status === 'Pendiente');

  let sent = 0;
  for (const user of users) {
    if (!user.active) continue;
    const lines: string[] = [];

    const misSuspensiones = suspensiones.filter((c) => c.assignedToId === user.id && OPEN_STATUSES.includes(c.status));
    if (misSuspensiones.length) {
      lines.push(`🚩 Suspensiones abiertas (${misSuspensiones.length}):`);
      for (const c of misSuspensiones) lines.push(`  · ${c.clientName || 'Sin nombre'} (${c.plate}) — ${c.status}`);
    }

    const isKellyOrWilmar = [KELLY_USERNAME, WILMAR_USERNAME].includes(user.username.toLowerCase());
    if (isKellyOrWilmar && solicitudesPendientes.length) {
      lines.push(`📋 Solicitudes administrativas pendientes (${solicitudesPendientes.length}):`);
      for (const s of solicitudesPendientes) lines.push(`  · ${s.clientName} — ${s.requestType}`);
    }

    const misPagos = pagos.filter((p) => p.assignedToId === user.id && p.status === 'Pendiente');
    if (misPagos.length) {
      lines.push(`💰 Pagos internos pendientes (${misPagos.length}):`);
      for (const p of misPagos) lines.push(`  · ${p.concepto} (${p.proveedor}) — ${fmtMoney(p.monto)} — vence ${fmtDateOnly(p.dueDate)}`);
    }

    const misTareas = tasks.filter((t) => t.assigneeId === user.id && t.status !== 'Completada' && t.status !== 'Cancelada');
    if (misTareas.length) {
      lines.push(`✅ Tareas pendientes (${misTareas.length}):`);
      for (const t of misTareas) lines.push(`  · ${t.title}${computeOverdue(t) ? ' — ⚠️ atrasada' : ''}`);
    }

    if (!lines.length) continue;

    const firstName = user.name.trim().split(/\s+/)[0] || user.name;
    const text = `Hola ${firstName}, este es tu recordatorio de pendientes:\n\n${lines.join('\n')}`;
    await sendGabotMessage(redis, user.id, text);
    sent++;
  }

  return new Response(JSON.stringify({ ok: true, sent, totalUsers: users.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
