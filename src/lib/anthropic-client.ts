// Cliente compartido para llamar a la API de Anthropic desde los tres agentes (GPSITO, Andrés,
// Valentina) — antes cada uno tenía su propia copia de esto, y ninguna reintentaba: la primera
// falla (rate limit, sobrecarga momentánea de Anthropic, un timeout de red) hacía que el agente
// se rindiera de una vez y le devolviera al usuario el mensaje de "tuve un problema técnico".
// Un fallo transitorio SÍ vale la pena reintentar unos segundos después; uno persistente
// (créditos agotados, API key inválida) no lo arregla ningún reintento, así que ahí sí se rinde.

// 429 = rate limit, 500/502/503 = error de servidor genérico, 529 = "overloaded" propio de Anthropic.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const RETRY_DELAYS_MS = [1000, 2500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callAnthropicMessages(apiKey: string, body: Record<string, unknown>, logPrefix: string): Promise<any | null> {
  const maxAttempts = RETRY_DELAYS_MS.length + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(45_000),
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error(`${logPrefix}: fetch failed (intento ${attempt + 1}/${maxAttempts})`, err instanceof Error ? err.message : String(err));
      if (attempt < maxAttempts - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return null;
    }

    if (res.ok) {
      try {
        return await res.json();
      } catch (err) {
        console.error(`${logPrefix}: respuesta inválida`, err instanceof Error ? err.message : String(err));
        return null;
      }
    }

    const detail = await res.text().catch(() => '');
    console.error(`${logPrefix}: Anthropic respondió (intento ${attempt + 1}/${maxAttempts})`, res.status, detail.slice(0, 200));
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts - 1) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    return null;
  }

  return null;
}

// --- Caché de prompt -------------------------------------------------------------------
// El system prompt de cada agente pesa miles de tokens y es idéntico entre peticiones; con
// cache_control Anthropic lo cobra al 10 % en cada lectura (y al 125 % solo cuando lo escribe).
// La parte que cambia a cada rato (fecha y hora, datos del cliente de turno) va en un segundo
// bloque SIN marca, después del punto de corte, para no invalidar lo cacheado.
export interface SystemPrompt {
  stable: string;
  volatile: string;
}

export function cachedSystemBlocks(prompt: SystemPrompt): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text: prompt.stable, cache_control: { type: 'ephemeral' } }];
  if (prompt.volatile) blocks.push({ type: 'text', text: prompt.volatile });
  return blocks;
}

// Marca el último bloque del último mensaje: en la siguiente vuelta (respuesta del cliente,
// o la segunda llamada tras usar una herramienta) todo el historial anterior se lee de caché.
export function withCachedTail(messages: unknown[]): unknown[] {
  if (!messages.length) return messages;
  const out = messages.map((m: any) => ({ ...m }));
  const last: any = out[out.length - 1];
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(last.content) && last.content.length) {
    const blocks = last.content.map((b: any) => ({ ...b }));
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
    last.content = blocks;
  }
  return out;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function usageFromResponse(data: any): TokenUsage {
  return {
    inputTokens: Number(data?.usage?.input_tokens) || 0,
    outputTokens: Number(data?.usage?.output_tokens) || 0,
    cacheReadTokens: Number(data?.usage?.cache_read_input_tokens) || 0,
    cacheCreationTokens: Number(data?.usage?.cache_creation_input_tokens) || 0,
  };
}
