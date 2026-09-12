import { defineMiddleware } from 'astro:middleware';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://tools.applemediaservices.com https://*.public.blob.vercel-storage.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  response.headers.set('Content-Security-Policy', CSP);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // El sitio público no necesita micrófono/cámara/ubicación — se bloquean ahí. El panel
  // interno sí lo necesita (micrófono de GPSITO), así que se permite solo para ese mismo
  // origen, solo en /interno.
  const isInterno = context.url.pathname.startsWith('/interno');
  response.headers.set('Permissions-Policy', isInterno ? 'camera=(), microphone=(self), geolocation=()' : 'camera=(), microphone=(), geolocation=()');
  return response;
});
