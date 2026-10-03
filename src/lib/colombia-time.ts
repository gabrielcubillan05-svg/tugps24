// Helpers de fecha/hora en zona horaria de Colombia (UTC-5 fijo, sin horario de verano) — los
// servidores de Vercel corren en UTC, así que cualquier comparación de "fecha de hoy" hecha con
// new Date().setHours(0,0,0,0) usa el día calendario de UTC, no el de Colombia. Como UTC va 5
// horas adelante, ese límite de "medianoche" cae en realidad a las 7pm hora Colombia — lo que
// hacía que algo con vencimiento "hoy" apareciera como vencido esa misma tarde, antes de tiempo.
// Comparar fechas como texto YYYY-MM-DD (en vez de objetos Date) evita todo este problema.

export function todayInColombia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

export function dateInColombia(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(iso));
}

export function timeInColombia(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

// Un dueDate (string "YYYY-MM-DD") queda vencido a partir del día calendario SIGUIENTE en
// Colombia — el día de vencimiento en sí nunca cuenta como vencido.
export function isOverdueInColombia(dueDate: string): boolean {
  return dueDate < todayInColombia();
}

// Texto para los prompts de los agentes IA: día de la semana, fecha y hora en Colombia. Sin
// esto, el modelo veía la fecha del servidor (UTC) y a partir de las 7 pm hora Colombia ya
// decía "mañana" refiriéndose a dos días después (un viernes por la noche hablaba del domingo).
export function describeNowInColombia(date: Date = new Date()): string {
  const fecha = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  const hora = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
  return `${fecha}, ${hora} hora de Colombia`;
}

// Aritmética sobre fechas texto YYYY-MM-DD (sin zona horaria de por medio).
export function addDaysToDateString(date: string, days: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map((v) => parseInt(v, 10));
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function addMonthsToDateString(date: string, months: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map((v) => parseInt(v, 10));
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}

// Días de a hasta b (positivo si b es después).
export function daysBetweenDateStrings(a: string, b: string): number {
  const [y1, m1, d1] = a.slice(0, 10).split('-').map((v) => parseInt(v, 10));
  const [y2, m2, d2] = b.slice(0, 10).split('-').map((v) => parseInt(v, 10));
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Clave de minuto en Colombia (YYYY-MM-DDTHH:MM) para una fecha.
export function minuteKeyInColombia(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const p: Record<string, string> = {};
  parts.forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
