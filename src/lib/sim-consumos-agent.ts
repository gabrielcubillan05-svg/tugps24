import { callAnthropicMessages, cachedSystemBlocks, withCachedTail, usageFromResponse, type SystemPrompt } from './anthropic-client';
import { recordAgentUsage } from './agent-usage';
import { describeNowInColombia } from './colombia-time';
import { statsForModel, type SimStats } from './sim-consumos';

const MODEL = 'claude-sonnet-5';

export interface SimLoteContext {
  id: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  dataStart?: string;
  dataEnd?: string;
  files: string[];
  stats: SimStats;
}

function systemPrompt(lote: SimLoteContext): SystemPrompt {
  const stable = `Eres GPSITO, el asistente interno de TuGPS24 (empresa colombiana de GPS para vehículos). Ahora ayudas a Cristian (encargado del inventario nacional) y a Josué a revisar los archivos de consumo de datos de las SIM que manda el operador Claro, uno por cuenta.

Contexto del negocio:
- Cada SIM va dentro de un equipo GPS instalado en un vehículo de un cliente. Un equipo normal reporta su posición de forma constante y consume entre 1 y 3 MB por semana. Un consumo muy por encima de eso suele ser configuración (frecuencia de reporte alta, equipo de otra marca) y un consumo cero es un equipo apagado, desconectado, un vehículo quieto o una SIM que está en inventario sin instalar.
- "Sobreconsumo" se mide contra el plan contratado por SIM (MB al mes) proyectando el consumo del periodo a 30 días. Las líneas por encima del plan cuestan dinero extra.
- Una SIM que aparece con dos IMEI distintos en el mismo periodo fue cambiada de equipo (reinstalación, garantía o un técnico probando). Un IMEI con varias líneas es un equipo al que le han puesto más de una SIM.
- Las líneas sin consumo marcadas "en inventario" están guardadas en una sucursal y es normal que no consuman; las que NO están en inventario deberían estar instaladas y hay que averiguar por qué no reportan.

Cómo respondes:
- En español, directo, para gente de operación, sin tecnicismos innecesarios. Usa los números que te dan; no inventes cifras ni líneas que no estén en los datos.
- Prioriza: primero lo que cuesta dinero o indica un vehículo sin protección, después lo informativo.
- Cuando listes líneas, pon el número de la línea y la cuenta, máximo 10 por lista, y di cuántas más hay.
- Termina siempre con una lista corta de acciones concretas (qué revisar, con quién, en qué cuenta).
- Si te preguntan algo que no se puede saber con estos datos (por ejemplo a qué cliente o placa pertenece una línea), dilo y sugiere dónde buscarlo en el panel (inventario, planillas, CRM).`;

  const volatile = `Hoy es ${describeNowInColombia()}.
Lote: "${lote.label}" · periodo declarado del reporte: del ${lote.periodStart} al ${lote.periodEnd}${lote.dataStart ? ` · fechas con datos en los archivos: del ${lote.dataStart} al ${lote.dataEnd}` : ''} · archivos: ${lote.files.join(', ')}.
Encabeza el informe con el título "Informe de consumo de SIM, del <fecha inicial> al <fecha final>" usando el periodo declarado. Si las fechas con datos no cubren todo el periodo declarado, dilo en el resumen.
Datos calculados del lote (JSON):
${JSON.stringify(statsForModel(lote.stats))}`;
  return { stable, volatile };
}

function extractText(data: any): string {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
}

async function run(redis: any, lote: SimLoteContext, messages: unknown[], logPrefix: string): Promise<string | null> {
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const data = await callAnthropicMessages(
    apiKey,
    { model: MODEL, max_tokens: 1800, system: cachedSystemBlocks(systemPrompt(lote)), messages: withCachedTail(messages) },
    logPrefix
  );
  if (!data) return null;
  await recordAgentUsage(redis, 'gabot', usageFromResponse(data), { id: `sim:${lote.id}`, channel: 'panel' });
  return extractText(data) || null;
}

export async function analyzeSimLote(redis: any, lote: SimLoteContext): Promise<string | null> {
  return run(
    redis,
    lote,
    [
      {
        role: 'user',
        content:
          'Analiza este lote de consumo de SIM. Estructura: 1) resumen en tres líneas (total, consumo típico, si hay o no sobreconsumo real); 2) sobreconsumo contra el plan: cuántas líneas, qué cuentas concentran el problema y las 10 más altas; 3) líneas sin consumo, separando las que están en inventario de las que no; 4) SIM cambiadas de equipo y equipos con varias SIM; 5) comparación con el lote anterior si existe; 6) acciones recomendadas en orden de prioridad.',
      },
    ],
    'sim-consumos:analisis'
  );
}

export async function askSimLote(redis: any, lote: SimLoteContext, history: { q: string; a: string }[], question: string): Promise<string | null> {
  const messages: unknown[] = [];
  for (const h of history.slice(-6)) {
    messages.push({ role: 'user', content: h.q });
    messages.push({ role: 'assistant', content: h.a });
  }
  messages.push({ role: 'user', content: question });
  return run(redis, lote, messages, 'sim-consumos:pregunta');
}
