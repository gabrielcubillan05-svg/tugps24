import type { APIRoute } from 'astro';
import { SESSION_COOKIE, getSession, canManageAiAgents, verifySameOrigin } from '../../lib/auth';
import { getRedis } from '../../lib/redis';
import {
  AGENTS,
  getExtraInstructions,
  setExtraInstructions,
  getAgentUsage,
  resetAgentUsage,
  getCostConfig,
  setCostConfig,
  computeCost,
} from '../../lib/agent-usage';
import { readLeads, computeSalesAgentStats } from './leads';
import { readCobros, computeAgentStats as computeCollectionsAgentStats } from './cobros';

export const prerender = false;

async function requireAccess(cookies: any) {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageAiAgents(session)) return null;
  return session;
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await requireAccess(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const costConfig = await getCostConfig(redis);
  const [allLeads, allCobros] = await Promise.all([readLeads(redis), readCobros(redis)]);
  const resultsByAgent: Record<string, unknown> = {
    andres: computeSalesAgentStats(allLeads),
    valentina: computeCollectionsAgentStats(allCobros),
  };

  const agents = await Promise.all(
    AGENTS.map(async (a) => {
      const [extraInstructions, usage] = await Promise.all([
        getExtraInstructions(redis, a.key),
        getAgentUsage(redis, a.key),
      ]);
      return { ...a, extraInstructions, usage, cost: computeCost(usage, costConfig), results: resultsByAgent[a.key] || null };
    })
  );

  return new Response(JSON.stringify({ agents, costConfig }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await requireAccess(cookies);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const validAgentKeys = AGENTS.map((a) => a.key);

  if (body.action === 'setInstructions') {
    const agentKey = String(body.agent || '');
    if (!validAgentKeys.includes(agentKey)) {
      return new Response(JSON.stringify({ error: 'agente inválido' }), { status: 400 });
    }
    await setExtraInstructions(redis, agentKey, String(body.text || ''));
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'resetUsage') {
    const agentKey = String(body.agent || '');
    if (!validAgentKeys.includes(agentKey)) {
      return new Response(JSON.stringify({ error: 'agente inválido' }), { status: 400 });
    }
    await resetAgentUsage(redis, agentKey);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'setCostConfig') {
    const usdToCop = Number(body.usdToCop);
    const inputPricePerMTokUsd = Number(body.inputPricePerMTokUsd);
    const outputPricePerMTokUsd = Number(body.outputPricePerMTokUsd);
    if (![usdToCop, inputPricePerMTokUsd, outputPricePerMTokUsd].every((n) => Number.isFinite(n) && n > 0)) {
      return new Response(JSON.stringify({ error: 'valores inválidos' }), { status: 400 });
    }
    const updated = await setCostConfig(redis, { usdToCop, inputPricePerMTokUsd, outputPricePerMTokUsd });
    return new Response(JSON.stringify({ costConfig: updated }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'acción desconocida' }), { status: 400 });
};
