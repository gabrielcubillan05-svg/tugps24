# TuGPS24

Sitio público y panel interno de TuGPS24. Astro v7 en modo servidor desplegado en Vercel; Upstash Redis como base de datos, Vercel Blob para archivos (fotos, firmas, PDF), Anthropic para los agentes (GPSITO, Andrés, Valentina) y Meta WhatsApp Cloud API. Ver `CLAUDE.md` para el mapa del código y las convenciones.

## Comandos

| Comando | Qué hace |
| :-- | :-- |
| `npm install` | Instala dependencias |
| `npm run dev` | Servidor local en `localhost:4321` |
| `npm run build` | Compila a `./dist/` (se corre antes de cada commit) |

No hay suite de tests. El deploy es automático: push a `main` → Vercel.

## Variables de entorno

Se configuran en Vercel (Project → Settings → Environment Variables). En local van en `.env` (ignorado por git).

| Variable | Servicio | Obligatoria | Para qué |
| :-- | :-- | :-- | :-- |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis | sí (o las dos de abajo) | Toda la base de datos del panel |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis | alternativa a las anteriores | Mismo uso; se toma la pareja que exista |
| `SESSION_SECRET` | panel | sí | Firma de la cookie de sesión del panel interno |
| `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` | panel | solo la primera vez | Crea el primer administrador si no hay usuarios |
| `CRON_SECRET` | Vercel Cron | sí | Autoriza las llamadas de los crons (`/api/*-cron`); sin ella los crons responden 401 |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob | sí | Fotos, firmas, PDF, archivos anuales, respaldos diarios, lotes de SIM |
| `ANTHROPIC_API_KEY` | Anthropic | sí para los agentes | GPSITO, Andrés (ventas), Valentina (cobranza), informe de consumo de SIM |
| `OPENAI_API_KEY` | OpenAI | sí para audios de WhatsApp | Transcripción de notas de voz (Whisper) |
| `META_WHATSAPP_TOKEN` | Meta | sí para WhatsApp | Envío de mensajes, plantillas y archivos |
| `META_PHONE_NUMBER_ID` | Meta | sí para WhatsApp | Número emisor; el webhook ignora mensajes de otros números |
| `META_APP_SECRET` | Meta | sí para WhatsApp | Verifica la firma HMAC de cada webhook |
| `META_WEBHOOK_VERIFY_TOKEN` | Meta | sí para WhatsApp | Verificación inicial del webhook (GET) |
| `META_PAGE_ACCESS_TOKEN` | Meta | sí para formularios de anuncios | Lee los leads del webhook de Lead Ads |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push | sí para notificaciones push | Firma de los avisos push del panel |
| `VERCEL_GIT_COMMIT_SHA` / `VERCEL_DEPLOYMENT_ID` | Vercel (automáticas) | no | Identificador de versión para avisar al navegador de un deploy nuevo |

Monitoreo externo: `GET /api/health` responde 200 si Redis contesta y todos los crons corrieron dentro de su plazo; 503 si no. No requiere sesión.
