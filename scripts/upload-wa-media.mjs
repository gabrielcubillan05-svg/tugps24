// Sube (privado) los archivos de material para el agente de WhatsApp a Vercel Blob, y arma
// la URL de nuestro propio endpoint público (/api/whatsapp-media-file) que los sirve sin login
// — porque Meta no puede iniciar sesión en la app para leer un blob privado directo.
//
// Uso (desde la carpeta del proyecto, con tu propia terminal):
//   $env:BLOB_READ_WRITE_TOKEN = "tu_token_de_vercel"
//   node scripts/upload-wa-media.mjs "C:\Users\USUARIO\Desktop\wa-media-listo"
//
// Copia la URL que imprime cada archivo en /interno/whatsapp-agent-media (solo admin).

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { put } from '@vercel/blob';

const SITE_URL = 'https://www.tugps24.com';

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('Falta la variable de entorno BLOB_READ_WRITE_TOKEN.');
  process.exit(1);
}

const dir = process.argv[2];
if (!dir) {
  console.error('Uso: node scripts/upload-wa-media.mjs <carpeta con los archivos>');
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
if (!files.length) {
  console.error('No hay archivos en esa carpeta.');
  process.exit(1);
}

for (const file of files) {
  const path = join(dir, file);
  const buffer = new Uint8Array(await readFile(path));
  const contentType = file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const blob = await put(`whatsapp-agent-media/${file}`, buffer, {
    access: 'private',
    token,
    contentType,
    addRandomSuffix: false,
  });
  const publicUrl = `${SITE_URL}/api/whatsapp-media-file?path=${encodeURIComponent(blob.pathname)}`;
  console.log(`${file} -> ${publicUrl}`);
}

console.log('\nListo. Copia cada URL en la página /interno/whatsapp-agent-media junto a la clave que corresponda.');
