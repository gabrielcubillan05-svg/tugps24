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
