import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

// Huella visual dHash de 64 bits calculada en el servidor (misma fórmula que el navegador en
// interno-verificacion-pagos.js): la imagen en gris se reduce a 9x8 por promedio de áreas y cada
// bit dice si un píxel es más claro que el de su derecha. Dos capturas del mismo comprobante
// (recortadas, recomprimidas, reenviadas) quedan a pocos bits; comprobantes distintos, a 25 o más.
// Solo JPEG y PNG, decodificados en JS puro: no hay binarios nativos en la función.
export function dHashFromImage(bytes: Buffer, mediaType: string): string | null {
  let width: number;
  let height: number;
  let data: Uint8Array;
  try {
    if (mediaType === 'image/jpeg') {
      const img = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 40 });
      width = img.width;
      height = img.height;
      data = img.data;
    } else if (mediaType === 'image/png') {
      const img = PNG.sync.read(bytes);
      width = img.width;
      height = img.height;
      data = img.data;
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (!width || !height) return null;
  const gray = new Float64Array(72);
  const counts = new Float64Array(72);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(7, Math.floor((y * 8) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(8, Math.floor((x * 9) / width));
      const i = (y * width + x) * 4;
      const cell = gy * 9 + gx;
      gray[cell] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      counts[cell] += 1;
    }
  }
  for (let c = 0; c < 72; c++) gray[c] = counts[c] ? gray[c] / counts[c] : 0;
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      nibble = (nibble << 1) | (gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
      bits++;
      if (bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}
