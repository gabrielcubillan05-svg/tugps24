// Precios comerciales compartidos por Andrés (agente de ventas) y el cotizador PDF. Una sola
// fuente para que el agente y la cotización nunca den cifras distintas, y para que una
// promoción con fecha se apague sola en los dos sitios a la vez.

export const INSTALACION_UNIT = 150000;

// Plan anual: el cliente paga de una vez N meses de monitoreo y queda cubierto el año completo.
// Los meses cambian por sucursal: Caribe 10x12, interior (Bucaramanga, Medellín, Montería) 8x12,
// donde además el equipo queda en comodato y no se cobra la instalación.
export const PLAN_ANUAL_MESES: Record<string, number> = {
  Riohacha: 10,
  Valledupar: 10,
  'Santa Marta': 10,
  Maicao: 10,
  Atlántico: 10,
  Bucaramanga: 8,
  Medellín: 8,
  Montería: 8,
};
export const PLAN_ANUAL_COMODATO_MESES = 8;

export interface InstallPromo {
  label: string;
  // Sucursales (nombre exacto de la lista de 8) donde aplica.
  branches: string[];
  price: number;
  from: string;
  until: string;
}

// Promociones de instalación por sucursal y con fecha. Fuera del rango no existen para nadie:
// ni el agente las menciona ni el cotizador las aplica.
export const INSTALL_PROMOS: InstallPromo[] = [
  {
    label: 'Promoción de octubre',
    branches: ['Atlántico', 'Valledupar'],
    price: 79999,
    from: '2026-10-01T00:00:00-05:00',
    until: '2026-10-31T23:59:59-05:00',
  },
];

// Cómo nombrar cada sucursal cuando se habla de la promoción con el cliente (Atlántico es la
// sucursal, pero el cliente dice Barranquilla o Soledad).
export const BRANCH_SPOKEN_NAME: Record<string, string> = {
  Atlántico: 'Barranquilla y Soledad',
};

export function spokenBranchName(branch: string): string {
  return BRANCH_SPOKEN_NAME[branch] || branch;
}

export function activeInstallPromos(now: Date = new Date()): InstallPromo[] {
  const t = now.getTime();
  return INSTALL_PROMOS.filter((p) => t >= new Date(p.from).getTime() && t <= new Date(p.until).getTime());
}

export function installPromoFor(branch: string, now: Date = new Date()): InstallPromo | null {
  return activeInstallPromos(now).find((p) => p.branches.includes(branch)) || null;
}

export function installPriceFor(branch: string, now: Date = new Date()): number {
  return installPromoFor(branch, now)?.price ?? INSTALACION_UNIT;
}

export function promoDaysLeft(promo: InstallPromo, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(promo.until).getTime() - now.getTime()) / 86400000));
}

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// "31 de octubre" a partir de la fecha de cierre, en hora Colombia.
export function promoUntilLabel(promo: InstallPromo): string {
  const d = new Date(promo.until);
  const day = Number(d.toLocaleString('en-US', { timeZone: 'America/Bogota', day: 'numeric' }));
  const month = Number(d.toLocaleString('en-US', { timeZone: 'America/Bogota', month: 'numeric' })) - 1;
  return `${day} de ${MONTHS_ES[month]}`;
}

function dayMonthYearInColombia(iso: string): { day: number; month: number; year: number } {
  const d = new Date(iso);
  const parts = d.toLocaleString('en-US', { timeZone: 'America/Bogota', day: 'numeric', month: 'numeric', year: 'numeric' }).split('/');
  return { month: Number(parts[0]) - 1, day: Number(parts[1]), year: Number(parts[2]) };
}

// "del 1 al 31 de octubre de 2026" para el sitio público.
export function promoRangeLabel(promo: InstallPromo): string {
  const a = dayMonthYearInColombia(promo.from);
  const b = dayMonthYearInColombia(promo.until);
  if (a.month === b.month && a.year === b.year) return `del ${a.day} al ${b.day} de ${MONTHS_ES[b.month]} de ${b.year}`;
  return `del ${a.day} de ${MONTHS_ES[a.month]} al ${b.day} de ${MONTHS_ES[b.month]} de ${b.year}`;
}

// Sucursal que atiende una ciudad escrita a mano por el cliente o la secretaria ("barranquilla",
// "Soledad", "Valle de Upar"). Devuelve null si no se reconoce.
export function branchForCityName(city: string | null | undefined): string | null {
  const c = String(city || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (!c) return null;
  if (/barranquilla|soledad|atlantico/.test(c)) return 'Atlántico';
  if (/valledupar|valle de upar/.test(c)) return 'Valledupar';
  if (/santa marta/.test(c)) return 'Santa Marta';
  if (/riohacha/.test(c)) return 'Riohacha';
  if (/maicao/.test(c)) return 'Maicao';
  if (/bucaramanga/.test(c)) return 'Bucaramanga';
  if (/medellin/.test(c)) return 'Medellín';
  if (/monteria/.test(c)) return 'Montería';
  return null;
}
