import type { ScheduleEntry } from '../pages/api/schedule';

// getUTCDay(): 0=Domingo, 1=Lunes, ... 6=Sábado — mismo orden que usa Date.prototype.getUTCDay().
const DAY_NAMES_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function normalizeNameForMatch(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

// Colombia es UTC-5 fijo (sin horario de verano) — igual que isQuietHoursColombia en whatsapp.ts.
function colombiaDayAndMinutes(date: Date): { day: string; minutes: number } {
  const shifted = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  return {
    day: DAY_NAMES_ES[shifted.getUTCDay()],
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

// Si el operador no tiene ninguna franja con días/horas configuradas (registros viejos en
// texto libre, o simplemente no se le ha cargado horario todavía), no bloqueamos el
// recordatorio — es preferible recordarle de más a dejarlo sin avisar por falta de datos.
export function isOnShiftNow(schedule: ScheduleEntry[], userName: string, now: Date = new Date()): boolean {
  const targetName = normalizeNameForMatch(userName);
  const relevant = schedule.filter(
    (e) => normalizeNameForMatch(e.operator) === targetName && e.days.length > 0 && e.start && e.end
  );
  if (!relevant.length) return true;

  const { day, minutes } = colombiaDayAndMinutes(now);
  return relevant.some((e) => {
    if (!e.days.includes(day)) return false;
    const startMin = timeToMinutes(e.start);
    const endMin = timeToMinutes(e.end);
    if (startMin <= endMin) return minutes >= startMin && minutes <= endMin;
    // Turno nocturno que cruza medianoche (ej. 22:00-06:00).
    return minutes >= startMin || minutes <= endMin;
  });
}
