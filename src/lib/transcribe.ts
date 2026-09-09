const GRAPH_VERSION = 'v21.0';
const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // límite generoso, las notas de voz de WhatsApp son livianas

interface DownloadedMedia {
  buffer: ArrayBuffer;
  mimeType: string;
}

async function downloadWhatsappMedia(mediaId: string): Promise<DownloadedMedia | null> {
  const token = import.meta.env.META_WHATSAPP_TOKEN || import.meta.env.META_PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error('transcribe: falta token de Meta para descargar el audio');
    return null;
  }

  try {
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) {
      console.error('transcribe: no se pudo obtener el media', metaRes.status, await metaRes.text().catch(() => ''));
      return null;
    }
    const meta = await metaRes.json();
    const url = meta?.url;
    const mimeType = String(meta?.mime_type || 'audio/ogg');
    if (!url) return null;

    const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!fileRes.ok) {
      console.error('transcribe: no se pudo descargar el archivo', fileRes.status);
      return null;
    }
    const buffer = await fileRes.arrayBuffer();
    if (buffer.byteLength > MAX_AUDIO_BYTES) {
      console.error('transcribe: audio demasiado grande', buffer.byteLength);
      return null;
    }
    return { buffer, mimeType };
  } catch (err) {
    console.error('transcribe: error descargando media', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('amr')) return 'amr';
  return 'ogg';
}

async function transcribeAudioBuffer(buffer: ArrayBuffer, mimeType: string): Promise<string | null> {
  const apiKey = import.meta.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('transcribe: falta OPENAI_API_KEY');
    return null;
  }

  try {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    form.append('file', blob, `audio.${extensionFor(mimeType)}`);
    form.append('model', 'whisper-1');
    form.append('language', 'es');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      console.error('transcribe: OpenAI respondió', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    return text || null;
  } catch (err) {
    console.error('transcribe: error llamando a OpenAI', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// Descarga una nota de voz de WhatsApp (por su media id) y la transcribe a texto en español.
// Devuelve null si falla cualquier paso (falta configuración, Meta no entrega el archivo,
// OpenAI no puede transcribirlo, etc.) — quien la llame debe tener un mensaje de respaldo.
export async function transcribeWhatsappAudio(mediaId: string): Promise<string | null> {
  const media = await downloadWhatsappMedia(mediaId);
  if (!media) return null;
  return transcribeAudioBuffer(media.buffer, media.mimeType);
}
