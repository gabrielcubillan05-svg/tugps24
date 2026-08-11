import type { APIRoute } from 'astro';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { readLeads, normalizePhone, REDIS_KEY, type Lead } from './leads';

export const prerender = false;

const GRAPH_VERSION = 'v19.0';
const META_ACTOR = { userId: 'meta-webhook', username: 'Meta Lead Ads' };

// Meta llama a este GET una sola vez para verificar que el webhook es tuyo,
// enviando el mismo hub.verify_token que configuraste en Meta for Developers.
export const GET: APIRoute = async ({ url }) => {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = import.meta.env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('forbidden', { status: 403 });
};

function verifySignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const providedHex = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(providedHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function fetchLeadData(leadgenId: string, accessToken: string): Promise<any> {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}?access_token=${encodeURIComponent(accessToken)}`);
  if (!res.ok) throw new Error(`graph leadgen error ${res.status}`);
  return res.json();
}

async function fetchAdLabel(adId: string, accessToken: string): Promise<string> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${adId}?fields=name,campaign{name}&access_token=${encodeURIComponent(accessToken)}`
    );
    if (!res.ok) return '';
    const data = await res.json();
    const campaignName = data?.campaign?.name;
    return campaignName ? `${campaignName} · ${data.name}` : data?.name || '';
  } catch {
    return '';
  }
}

export const POST: APIRoute = async ({ request }) => {
  const appSecret = import.meta.env.META_APP_SECRET;
  const pageAccessToken = import.meta.env.META_PAGE_ACCESS_TOKEN;
  if (!appSecret || !pageAccessToken) {
    return new Response('not configured', { status: 503 });
  }

  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers.get('x-hub-signature-256'), appSecret)) {
    return new Response('invalid signature', { status: 403 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('invalid body', { status: 400 });
  }

  const redis = getRedis();
  if (!redis) {
    // Meta reintentará si no respondemos 200 rápido; sin Redis no hay nada que guardar.
    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change.field !== 'leadgen') continue;
      const leadgenId = change.value?.leadgen_id;
      const adId = change.value?.ad_id;
      if (!leadgenId) continue;

      try {
        const existingLeads = await readLeads(redis);
        if (existingLeads.some((l) => l.metaLeadId === String(leadgenId))) continue; // reintento de Meta, ya procesado

        const leadData = await fetchLeadData(String(leadgenId), pageAccessToken);
        const fields: Record<string, string> = {};
        for (const f of leadData.field_data || []) {
          const key = String(f.name || '').toLowerCase();
          fields[key] = Array.isArray(f.values) ? String(f.values[0] || '') : '';
        }
        const phone = fields['phone_number'] || fields['phone'] || '';
        if (!phone) {
          await logAudit(redis, META_ACTOR, 'lead_meta_import_skipped', String(leadgenId), 'sin teléfono en el formulario');
          continue;
        }
        const name =
          fields['full_name'] || [fields['first_name'], fields['last_name']].filter(Boolean).join(' ') || phone;
        const city = fields['city'] || '';
        const campaignLabel = adId ? await fetchAdLabel(String(adId), pageAccessToken) : '';

        const normalizedPhone = normalizePhone(phone);
        const dup = existingLeads.find((l) => normalizePhone(l.phone) === normalizedPhone);
        const now = new Date().toISOString();

        if (dup) {
          dup.metaLeadId = String(leadgenId);
          dup.notes = [
            { text: `Nuevo formulario de Meta recibido${campaignLabel ? ' (' + campaignLabel + ')' : ''}.`, date: now },
            ...dup.notes,
          ];
          dup.updatedAt = now;
          await redis.hset(REDIS_KEY, { [dup.id]: JSON.stringify(dup) });
        } else {
          const lead: Lead = {
            id: randomUUID(),
            name,
            phone,
            city,
            campaign: campaignLabel || 'Meta Lead Ads',
            secretary: '',
            status: 'Nuevo',
            nextFollowUp: null,
            convertedBranch: null,
            vehicleType: '',
            motosCount: 0,
            carrosCount: 0,
            installed: false,
            verifiedInstalled: false,
            verifiedInstalledAt: null,
            source: 'meta-leadgen',
            metaLeadId: String(leadgenId),
            createdByName: 'Meta Lead Ads',
            notes: [],
            createdAt: now,
            updatedAt: now,
          };
          await redis.hset(REDIS_KEY, { [lead.id]: JSON.stringify(lead) });
        }
        await logAudit(redis, META_ACTOR, 'lead_meta_import', name, phone);
      } catch (err) {
        await logAudit(
          redis,
          META_ACTOR,
          'lead_meta_import_error',
          String(leadgenId),
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  return new Response('EVENT_RECEIVED', { status: 200 });
};
