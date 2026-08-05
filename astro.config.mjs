// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.tugps24.com',
  output: 'server',
  adapter: vercel(),
  redirects: {
    '/inicio': '/',
  },
});
