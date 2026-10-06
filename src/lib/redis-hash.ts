// Lectura de un hash completo por bloques (HSCAN). HGETALL trae todo en una sola respuesta y
// Upstash corta las respuestas de más de 10 MB: una colección que creció durante meses
// (solicitudes con su historial de notas, casos, planillas) dejaba la pantalla en "No se pudo
// cargar" sin ninguna pista. Por bloques no hay tope, solo más idas y vueltas.
export async function readHashValues(redis: any, key: string, count = 500): Promise<unknown[]> {
  const values: unknown[] = [];
  let cursor: string | number = 0;
  do {
    const [next, flat] = (await redis.hscan(key, cursor, { count })) as [string | number, unknown[]];
    for (let i = 1; i < flat.length; i += 2) values.push(flat[i]);
    cursor = next;
  } while (String(cursor) !== '0');
  return values;
}

export function parseJsonValues<T>(values: unknown[]): T[] {
  return values
    .map((v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    })
    .filter((v): v is T => v !== null && typeof v === 'object');
}
