// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.tugps24.com',
  output: 'server',
  // Hasta 5 minutos: cargas grandes (consumo de SIM, cotizaciones) y los agentes de IA.
  adapter: vercel({ maxDuration: 300 }),
  redirects: {
    '/inicio': '/',
    '/operadores': '/interno/novedades',
    '/cotizaciones': '/interno/cotizaciones',
    '/secretarias': '/interno/crm',
  },
});
