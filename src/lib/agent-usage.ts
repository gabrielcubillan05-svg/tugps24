// Configuración e instrumentación compartida por los agentes de IA (Andrés, Valentina, y
// los que se agreguen después) — instrucciones extra por agente, contador de tokens
// consumidos y los parámetros para convertir ese consumo a un costo en pesos.

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
const COST_CONFIG_KEY = 'internal:agent-cost-config';

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
  await redis.hincrby(key, 'inputTokens', usage.inputTokens);
  await redis.hincrby(key, 'outputTokens', usage.outputTokens);
  await redis.hincrby(key, 'calls', 1);
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
