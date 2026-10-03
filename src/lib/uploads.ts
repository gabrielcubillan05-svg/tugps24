// Validación de imágenes subidas por el personal. El tipo MIME lo declara el navegador y
// cualquiera puede mandar un SVG o bytes arbitrarios como "image/png"; se comprueba la firma
// real del archivo (primeros bytes) y solo pasan los formatos raster conocidos.
const SIGNATURES: { type: string; check: (b: Uint8Array) => boolean }[] = [
  { type: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', check: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/gif', check: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { type: 'image/webp', check: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

export async function isAllowedImageFile(file: File): Promise<boolean> {
  if (!(file instanceof File) || file.size < 12) return false;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return SIGNATURES.some((s) => s.check(head));
}

// Tipo real detectado, para guardarlo en Blob en vez del declarado por el cliente.
export async function detectImageType(file: File): Promise<string | null> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return SIGNATURES.find((s) => s.check(head))?.type || null;
}
