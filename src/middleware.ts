import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, sessionMustChangePassword } from './lib/auth';

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

// Con la clave inicial sin cambiar, las páginas redirigen a cambiarla, pero la API seguía
// abierta. Aquí se cierra también la API, salvo lo necesario para cambiarla y salir.
const MUST_CHANGE_EXEMPT = ['/api/users', '/api/auth/', '/api/version', '/api/health'];

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  if (path.startsWith('/api/') && !MUST_CHANGE_EXEMPT.some((p) => path.startsWith(p))) {
    const cookie = context.cookies.get(SESSION_COOKIE)?.value;
    if (cookie && (await sessionMustChangePassword(cookie))) {
      return new Response(JSON.stringify({ error: 'debes cambiar tu contraseña inicial antes de continuar' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  const response = await next();
  response.headers.set('Content-Security-Policy', CSP);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Fuerza HTTPS en el navegador para toda visita futura (2 años, incluidos subdominios) —
  // Vercel ya sirve todo por TLS, pero sin este header un enlace http:// viejo o mal copiado
  // dejaría una ventana de downgrade antes de la redirección.
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  // El sitio público no necesita micrófono/cámara/ubicación — se bloquean ahí. El panel
  // interno sí lo necesita (micrófono de GPSITO), así que se permite solo para ese mismo
  // origen, solo en /interno.
  const isInterno = context.url.pathname.startsWith('/interno');
  response.headers.set('Permissions-Policy', isInterno ? 'camera=(), microphone=(self), geolocation=()' : 'camera=(), microphone=(), geolocation=()');
  return response;
});
