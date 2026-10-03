import { waitUntil } from '@vercel/functions';

// En Vercel, waitUntil deja la función viva hasta que termine la promesa aunque ya se haya
// respondido: sirve para sacar de la petición del usuario trabajo que no necesita para su
// respuesta (recalcular avisos, procesar un mensaje de WhatsApp). Fuera de Vercel (astro dev)
// no hay contexto y el trabajo se devuelve para esperarlo en línea.
export function runAfterResponse(work: Promise<unknown>): Promise<unknown> | null {
  const context = (globalThis as any)[Symbol.for('@vercel/request-context')]?.get?.();
  if (!context || typeof context.waitUntil !== 'function') return work;
  waitUntil(work);
  return null;
}
