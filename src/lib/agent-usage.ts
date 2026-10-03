// Configuración e instrumentación compartida por los agentes de IA (Andrés, Valentina, y
// los que se agreguen después) — instrucciones extra por agente, contador de tokens
// consumidos y los parámetros para convertir ese consumo a un costo en pesos.

import { todayInColombia } from './colombia-time';

export interface AgentDefinition {
  key: string;
  label: string;
}

export const AGENTS: AgentDefinition[] = [
  { key: 'andres', label: 'Andrés (ventas)' },
  { key: 'valentina', label: 'Valentina (cobranza)' },
  { key: 'gabot', label: 'GPSITO (asistente interno)' },
];

const EXTRA_INSTRUCTIONS_KEY = 'internal:agent-extra-instructions';
const USAGE_KEY_PREFIX = 'internal:agent-usage:';
const DAILY_USAGE_KEY_PREFIX = 'internal:agent-usage-daily:';
const TRACKING_SINCE_KEY = 'internal:agent-usage-tracking-since';
// Conjuntos (sets) de conversaciones distintas atendidas: uno acumulado por agente y uno por
// agente y día. Cada miembro es "canal:idConversacion", así una misma conversación con 20
// respuestas cuenta una sola vez y se puede separar WhatsApp del chat web o del panel.
const CONVERSATIONS_KEY_PREFIX = 'internal:agent-conversations:';
const DAILY_CONVERSATIONS_KEY_PREFIX = 'internal:agent-conversations-daily:';
const CONVERSATIONS_TRACKING_SINCE_KEY = 'internal:agent-conversations-tracking-since';
const COST_CONFIG_KEY = 'internal:agent-cost-config';
// Tope defensivo para una consulta "personalizada" — evita pedirle a Redis miles de llaves
// de un rango absurdo por un typo en las fechas.
const MAX_RANGE_DAYS = 366;
// Los baldes diarios caducan solos pasado un año largo: el reporte por periodo nunca mira más
// atrás de MAX_RANGE_DAYS, así que guardarlos más tiempo solo acumula llaves.
const DAILY_TTL_SECONDS = 400 * 24 * 60 * 60;

export interface CostConfig {
  usdToCop: number;
  inputPricePerMTokUsd: number;
  outputPricePerMTokUsd: number;
}

// Precios por defecto de Claude Sonnet (USD por millón de tokens) y una tasa de cambio
// aproximada — verifica y ajusta ambos en el menú de IA, ya que pueden cambiar.
// Claude Sonnet 5 (el modelo de los tres agentes) vale 2 USD por millón de entrada y 10 de
// salida; si en el menú de IA quedó 3/15 (la tarifa de Sonnet 4.6), el costo sale inflado 1,5x.
const DEFAULT_COST_CONFIG: CostConfig = {
  usdToCop: 4000,
  inputPricePerMTokUsd: 2,
  outputPricePerMTokUsd: 10,
};

export type ConversationChannel = 'whatsapp' | 'web' | 'panel';

export interface ConversationCounts {
  whatsapp: number;
  web: number;
  panel: number;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  // Tokens del prompt servidos desde la caché de Anthropic (cuestan el 10 %) y escritos en
  // ella (cuestan el 125 %). inputTokens solo cuenta los que se cobraron a precio pleno.
  cacheReadTokens: number;
  cacheCreationTokens: number;
  calls: number;
  conversations: ConversationCounts;
}

const EMPTY_USAGE = (): AgentUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 0, conversations: { whatsapp: 0, web: 0, panel: 0 } });

function countByChannel(members: unknown): ConversationCounts {
  const counts: ConversationCounts = { whatsapp: 0, web: 0, panel: 0 };
  for (const m of Array.isArray(members) ? members : []) {
    const channel = String(m).split(':')[0] as ConversationChannel;
    if (channel in counts) counts[channel] += 1;
  }
  return counts;
}

export async function getExtraInstructions(redis: any, agentKey: string): Promise<string> {
  const raw = await redis.hget<string>(EXTRA_INSTRUCTIONS_KEY, agentKey);
  return typeof raw === 'string' ? raw : '';
}

export async function setExtraInstructions(redis: any, agentKey: string, text: string): Promise<void> {
  await redis.hset(EXTRA_INSTRUCTIONS_KEY, { [agentKey]: text });
}

export async function recordAgentUsage(
  redis: any,
  agentKey: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number },
  conversation?: { id: string; channel: ConversationChannel }
): Promise<void> {
  if (!usage.inputTokens && !usage.outputTokens && !usage.cacheReadTokens) return;
  const cacheRead = usage.cacheReadTokens || 0;
  const cacheCreation = usage.cacheCreationTokens || 0;
  const key = USAGE_KEY_PREFIX + agentKey;
  const today = todayInColombia();
  const dailyKey = DAILY_USAGE_KEY_PREFIX + agentKey + ':' + today;
  const member = conversation ? `${conversation.channel}:${conversation.id}` : null;
  await Promise.all([
    ...(member
      ? [
          redis.sadd(CONVERSATIONS_KEY_PREFIX + agentKey, member),
          redis.sadd(DAILY_CONVERSATIONS_KEY_PREFIX + agentKey + ':' + today, member),
          redis.expire(DAILY_CONVERSATIONS_KEY_PREFIX + agentKey + ':' + today, DAILY_TTL_SECONDS),
          redis.set(CONVERSATIONS_TRACKING_SINCE_KEY, today, { nx: true }),
        ]
      : []),
    redis.hincrby(key, 'inputTokens', usage.inputTokens),
    redis.hincrby(key, 'outputTokens', usage.outputTokens),
    redis.hincrby(key, 'cacheReadTokens', cacheRead),
    redis.hincrby(key, 'cacheCreationTokens', cacheCreation),
    redis.hincrby(key, 'calls', 1),
    redis.hincrby(dailyKey, 'inputTokens', usage.inputTokens),
    redis.hincrby(dailyKey, 'outputTokens', usage.outputTokens),
    redis.hincrby(dailyKey, 'cacheReadTokens', cacheRead),
    redis.hincrby(dailyKey, 'cacheCreationTokens', cacheCreation),
    redis.hincrby(dailyKey, 'calls', 1),
    redis.expire(dailyKey, DAILY_TTL_SECONDS),
    // Se guarda una sola vez (nx) — marca desde cuándo existe el desglose por día, para poder
    // avisar en el reporte que un rango de antes de esa fecha va a salir incompleto (no es que
    // esté mal calculado, es que ese balde diario todavía no existía).
    redis.set(TRACKING_SINCE_KEY, today, { nx: true }),
  ]);
}

export async function getUsageTrackingSince(redis: any): Promise<string | null> {
  const raw = await redis.get<string>(TRACKING_SINCE_KEY);
  return typeof raw === 'string' ? raw : null;
}

export async function getConversationsTrackingSince(redis: any): Promise<string | null> {
  const raw = await redis.get<string>(CONVERSATIONS_TRACKING_SINCE_KEY);
  return typeof raw === 'string' ? raw : null;
}

export async function getAgentUsage(redis: any, agentKey: string): Promise<AgentUsage> {
  const [raw, members] = await Promise.all([
    redis.hgetall<Record<string, string | number>>(USAGE_KEY_PREFIX + agentKey),
    redis.smembers(CONVERSATIONS_KEY_PREFIX + agentKey),
  ]);
  const r = raw || {};
  return {
    inputTokens: Number(r.inputTokens) || 0,
    outputTokens: Number(r.outputTokens) || 0,
    cacheReadTokens: Number(r.cacheReadTokens) || 0,
    cacheCreationTokens: Number(r.cacheCreationTokens) || 0,
    calls: Number(r.calls) || 0,
    conversations: countByChannel(members),
  };
}

export async function resetAgentUsage(redis: any, agentKey: string): Promise<void> {
  await Promise.all([redis.del(USAGE_KEY_PREFIX + agentKey), redis.del(CONVERSATIONS_KEY_PREFIX + agentKey)]);
}

// Consumo entre dos fechas (inclusive, "YYYY-MM-DD" hora Colombia) para el reporte de
// día/semana/mes/personalizado — suma los baldes diarios que se llevan aparte en
// recordAgentUsage(). Días sin datos simplemente no aportan nada (nunca se creó esa llave).
export async function getAgentUsageRange(redis: any, agentKey: string, fromDate: string, toDate: string): Promise<AgentUsage> {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return EMPTY_USAGE();
  }
  const dates: string[] = [];
  for (let t = start.getTime(); t <= end.getTime() && dates.length <= MAX_RANGE_DAYS; t += 24 * 60 * 60 * 1000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  const [perDay, members] = await Promise.all([
    Promise.all(dates.map((d) => redis.hgetall<Record<string, string | number>>(DAILY_USAGE_KEY_PREFIX + agentKey + ':' + d))),
    // La unión de los conjuntos diarios deja cada conversación una sola vez aunque haya
    // durado varios días del rango.
    redis.sunion(...dates.map((d) => DAILY_CONVERSATIONS_KEY_PREFIX + agentKey + ':' + d)),
  ]);
  const totals = perDay.reduce(
    (acc, raw) => {
      const r = raw || {};
      acc.inputTokens += Number(r.inputTokens) || 0;
      acc.outputTokens += Number(r.outputTokens) || 0;
      acc.cacheReadTokens += Number(r.cacheReadTokens) || 0;
      acc.cacheCreationTokens += Number(r.cacheCreationTokens) || 0;
      acc.calls += Number(r.calls) || 0;
      return acc;
    },
    EMPTY_USAGE()
  );
  totals.conversations = countByChannel(members);
  return totals;
}

export async function getCostConfig(redis: any): Promise<CostConfig> {
  const raw = await redis.get<string>(COST_CONFIG_KEY);
  if (!raw) return DEFAULT_COST_CONFIG;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...DEFAULT_COST_CONFIG, ...parsed };
  } catch {
    return DEFAULT_COST_CONFIG;
  }
}

export async function setCostConfig(redis: any, partial: Partial<CostConfig>): Promise<CostConfig> {
  const current = await getCostConfig(redis);
  const updated = { ...current, ...partial };
  await redis.set(COST_CONFIG_KEY, JSON.stringify(updated));
  return updated;
}

export function computeCost(usage: AgentUsage, cost: CostConfig): { usd: number; cop: number } {
  // Tarifas de Anthropic: lectura de caché al 10 % del precio de entrada, escritura al 125 %.
  const billedInput = usage.inputTokens + (usage.cacheReadTokens || 0) * 0.1 + (usage.cacheCreationTokens || 0) * 1.25;
  const usd = (billedInput / 1_000_000) * cost.inputPricePerMTokUsd + (usage.outputTokens / 1_000_000) * cost.outputPricePerMTokUsd;
  return { usd, cop: usd * cost.usdToCop };
}
