// Sube a Vercel Blob (acceso público) los archivos de material para el agente de WhatsApp.
// Uso (desde la carpeta del proyecto, con tu propia terminal):
//   $env:BLOB_READ_WRITE_TOKEN = "tu_token_de_vercel"
//   node scripts/upload-wa-media.mjs "C:\Users\USUARIO\AppData\Local\Temp\claude\...\wa-media"
//
// Imprime, por cada archivo, la clave sugerida y la URL pública resultante —
// copia esas URLs en /interno/whatsapp-agent-media (solo admin) para activarlas.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { put } from '@vercel/blob';

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
  const buffer = new Uint8Array(await import('node:fs/promises').then((fs) => fs.readFile(path)));
  const contentType = file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const blob = await put(`whatsapp-agent-media/${file}`, buffer, {
    access: 'public',
    token,
    contentType,
    addRandomSuffix: false,
  });
  console.log(`${file} -> ${blob.url}`);
}

console.log('\nListo. Copia cada URL en la página /interno/whatsapp-agent-media junto a la clave que corresponda.');
