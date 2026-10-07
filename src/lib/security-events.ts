import { todayInColombia, addDaysToDateString } from './colombia-time';

// Contadores de intentos bloqueados, para saber si la página está recibiendo ataques sin tener
// que entrar a los logs de Vercel. Antes los bloqueos por tasa, las firmas inválidas de Meta y
// los rechazos por origen frenaban el intento pero no dejaban rastro; solo el login quedaba en
// auditoría. Se cuenta por día (hora Colombia): totales por tipo, IPs más repetidas y rutas más
// golpeadas. Todo con vencimiento de 35 días.

export type SecurityEventKind = 'login_failed' | 'login_locked' | 'forbidden' | 'rate_limited' | 'not_found';

const TTL_SECONDS = 35 * 86400;
const MAX_PATH_LENGTH = 80;
const MAX_MEMBERS = 500;

// Para los 404 solo interesa el primer tramo de la ruta (/wp-admin, /.env, /api…): un escáner
// genera miles de rutas distintas y cada una sería un miembro nuevo.
export function securityPathLabel(status: number, method: string, path: string): string {
  if (status !== 404) return `${status} ${method} ${path}`;
  const first = path.split('/').filter(Boolean)[0] || '';
  return `${status} ${method} /${first}${path.split('/').filter(Boolean).length > 1 ? '/…' : ''}`;
}

function dayKey(date: string): string {
  return `internal:security:${date}`;
}

export async function recordSecurityEvent(redis: any, kind: SecurityEventKind, ip: string, path?: string): Promise<void> {
  try {
    const day = todayInColombia();
    const key = dayKey(day);
    const p = redis.pipeline();
    p.hincrby(key, kind, 1);
    p.expire(key, TTL_SECONDS);
    if (ip && ip !== 'unknown') {
      p.zincrby(`${key}:ips`, 1, ip);
      p.expire(`${key}:ips`, TTL_SECONDS);
    }
    if (path) {
      p.zincrby(`${key}:paths`, 1, path.slice(0, MAX_PATH_LENGTH));
      p.expire(`${key}:paths`, TTL_SECONDS);
    }
    // Un escáner que prueba miles de rutas o rota IPs llenaría estos conjuntos sin tope: se
    // conservan solo los 500 más repetidos del día.
    p.zremrangebyrank(`${key}:ips`, 0, -(MAX_MEMBERS + 1));
    p.zremrangebyrank(`${key}:paths`, 0, -(MAX_MEMBERS + 1));
    await p.exec();
  } catch {
    // el conteo nunca debe afectar la respuesta
  }
}

export interface SecurityDay {
  date: string;
  login_failed: number;
  login_locked: number;
  forbidden: number;
  rate_limited: number;
  not_found: number;
}

export interface SecurityStats {
  days: SecurityDay[];
  topIps: { ip: string; count: number }[];
  topPaths: { path: string; count: number }[];
}

function toTop<T extends string>(rows: unknown[], field: T): ({ [K in T]: string } & { count: number })[] {
  // zrange con withScores devuelve [miembro, puntaje, miembro, puntaje, ...]
  const out: any[] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    out.push({ [field]: String(rows[i]), count: Number(rows[i + 1]) || 0 });
  }
  return out;
}

export async function readSecurityStats(redis: any, daysBack = 7): Promise<SecurityStats> {
  const today = todayInColombia();
  const dates = Array.from({ length: daysBack }, (_, i) => addDaysToDateString(today, -i));
  const p = redis.pipeline();
  for (const d of dates) {
    p.hgetall(dayKey(d));
    p.zrange(`${dayKey(d)}:ips`, 0, 19, { rev: true, withScores: true });
    p.zrange(`${dayKey(d)}:paths`, 0, 19, { rev: true, withScores: true });
  }
  const results: any[] = await p.exec();
  const days: SecurityDay[] = [];
  const ipTotals = new Map<string, number>();
  const pathTotals = new Map<string, number>();
  dates.forEach((date, i) => {
    const counts = (results[i * 3] || {}) as Record<string, unknown>;
    days.push({
      date,
      login_failed: Number(counts.login_failed) || 0,
      login_locked: Number(counts.login_locked) || 0,
      forbidden: Number(counts.forbidden) || 0,
      rate_limited: Number(counts.rate_limited) || 0,
      not_found: Number(counts.not_found) || 0,
    });
    for (const row of toTop(results[i * 3 + 1] || [], 'ip')) ipTotals.set(row.ip, (ipTotals.get(row.ip) || 0) + row.count);
    for (const row of toTop(results[i * 3 + 2] || [], 'path')) pathTotals.set(row.path, (pathTotals.get(row.path) || 0) + row.count);
  });
  const sortTop = <K extends string>(m: Map<string, number>, field: K) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, count]) => ({ [field]: k, count }) as { [P in K]: string } & { count: number });
  return { days, topIps: sortTop(ipTotals, 'ip'), topPaths: sortTop(pathTotals, 'path') };
}
