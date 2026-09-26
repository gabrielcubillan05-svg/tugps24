// Corrección puntual pedida por Gabriel el 26/09/26:
// 1) Borra la nota de seguimiento errónea del 12/09 en el lead "Luis" (+57 321 3005798).
// 2) Marca verifiedInstalled=true en todos los leads que ya tienen installed=true.
// Necesita KV_REST_API_URL/KV_REST_API_TOKEN (o UPSTASH_REDIS_REST_URL/TOKEN) de producción
// en el entorno — no están en el .env local. Primero correr con DRY_RUN=1 para confirmar.
import { Redis } from '@upstash/redis';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error('Faltan las variables de Redis en el entorno.');
  process.exit(1);
}
const redis = new Redis({ url, token });
const dryRun = process.env.DRY_RUN === '1';

const REDIS_KEY = 'internal:leads';
const raw = (await redis.hgetall(REDIS_KEY)) || {};
const leads = Object.entries(raw).map(([id, v]) => [id, typeof v === 'string' ? JSON.parse(v) : v]);

// --- 1) Nota errónea del lead Luis ---
const luis = leads.find(([, l]) => l.phone && l.phone.replace(/\D/g, '').endsWith('3213005798'));
if (!luis) {
  console.error('No se encontró el lead de Luis (+57 321 3005798).');
} else {
  const [id, lead] = luis;
  console.log(`Lead encontrado: "${lead.name}" (${lead.phone}) — ${lead.notes.length} notas.`);
  const before = lead.notes.length;
  const filtered = lead.notes.filter((n) => !(n.date.startsWith('2026-09-12') && n.text === 'Se le deja msj de seguimiento'));
  if (filtered.length === before) {
    console.log('No se encontró esa nota exacta (¿ya se había borrado?). No se modifica nada.');
  } else if (dryRun) {
    console.log(`[DRY RUN] Se borraría 1 nota (del ${before} → ${filtered.length}).`);
  } else {
    lead.notes = filtered;
    await redis.hset(REDIS_KEY, { [id]: JSON.stringify(lead) });
    console.log(`Lead "${lead.name}": nota del 12/09 eliminada.`);
  }
}

// --- 2) Marcar verificados a todos los instalados ---
let updated = 0;
for (const [id, lead] of leads) {
  if (lead.installed && !lead.verifiedInstalled) {
    updated++;
    if (!dryRun) {
      lead.verifiedInstalled = true;
      lead.verifiedInstalledAt = lead.installedAt || new Date().toISOString();
      await redis.hset(REDIS_KEY, { [id]: JSON.stringify(lead) });
    }
  }
}
console.log(`${dryRun ? '[DRY RUN] Se marcarían' : 'Marcados'} como verificados: ${updated} leads (de los que ya estaban instalados).`);
