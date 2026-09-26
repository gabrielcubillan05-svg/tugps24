// Lista (solo lectura, no modifica nada) las garantías reingresadas en la última carga de Excel.
// Correr con las mismas variables de Redis del script anterior:
//   $env:KV_REST_API_URL = "..."
//   $env:KV_REST_API_TOKEN = "..."
//   node scripts/list-reingresadas.mjs
import { Redis } from '@upstash/redis';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error('Faltan las variables de Redis en el entorno.');
  process.exit(1);
}
const redis = new Redis({ url, token });

const REDIS_KEY = 'internal:garantias';
const raw = (await redis.hgetall(REDIS_KEY)) || {};
const garantias = Object.values(raw).map((v) => (typeof v === 'string' ? JSON.parse(v) : v));

const maxBatch = garantias.reduce((max, g) => (g.batchUploadedAt > max ? g.batchUploadedAt : max), '');
const reingresadas = garantias.filter(
  (g) => g.batchUploadedAt === maxBatch && (g.history || []).some((h) => h.date === maxBatch && h.note.startsWith('Vehículo reingresado'))
);

console.log(`Última carga: ${maxBatch}`);
console.log(`Reingresadas: ${reingresadas.length}\n`);
for (const g of reingresadas) {
  console.log(`${g.placa || '(sin placa)'} · ${g.cliente} · ${g.branch || '(sin sucursal)'} · asignada a ${g.assignedToName}`);
}
