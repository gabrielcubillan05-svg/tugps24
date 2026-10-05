import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, sessionMustChangePassword } from './lib/auth';
import { getRedis } from './lib/redis';
import { getClientIp } from './lib/rate-limit';
import { recordSecurityEvent } from './lib/security-events';
import { recordSlowRequest, SLOW_REQUEST_MS } from './lib/perf';

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

// El prototipo 3D necesita teselas del mapa, rutas por calles, la ciudad 3D de Google y el clima
// de servicios externos; se abre solo para esa página en vez de aflojar la política de todo el
// sitio. El decodificador de las mallas de Google es WebAssembly y corre en un worker blob.
const CSP_DEMO_3D = CSP.replace(
  "connect-src 'self'",
  "connect-src 'self' https://tiles.openfreemap.org https://router.project-osrm.org https://tile.googleapis.com https://api.open-meteo.com",
)
  .replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")
  .concat("; worker-src 'self' blob:");

// Con la clave inicial sin cambiar, las páginas redirigen a cambiarla, pero la API seguía
// abierta. Aquí se cierra también la API, salvo lo necesario para cambiarla y salir.
const MUST_CHANGE_EXEMPT = ['/api/users', '/api/auth/', '/api/version', '/api/health'];

export const onRequest = defineMiddleware(async (context, next) => {
  const startedAt = Date.now();
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
  // Tiempo del servidor en esta petición: se manda al navegador (pestaña Red → Timing) y, si
  // pasa del umbral, se cuenta por ruta para verlo en Auditoría.
  const elapsed = Date.now() - startedAt;
  response.headers.set('Server-Timing', `app;dur=${elapsed}`);
  if (elapsed >= SLOW_REQUEST_MS) {
    console.warn(`lento ${elapsed}ms ${context.request.method} ${path}`);
    const redis = getRedis();
    if (redis) await recordSlowRequest(redis, path, elapsed);
  }
  // Intentos frenados que antes no dejaban rastro: rechazos por origen o firma (403), límites de
  // tasa (429) y rutas inexistentes (404, típico de escáneres). El 403 de la clave inicial de
  // arriba no entra porque ya se devolvió antes de llegar aquí. Se mide en Auditoría.
  if (response.status === 403 || response.status === 429 || response.status === 404) {
    if (path !== '/favicon.ico') {
      const redis = getRedis();
      if (redis) {
        const kind = response.status === 403 ? 'forbidden' : response.status === 429 ? 'rate_limited' : 'not_found';
        await recordSecurityEvent(redis, kind, getClientIp(context.request), `${response.status} ${context.request.method} ${path}`);
      }
    }
  }
  response.headers.set('Content-Security-Policy', path.replace(/\/$/, '') === '/demo-3d' ? CSP_DEMO_3D : CSP);
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
