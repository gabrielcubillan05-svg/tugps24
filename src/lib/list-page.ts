// Recorte de listas largas en las respuestas del panel. Vercel corta cualquier respuesta de
// función por encima de 4,5 MB, y varias pantallas mandaban la colección completa (con su
// historial) en cada carga: cuando crecían, quedaban en "No se pudo cargar". Las estadísticas
// se calculan antes sobre todo lo filtrado; aquí solo se recorta lo que viaja al navegador, que
// pide más con ?limit= cuando la persona lo necesita.
export const DEFAULT_LIST_LIMIT = 300;
export const MAX_LIST_LIMIT = 3000;

export interface PageMeta {
  total: number;
  truncated: boolean;
  limit: number;
}

export function pageOf<T>(url: URL, items: T[], defaultLimit = DEFAULT_LIST_LIMIT): { page: T[]; meta: PageMeta } {
  const requested = parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIST_LIMIT) : defaultLimit;
  const page = items.slice(0, limit);
  return { page, meta: { total: items.length, truncated: items.length > page.length, limit } };
}
