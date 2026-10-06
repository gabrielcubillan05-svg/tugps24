// Consumo de datos de las SIM (archivos CONSUMOS_DATOS del operador, uno por cuenta). El
// navegador agrega el archivo por línea y por día antes de subirlo (los archivos crudos pesan
// hasta 9 MB y 80.000 filas, más de lo que una función de Vercel puede recibir); aquí se
// calculan los cruces que después lee GPSITO y la pantalla.

export interface SimLine {
  n: string; // número de la línea
  c: string; // cuenta (CUSTCODE_MTR, ej. 8.22500232)
  i: string[]; // IMEI(s) donde estuvo la SIM en el periodo
  kb: number; // total KB del periodo
  u: number; // subida KB
  b: number; // bajada KB
  d: Record<string, number>; // KB por día, clave YYYYMMDD
}

export interface SimLineSummary {
  n: string;
  c: string;
  mb: number;
  mesMb: number;
  dias: number;
  picoMb: number;
  picoDia: string;
  imeis: string[];
}

export interface SimStats {
  lineCount: number;
  rowCount: number;
  totalMb: number;
  days: string[];
  perDayMb: Record<string, number>;
  medianMb: number;
  p90Mb: number;
  maxMb: number;
  planMb: number;
  // Sobreconsumo: proyección a 30 días por encima del plan.
  over: { count: number; top: SimLineSummary[] };
  thresholds: { weekMb: number; monthMb: number; count: number }[];
  perAccount: Record<string, { lines: number; mb: number; medianMb: number; over: number; zero: number; multiImei: number }>;
  zero: { count: number; lines: { n: string; c: string; imeis: string[]; inInventory: boolean }[]; inInventoryCount: number };
  lowActivity: { count: number; top: SimLineSummary[] };
  multiImei: { count: number; lines: { n: string; c: string; imeis: string[]; mb: number }[] };
  imeiMultiLine: { count: number; items: { imei: string; lines: string[] }[] };
  vsPrevious: null | {
    previousPeriod: string;
    newLines: number;
    missingLines: number;
    jumped: { n: string; c: string; antesMb: number; ahoraMb: number }[];
    droppedToZero: { n: string; c: string; antesMb: number }[];
    totalDeltaPct: number;
  };
}

const KB_PER_MB = 1024;
const TOP = 50;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

export function formatDay(yyyymmdd: string): string {
  const s = String(yyyymmdd);
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

export function periodOf(lines: SimLine[]): { start: string; end: string; days: string[] } {
  const set = new Set<string>();
  for (const l of lines) for (const d of Object.keys(l.d || {})) if (/^\d{8}$/.test(d)) set.add(d);
  const days = [...set].sort();
  return { start: days.length ? formatDay(days[0]) : '', end: days.length ? formatDay(days[days.length - 1]) : '', days };
}

// Solo dígitos, últimos 10: el operador manda "9102981936" y en inventario pueden escribir el
// número con prefijo, espacios o guiones.
export function normalizeSimNumber(raw: unknown): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function summary(l: SimLine, dayCount: number): SimLineSummary {
  const entries = Object.entries(l.d || {});
  const active = entries.filter(([, v]) => v > 0);
  const [picoDia, picoKb] = entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best), ['', 0] as [string, number]);
  const mb = l.kb / KB_PER_MB;
  return {
    n: l.n,
    c: l.c,
    mb: round1(mb),
    mesMb: round1(dayCount ? (mb * 30) / dayCount : mb),
    dias: active.length,
    picoMb: round1(picoKb / KB_PER_MB),
    picoDia: formatDay(picoDia),
    imeis: l.i || [],
  };
}

// periodDays: días del periodo declarado al subir (la proyección a 30 días se hace sobre él,
// no sobre los días que traen datos: una línea que solo reportó 2 de 7 días consumió eso en 7).
export function computeSimStats(lines: SimLine[], rowCount: number, planMb: number, inventorySims: Set<string>, previous: SimLine[] | null, previousPeriod: string, periodDays?: number): SimStats {
  const { days } = periodOf(lines);
  const dayCount = periodDays && periodDays > 0 ? periodDays : days.length || 1;
  const kbs = lines.map((l) => l.kb);
  const nonZero = kbs.filter((k) => k > 0).sort((a, b) => a - b);
  const totalKb = kbs.reduce((s, k) => s + k, 0);

  const perDayMb: Record<string, number> = {};
  for (const d of days) perDayMb[formatDay(d)] = 0;
  for (const l of lines) for (const [d, v] of Object.entries(l.d || {})) perDayMb[formatDay(d)] = round1((perDayMb[formatDay(d)] || 0) + v / KB_PER_MB);

  const projectedMb = (l: SimLine) => ((l.kb / KB_PER_MB) * 30) / dayCount;
  const overLines = lines.filter((l) => projectedMb(l) > planMb).sort((a, b) => b.kb - a.kb);
  const thresholds = [2.5, 5, 7, 10].map((weekMb) => ({ weekMb, monthMb: Math.round((weekMb * 30) / 7), count: lines.filter((l) => l.kb > weekMb * KB_PER_MB).length }));

  const perAccount: SimStats['perAccount'] = {};
  for (const l of lines) {
    const acc = perAccount[l.c] || (perAccount[l.c] = { lines: 0, mb: 0, medianMb: 0, over: 0, zero: 0, multiImei: 0 });
    acc.lines++;
    acc.mb += l.kb / KB_PER_MB;
    if (projectedMb(l) > planMb) acc.over++;
    if (l.kb === 0) acc.zero++;
    if ((l.i || []).length > 1) acc.multiImei++;
  }
  for (const [c, acc] of Object.entries(perAccount)) {
    const vals = lines.filter((l) => l.c === c && l.kb > 0).map((l) => l.kb).sort((a, b) => a - b);
    acc.medianMb = round1(percentile(vals, 0.5) / KB_PER_MB);
    acc.mb = round1(acc.mb);
  }

  const zeroLines = lines.filter((l) => l.kb === 0);
  const zero = zeroLines.slice(0, 200).map((l) => ({ n: l.n, c: l.c, imeis: l.i || [], inInventory: inventorySims.has(normalizeSimNumber(l.n)) }));

  const lowActivity = lines.filter((l) => l.kb > 0 && Object.values(l.d || {}).filter((v) => v > 0).length <= Math.min(2, dayCount - 1)).sort((a, b) => a.kb - b.kb);

  const multiImei = lines.filter((l) => (l.i || []).length > 1).sort((a, b) => b.kb - a.kb);
  const imeiMap = new Map<string, Set<string>>();
  for (const l of lines) for (const imei of l.i || []) {
    if (!imei) continue;
    if (!imeiMap.has(imei)) imeiMap.set(imei, new Set());
    imeiMap.get(imei)!.add(l.n);
  }
  const imeiMultiLine = [...imeiMap.entries()].filter(([, s]) => s.size > 1).map(([imei, s]) => ({ imei, lines: [...s].sort() }));

  let vsPrevious: SimStats['vsPrevious'] = null;
  if (previous && previous.length) {
    const prevMap = new Map(previous.map((l) => [l.n, l]));
    const curMap = new Map(lines.map((l) => [l.n, l]));
    const prevTotal = previous.reduce((s, l) => s + l.kb, 0);
    const jumped = lines
      .filter((l) => {
        const p = prevMap.get(l.n);
        return p && l.kb > 2 * KB_PER_MB && l.kb > 3 * p.kb;
      })
      .sort((a, b) => b.kb - a.kb)
      .slice(0, 30)
      .map((l) => ({ n: l.n, c: l.c, antesMb: round1(prevMap.get(l.n)!.kb / KB_PER_MB), ahoraMb: round1(l.kb / KB_PER_MB) }));
    const droppedToZero = previous
      .filter((p) => p.kb > 0 && curMap.has(p.n) && curMap.get(p.n)!.kb === 0)
      .slice(0, 30)
      .map((p) => ({ n: p.n, c: p.c, antesMb: round1(p.kb / KB_PER_MB) }));
    vsPrevious = {
      previousPeriod,
      newLines: lines.filter((l) => !prevMap.has(l.n)).length,
      missingLines: previous.filter((p) => !curMap.has(p.n)).length,
      jumped,
      droppedToZero,
      totalDeltaPct: prevTotal ? Math.round(((totalKb - prevTotal) / prevTotal) * 100) : 0,
    };
  }

  return {
    lineCount: lines.length,
    rowCount,
    totalMb: round1(totalKb / KB_PER_MB),
    days: days.map(formatDay),
    perDayMb,
    medianMb: round1(percentile(nonZero, 0.5) / KB_PER_MB),
    p90Mb: round1(percentile(nonZero, 0.9) / KB_PER_MB),
    maxMb: round1((nonZero[nonZero.length - 1] || 0) / KB_PER_MB),
    planMb,
    over: { count: overLines.length, top: overLines.slice(0, TOP).map((l) => summary(l, dayCount)) },
    thresholds,
    perAccount,
    zero: { count: zeroLines.length, lines: zero, inInventoryCount: zero.filter((z) => z.inInventory).length },
    lowActivity: { count: lowActivity.length, top: lowActivity.slice(0, TOP).map((l) => summary(l, dayCount)) },
    multiImei: { count: multiImei.length, lines: multiImei.slice(0, TOP).map((l) => ({ n: l.n, c: l.c, imeis: l.i, mb: round1(l.kb / KB_PER_MB) })) },
    imeiMultiLine: { count: imeiMultiLine.length, items: imeiMultiLine.slice(0, 30) },
    vsPrevious,
  };
}

// Lo que GPSITO recibe: los números y las listas cortas, nunca las 8.000 líneas.
export function statsForModel(stats: SimStats): Record<string, unknown> {
  return {
    ...stats,
    over: { count: stats.over.count, top: stats.over.top.slice(0, 25) },
    zero: { count: stats.zero.count, inInventoryCount: stats.zero.inInventoryCount, lines: stats.zero.lines.slice(0, 30) },
    lowActivity: { count: stats.lowActivity.count, top: stats.lowActivity.top.slice(0, 15) },
    multiImei: { count: stats.multiImei.count, lines: stats.multiImei.lines.slice(0, 20) },
  };
}
