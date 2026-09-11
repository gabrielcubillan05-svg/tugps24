import type { APIRoute } from 'astro';
import { SESSION_COOKIE, getSession, verifySameOrigin } from '../../lib/auth';
import { transcribeAudioBuffer, MAX_AUDIO_BYTES } from '../../lib/transcribe';

export const prerender = false;

// Transcribe un audio grabado en el navegador (mic del widget de GPSITO) a texto — cualquier
// usuario con sesión puede usarlo, es solo una forma alterna de escribirle a GPSITO, no da
// acceso a nada que ese usuario no tuviera ya por chat de texto.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const form = await request.formData();
  const audioFile = form.get('audio');
  if (!(audioFile instanceof File) || audioFile.size === 0) {
    return new Response(JSON.stringify({ error: 'falta el audio' }), { status: 400 });
  }
  if (audioFile.size > MAX_AUDIO_BYTES) {
    return new Response(JSON.stringify({ error: 'el audio pesa demasiado' }), { status: 400 });
  }

  const buffer = await audioFile.arrayBuffer();
  const text = await transcribeAudioBuffer(buffer, audioFile.type || 'audio/webm');
  if (!text) {
    return new Response(JSON.stringify({ error: 'no se pudo transcribir el audio' }), { status: 502 });
  }

  return new Response(JSON.stringify({ text }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
