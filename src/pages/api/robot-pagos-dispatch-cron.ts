import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { cronSecretMatches } from '../../lib/auth';
import { runCronGuarded } from '../../lib/cron-guard';
import { markCronOk } from '../../lib/incidents';
import { timeInColombia } from '../../lib/colombia-time';
import { readRobotState } from './verificacion-pagos';

export const prerender = false;

// Lanza la corrida del robot de pagos (GitHub Actions) cada 20 minutos desde Vercel. Existe
// porque el horario `schedule` del propio workflow no disparó ni una vez el 2026-10-07 (GitHub
// lo ignoraba en silencio) y el panel dependía de corridas a mano. Se dispara por la API de
// GitHub con un token de grano fino (GITHUB_DISPATCH_TOKEN, permiso Actions: lectura y
// escritura sobre este repositorio). El workflow conserva su `schedule`: si GitHub lo llega a
// disparar también, su grupo de concurrencia evita dos corridas cruzadas.
const REPO = 'gabrielcubillan05-svg/tugps24';
const WORKFLOW_FILE = 'robot-pagos.yml';
// Franja de operación en Colombia: 6:00 a. m. a 9:40 p. m., igual que el cron del workflow.
const FROM_MINUTES = 6 * 60;
const TO_MINUTES = 21 * 60 + 40;

export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (!secret || !cronSecretMatches(request.headers.get('authorization'), secret)) {
    return new Response('unauthorized', { status: 401 });
  }
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });

  const token = import.meta.env.GITHUB_DISPATCH_TOKEN as string | undefined;
  // Fuera de horario o sin token el cron sigue "vivo" para /api/health; solo no lanza nada.
  if (!token) {
    await markCronOk(redis, 'robot-pagos-dispatch');
    return new Response(JSON.stringify({ skipped: 'sin GITHUB_DISPATCH_TOKEN' }), { status: 200 });
  }

  const [h, m] = timeInColombia().split(':').map(Number);
  const minutes = h * 60 + m;
  if (minutes < FROM_MINUTES || minutes > TO_MINUTES) {
    await markCronOk(redis, 'robot-pagos-dispatch');
    return new Response(JSON.stringify({ skipped: 'fuera de horario' }), { status: 200 });
  }

  const guarded = await runCronGuarded(redis, 'robot-pagos-dispatch', 300, async () => {
    const state = await readRobotState(redis);
    if (state.paused) return { skipped: 'robot en pausa desde el panel' };
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'tugps24-panel',
      },
      body: JSON.stringify({ ref: 'main', inputs: { modo: 'aplicar', maximo: '10' } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 204) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      console.error('robot-pagos-dispatch: GitHub respondió', res.status, detail);
      return { error: `GitHub respondió ${res.status}`, detail };
    }
    return { dispatched: true };
  });
  return new Response(JSON.stringify(guarded), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
