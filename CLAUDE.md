# TuGPS24

## Stack
Astro v7 (`output:'server'`), `@astrojs/vercel` adapter, Upstash Redis (todos los datos), Vercel Blob (fotos/firmas/PDFs), Anthropic API (GPSITO/Andrés/Valentina), Meta WhatsApp Cloud API. Deploy: push a GitHub → auto-deploy Vercel.

## Mapa
- `src/pages/interno/` — páginas del panel admin (una por sección, todas gateadas por sesión+rol vía `lib/auth.ts`).
- `src/pages/api/` — toda la lógica de backend; un archivo por módulo (tasks.ts, leads.ts, users.ts, etc.) exporta también helpers reusables (readX, computeX).
- `src/lib/` — compartido entre rutas: `auth.ts` (sesión/roles/permisos), `gabot-agent.ts`/`sales-agent.ts`/`collections-agent.ts` (los 3 agentes IA), `anthropic-client.ts` (llamada+retry compartida), `colombia-time.ts` (fechas en zona Colombia), `rate-limit.ts`, `notifications.ts`, `shift.ts`.
- `public/js/interno-*.js` — JS del panel, un archivo por página, sin build step (vanilla).
- `src/components/` + `src/layouts/BaseLayout.astro` — sitio público (marketing).
- `.claude/launch.json` — config para levantar `astro dev` desde el Browser tool.

## Comandos
dev: en Bash, `cd` explícito primero (el shell resetea el cwd a otra carpeta entre comandos) → `npx astro dev --port 4321` en background, o usar preview_start con "tugps24-dev".
build: `cd /c/Users/USUARIO/Desktop/tugps24-astro && npx astro build 2>&1 | tail -60`
No hay suite de tests.

## Convenciones
- Cada endpoint mutante llama `verifySameOrigin(request)` primero; cada uno gatea acceso con `getSession` + una función `canX`/`canAccessSection` de `auth.ts` — nunca confiar en el rol crudo.
- Comentarios solo explican el PORQUÉ (un bug pasado, una regla de negocio no obvia), nunca el qué.
- Antes de duplicar una utilidad (fechas Colombia, rate limit, llamada a Anthropic) revisar `src/lib/` — ya existe un helper compartido para eso.
- Workflow de git: build → commit en español terminando en `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` → preguntar "¿Confirmas el push?" → esperar "si"/"si push" → push en background.
- Sin credenciales de Redis/Anthropic/Blob en local — no se puede probar el panel interno con sesión real desde aquí; el sitio público sí es previsualizable.

## No leer
`node_modules/`, `dist/`, `.vercel/`, `public/videos/`, `public/img/` (media pesada), `.env`.


When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
