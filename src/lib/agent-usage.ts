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
const COST_CONFIG_KEY = 'internal:agent-cost-config';
// Tope defensivo para una consulta "personalizada" — evita pedirle a Redis miles de llaves
// de un rango absurdo por un typo en las fechas.
const MAX_RANGE_DAYS = 366;

export interface CostConfig {
  usdToCop: number;
  inputPricePerMTokUsd: number;
  outputPricePerMTokUsd: number;
}

// Precios por defecto de Claude Sonnet (USD por millón de tokens) y una tasa de cambio
// aproximada — verifica y ajusta ambos en el menú de IA, ya que pueden cambiar.
const DEFAULT_COST_CONFIG: CostConfig = {
  usdToCop: 4000,
  inputPricePerMTokUsd: 3,
  outputPricePerMTokUsd: 15,
};

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
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
  usage: { inputTokens: number; outputTokens: number }
): Promise<void> {
  if (!usage.inputTokens && !usage.outputTokens) return;
  const key = USAGE_KEY_PREFIX + agentKey;
  const today = todayInColombia();
  const dailyKey = DAILY_USAGE_KEY_PREFIX + agentKey + ':' + today;
  await Promise.all([
    redis.hincrby(key, 'inputTokens', usage.inputTokens),
    redis.hincrby(key, 'outputTokens', usage.outputTokens),
    redis.hincrby(key, 'calls', 1),
    redis.hincrby(dailyKey, 'inputTokens', usage.inputTokens),
    redis.hincrby(dailyKey, 'outputTokens', usage.outputTokens),
    redis.hincrby(dailyKey, 'calls', 1),
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

export async function getAgentUsage(redis: any, agentKey: string): Promise<AgentUsage> {
  const raw = (await redis.hgetall<Record<string, string | number>>(USAGE_KEY_PREFIX + agentKey)) || {};
  return {
    inputTokens: Number(raw.inputTokens) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
    calls: Number(raw.calls) || 0,
  };
}

export async function resetAgentUsage(redis: any, agentKey: string): Promise<void> {
  await redis.del(USAGE_KEY_PREFIX + agentKey);
}

// Consumo entre dos fechas (inclusive, "YYYY-MM-DD" hora Colombia) para el reporte de
// día/semana/mes/personalizado — suma los baldes diarios que se llevan aparte en
// recordAgentUsage(). Días sin datos simplemente no aportan nada (nunca se creó esa llave).
export async function getAgentUsageRange(redis: any, agentKey: string, fromDate: string, toDate: string): Promise<AgentUsage> {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return { inputTokens: 0, outputTokens: 0, calls: 0 };
  }
  const dates: string[] = [];
  for (let t = start.getTime(); t <= end.getTime() && dates.length <= MAX_RANGE_DAYS; t += 24 * 60 * 60 * 1000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  const perDay = await Promise.all(
    dates.map((d) => redis.hgetall<Record<string, string | number>>(DAILY_USAGE_KEY_PREFIX + agentKey + ':' + d))
  );
  return perDay.reduce(
    (acc, raw) => {
      const r = raw || {};
      acc.inputTokens += Number(r.inputTokens) || 0;
      acc.outputTokens += Number(r.outputTokens) || 0;
      acc.calls += Number(r.calls) || 0;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, calls: 0 }
  );
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
  const usd = (usage.inputTokens / 1_000_000) * cost.inputPricePerMTokUsd + (usage.outputTokens / 1_000_000) * cost.outputPricePerMTokUsd;
  return { usd, cop: usd * cost.usdToCop };
}
