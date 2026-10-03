// Validación de rutas de Vercel Blob antes de servirlas. La librería arma una URL con la ruta y
// el cliente HTTP la normaliza: "reports/../planillas/x" terminaba sirviendo "planillas/x", lo
// que saltaba el control por prefijo (y en el endpoint público de material, cualquier archivo
// privado sin sesión). Solo se aceptan rutas con segmentos simples y caracteres conocidos.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._\- ()]*$/;

export function isSafeBlobPath(path: string): boolean {
  if (!path || path.length > 300) return false;
  if (path.includes('\\') || path.includes('%') || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split('/');
  if (segments.length < 2) return false;
  return segments.every((s) => s !== '' && s !== '.' && s !== '..' && SAFE_SEGMENT.test(s));
}

// Carpetas con datos sensibles (firmas, cédulas, fotos de casos): caché corta en el navegador
// para que no queden un día entero en un equipo compartido de la central.
const SHORT_CACHE_PREFIXES = ['planillas/', 'casos/', 'suspensiones/', 'solicitudes-admin/', 'garantias/'];

export function cacheControlFor(path: string): string {
  return SHORT_CACHE_PREFIXES.some((p) => path.startsWith(p)) ? 'private, max-age=300' : 'private, max-age=86400, immutable';
}

const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'application/json', 'video/mp4', 'audio/mpeg', 'audio/ogg']);

// Un archivo subido con un tipo declarado por el cliente (p. ej. SVG) no debe renderizarse como
// documento del mismo origen: solo los tipos conocidos van inline, el resto se descarga.
export function downloadHeadersFor(path: string, contentType: string | undefined): Record<string, string> {
  const type = String(contentType || '').toLowerCase().split(';')[0];
  const filename = path.split('/').pop() || 'archivo';
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  if (INLINE_TYPES.has(type)) {
    return { 'Content-Type': type, 'Content-Disposition': `inline; filename="${safeName}"` };
  }
  return { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeName}"` };
}
