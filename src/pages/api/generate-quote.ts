import type { APIRoute } from 'astro';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { isAuthorized, AUTH_COOKIE } from '../../lib/internalAuth';

export const prerender = false;

const C = {
  ink900: rgb(10 / 255, 10 / 255, 10 / 255),
  ink800: rgb(21 / 255, 20 / 255, 18 / 255),
  paper: rgb(242 / 255, 237 / 255, 226 / 255),
  paperDim: rgb(201 / 255, 194 / 255, 178 / 255),
  slate: rgb(148 / 255, 141 / 255, 128 / 255),
  amber: rgb(255 / 255, 122 / 255, 26 / 255),
  tealBright: rgb(255 / 255, 171 / 255, 92 / 255),
  white: rgb(1, 1, 1),
  black: rgb(0, 0, 0),
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;

const BRANCHES: Record<string, string> = {
  Riohacha: 'Cra 15 No. 18-60, La Guajira · 316 383 4278',
  Valledupar: 'Barrio Los Cortijos, Cra. 19 #9C-32, Cesar · 317 646 4403',
  'Santa Marta': 'Cll 22 #17A-118, Barrio Alcázares, Magdalena · 318 605 2983',
  Maicao: 'Cra. 16 #16-21, La Guajira · 315 210 2244',
  Soledad: 'Cra 14 #59-37 · WhatsApp 316 784 2516',
  Barranquilla: 'Cra 44 #69-50 · WhatsApp 316 784 2516',
  Bucaramanga: 'Ak 27 #17-17, Santander · 311 610 8274',
  Medellín: 'Cra. 70 #30A-138, Belén, Antioquia · 311 610 5725',
  Montería: 'Cra 5 #39-69, Local 3 · WhatsApp 320 250 7432',
};

async function fetchImageBytes(origin: string, path: string): Promise<ArrayBuffer> {
  const res = await fetch(new URL(path, origin));
  return res.arrayBuffer();
}

function money(n: number): string {
  return '$' + n.toLocaleString('es-CO');
}

export const POST: APIRoute = async ({ request, cookies, url }) => {
  if (!isAuthorized(cookies.get(AUTH_COOKIE)?.value)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  let body: { client?: string; document?: string; email?: string; branch?: string; motos?: number; carros?: number };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const client = String(body.client || '').trim();
  const clientDoc = String(body.document || '').trim();
  const clientEmail = String(body.email || '').trim();
  const clientLabel = client || 'Cliente';
  const branch = String(body.branch || 'Riohacha').trim();
  const motos = Math.max(0, Number(body.motos) || 0);
  const carros = Math.max(0, Number(body.carros) || 0);
  const totalVehiculos = motos + carros;

  if (totalVehiculos <= 0) {
    return new Response(JSON.stringify({ error: 'debe indicar al menos un vehículo' }), { status: 400 });
  }

  const INSTALACION_UNIT = 150000;
  const flota = totalVehiculos > 5;
  const mensualidadMoto = flota ? 39000 : 44000;
  const mensualidadCarro = flota ? 39000 : 49000;

  const totalInstalacion = totalVehiculos * INSTALACION_UNIT;
  const totalMensual = motos * mensualidadMoto + carros * mensualidadCarro;

  const SEDE_PHOTOS: [string, string][] = [
    ['Riohacha', '/img/branches/riohacha/facade.jpg'],
    ['Maicao', '/img/branches/maicao/facade.jpg'],
    ['Santa Marta', '/img/branches/santa-marta/facade.jpg'],
    ['Valledupar', '/img/branches/valledupar/facade.jpg'],
    ['Barranquilla', '/img/branches/barranquilla/facade.jpg'],
    ['Soledad', '/img/branches/soledad/facade.jpg'],
    ['Bucaramanga', '/img/branches/bucaramanga/facade.jpg'],
    ['Medellín', '/img/branches/medellin/facade.jpg'],
    ['Montería', '/img/branches/monteria/facade.jpg'],
  ];
  const RECOVERY_PHOTOS = [
    '/img/recuperaciones/recuperacion-60.jpg',
    '/img/recuperaciones/recuperacion-58.jpg',
    '/img/recuperaciones/recuperacion-54.jpg',
    '/img/recuperaciones/recuperacion-50.jpg',
  ];

  const origin = url.origin;
  const [coverJpg, statsJpg, priceJpg, closeJpg, sedeJpgs, recoveryJpgs] = await Promise.all([
    fetchImageBytes(origin, '/img/central/central-1.jpg'),
    fetchImageBytes(origin, '/img/central/central-2.jpg'),
    fetchImageBytes(origin, '/img/central/central-video-poster.jpg'),
    fetchImageBytes(origin, '/img/recuperaciones/recuperacion-55.jpg'),
    Promise.all(SEDE_PHOTOS.map(([, p]) => fetchImageBytes(origin, p))),
    Promise.all(RECOVERY_PHOTOS.map((p) => fetchImageBytes(origin, p))),
  ]);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Cotización TuGPS24 — ${clientLabel}`);
  pdfDoc.setAuthor('TuGPS24 — Digital Global S.A.S.');

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const coverImg = await pdfDoc.embedJpg(coverJpg);
  const statsImg = await pdfDoc.embedJpg(statsJpg);
  const priceImg = await pdfDoc.embedJpg(priceJpg);
  const closeImg = await pdfDoc.embedJpg(closeJpg);
  const sedeImgs = await Promise.all(sedeJpgs.map((b) => pdfDoc.embedJpg(b)));
  const recoveryImgs = await Promise.all(recoveryJpgs.map((b) => pdfDoc.embedJpg(b)));

  // Solo seguro para fotos a página completa (0,0 a PAGE_W,PAGE_H): el desborde
  // queda recortado por el propio límite de la página.
  function drawCoverImage(page: any, img: any, boxX: number, boxY: number, boxW: number, boxH: number) {
    const scale = Math.max(boxW / img.width, boxH / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const x = boxX + (boxW - drawW) / 2;
    const y = boxY + (boxH - drawH) / 2;
    page.drawImage(img, { x, y, width: drawW, height: drawH });
  }

  // Seguro para recuadros que NO son la página completa: nunca se desborda,
  // puede dejar márgenes dentro de la caja en vez de recortar.
  function drawContainImage(page: any, img: any, boxX: number, boxY: number, boxW: number, boxH: number, bg = C.ink800) {
    page.drawRectangle({ x: boxX, y: boxY, width: boxW, height: boxH, color: bg });
    const scale = Math.min(boxW / img.width, boxH / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const x = boxX + (boxW - drawW) / 2;
    const y = boxY + (boxH - drawH) / 2;
    page.drawImage(img, { x, y, width: drawW, height: drawH });
  }

  const today = new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });

  // ---------- PAGE 1: Cover ----------
  {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    drawCoverImage(page, coverImg, 0, 0, PAGE_W, PAGE_H);

    // dark overlay bottom 40%
    const overlayH = PAGE_H * 0.42;
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: overlayH, color: C.ink900, opacity: 0.82 });
    page.drawRectangle({ x: 0, y: overlayH - 4, width: PAGE_W, height: 4, color: C.amber });

    page.drawText('tuGps24.com', { x: 40, y: overlayH - 46, size: 22, font: fontBold, color: C.amber });
    page.drawText('RASTREO SATELITAL · CENTRAL DE MONITOREO 24/7', {
      x: 40, y: overlayH - 66, size: 9.5, font: fontBold, color: C.tealBright,
    });

    page.drawText('Cotización de instalación GPS', {
      x: 40, y: overlayH - 110, size: 26, font: fontBold, color: C.white,
    });
    page.drawText(`Preparada para: ${clientLabel}`, { x: 40, y: overlayH - 140, size: 14, font: fontRegular, color: C.paper });
    page.drawText(`Sucursal: ${branch}  ·  Fecha: ${today}`, {
      x: 40, y: overlayH - 160, size: 11, font: fontRegular, color: C.paperDim,
    });
  }

  // ---------- PAGE 2: Quiénes somos ----------
  {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: C.ink900 });
    page.drawRectangle({ x: 0, y: PAGE_H - 90, width: PAGE_W, height: 90, color: C.ink800 });
    page.drawText('¿Quiénes somos?', { x: 40, y: PAGE_H - 58, size: 22, font: fontBold, color: C.amber });

    const paragraph = [
      'Somos una empresa colombiana fundada en Riohacha, La Guajira, en 2016, con la',
      'finalidad de aumentar la seguridad vehicular en el país. Desde entonces hemos',
      'implementado un sistema de rastreo satelital que permite visualizar en tiempo real',
      'la ubicación del vehículo, la velocidad a la que circula, el estado del motor y su',
      'recorrido — todo respaldado por una central de monitoreo con operadores reales,',
      'no un algoritmo.',
    ];
    paragraph.forEach((line, i) => {
      page.drawText(line, { x: 40, y: PAGE_H - 130 - i * 16, size: 11.5, font: fontRegular, color: C.paper });
    });

    drawContainImage(page, statsImg, 40, 300, 220, 300);
    page.drawRectangle({ x: 40, y: 300, width: 220, height: 300, borderColor: C.amber, borderWidth: 1.5 });

    const stats: [string, string][] = [
      ['9', 'Sucursales propias'],
      ['40+', 'Operadores en turno'],
      ['1.650+', 'Vehículos recuperados'],
      ['10', 'Años operando'],
    ];
    stats.forEach(([num, label], i) => {
      const bx = 300;
      const by = 550 - i * 62;
      page.drawText(num, { x: bx, y: by, size: 24, font: fontBold, color: C.amber });
      page.drawText(label, { x: bx, y: by - 18, size: 10.5, font: fontRegular, color: C.paperDim });
    });

    const perks = [
      'Bloqueo y apagado remoto del motor',
      'Geocercas con confirmación telefónica',
      'Enlace directo con la Policía Nacional',
      'App móvil + plataforma web',
      'Cobertura y monitoreo en todo el país',
    ];
    page.drawText('Ventajas de nuestro servicio', { x: 40, y: 260, size: 13, font: fontBold, color: C.tealBright });
    perks.forEach((p, i) => {
      page.drawText('•  ' + p, { x: 40, y: 236 - i * 18, size: 10.5, font: fontRegular, color: C.paper });
    });
  }

  // ---------- PAGE: Nuestras sedes ----------
  {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: C.paper });
    page.drawRectangle({ x: 0, y: PAGE_H - 90, width: PAGE_W, height: 90, color: C.ink900 });
    page.drawText('Nuestras sedes', { x: 40, y: PAGE_H - 58, size: 22, font: fontBold, color: C.amber });
    page.drawText('Nueve sucursales propias en el Caribe y el interior de Colombia.', {
      x: 40, y: PAGE_H - 76, size: 10.5, font: fontRegular, color: C.paperDim,
    });

    const cols = 3;
    const gap = 16;
    const gridX = 40;
    const gridTop = PAGE_H - 120;
    const cellW = (PAGE_W - 80 - gap * (cols - 1)) / cols;
    const photoH = 120;
    const rowH = photoH + 28;

    SEDE_PHOTOS.forEach(([name], i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gridX + col * (cellW + gap);
      const y = gridTop - row * (rowH + gap) - photoH;
      drawContainImage(page, sedeImgs[i], x, y, cellW, photoH, C.ink800);
      page.drawRectangle({ x, y, width: cellW, height: photoH, borderColor: C.amber, borderWidth: 1 });
      page.drawText(name, { x, y: y - 16, size: 10.5, font: fontBold, color: C.ink900 });
    });
  }

  // ---------- PAGE: Resultados reales ----------
  {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: C.ink900 });
    page.drawRectangle({ x: 0, y: PAGE_H - 90, width: PAGE_W, height: 90, color: C.ink800 });
    page.drawText('Resultados que hablan por nosotros', { x: 40, y: PAGE_H - 58, size: 20, font: fontBold, color: C.amber });
    page.drawText('Algunas de nuestras recuperaciones más recientes.', {
      x: 40, y: PAGE_H - 76, size: 10.5, font: fontRegular, color: C.paperDim,
    });

    const gap = 14;
    const cellW = (PAGE_W - 80 - gap * (recoveryImgs.length - 1)) / recoveryImgs.length;
    const cellH = 340;
    const y = PAGE_H - 130 - cellH;
    recoveryImgs.forEach((img, i) => {
      const x = 40 + i * (cellW + gap);
      drawContainImage(page, img, x, y, cellW, cellH, C.ink800);
      page.drawRectangle({ x, y, width: cellW, height: cellH, borderColor: C.amber, borderWidth: 1 });
    });

    page.drawText('Más de 1.650 vehículos recuperados en 10 años operando en Colombia.', {
      x: 40, y: y - 30, size: 11.5, font: fontRegular, color: C.paper,
    });
  }

  // ---------- PAGE 3: Cotización ----------
  {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: C.paper });
    page.drawRectangle({ x: 0, y: PAGE_H - 90, width: PAGE_W, height: 90, color: C.ink900 });
    page.drawText('Tu cotización', { x: 40, y: PAGE_H - 58, size: 22, font: fontBold, color: C.amber });
    const clientLine = [clientLabel, clientDoc && `Doc: ${clientDoc}`, clientEmail, branch, today]
      .filter(Boolean)
      .join('  ·  ');
    page.drawText(clientLine, {
      x: 40, y: PAGE_H - 76, size: 10, font: fontRegular, color: C.paperDim,
    });

    let y = PAGE_H - 140;
    const colX = [40, 220, 320, 430];
    const headers = ['Tipo', 'Cantidad', 'Instalación c/u', 'Mensualidad c/u'];
    page.drawRectangle({ x: 40, y: y - 6, width: PAGE_W - 80, height: 26, color: C.ink900 });
    headers.forEach((h, i) => {
      page.drawText(h, { x: colX[i] + 6, y: y, size: 10, font: fontBold, color: C.amber });
    });
    y -= 34;

    function row(tipo: string, cant: number, mensual: number) {
      if (cant <= 0) return;
      page.drawText(tipo, { x: colX[0] + 6, y, size: 11, font: fontRegular, color: C.black });
      page.drawText(String(cant), { x: colX[1] + 6, y, size: 11, font: fontRegular, color: C.black });
      page.drawText(money(INSTALACION_UNIT), { x: colX[2] + 6, y, size: 11, font: fontRegular, color: C.black });
      page.drawText(money(mensual), { x: colX[3] + 6, y, size: 11, font: fontRegular, color: C.black });
      y -= 24;
    }
    row('Motos', motos, mensualidadMoto);
    row('Carros', carros, mensualidadCarro);

    y -= 10;
    page.drawRectangle({ x: 40, y, width: PAGE_W - 80, height: 1, color: C.slate });
    y -= 30;

    page.drawText('Total instalación (pago único):', { x: 40, y, size: 12, font: fontRegular, color: C.black });
    page.drawText(money(totalInstalacion), { x: 320, y, size: 14, font: fontBold, color: C.ink900 });
    y -= 26;
    page.drawText('Mensualidad total (desde el 2º mes):', { x: 40, y, size: 12, font: fontRegular, color: C.black });
    page.drawText(money(totalMensual) + '/mes', { x: 320, y, size: 14, font: fontBold, color: C.ink900 });
    y -= 30;

    page.drawRectangle({ x: 40, y: y - 8, width: PAGE_W - 80, height: 36, color: rgb(1, 0.9, 0.8) });
    page.drawText('Incluido: primer mes de monitoreo GRATIS', {
      x: 52, y: y + 6, size: 11.5, font: fontBold, color: rgb(0.75, 0.35, 0.05),
    });
    y -= 50;

    if (flota) {
      page.drawText(
        `Tarifa especial de flota aplicada: al superar 5 vehículos, todos pasan a ${money(39000)}/mes cada uno.`,
        { x: 40, y, size: 10, font: fontRegular, color: C.slate }
      );
      y -= 30;
    }

    drawContainImage(page, priceImg, PAGE_W - 220, 60, 180, 220, C.paper);
    page.drawRectangle({ x: PAGE_W - 220, y: 60, width: 180, height: 220, borderColor: C.amber, borderWidth: 1.5 });

    page.drawText('Cotización válida por 15 días.', { x: 40, y: 70, size: 9, font: fontRegular, color: C.slate });
    page.drawText('Precios en pesos colombianos (COP), no incluyen IVA si aplica.', {
      x: 40, y: 56, size: 9, font: fontRegular, color: C.slate,
    });
  }

  // ---------- PAGE 4: Contacto ----------
  {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: C.ink900 });

    page.drawRectangle({ x: 0, y: PAGE_H - 130, width: PAGE_W, height: 130, color: C.ink800 });
    page.drawRectangle({ x: 0, y: PAGE_H - 134, width: PAGE_W, height: 4, color: C.amber });
    page.drawText('Gracias por confiar en TuGPS24', {
      x: 40, y: PAGE_H - 58, size: 20, font: fontBold, color: C.white,
    });
    page.drawText('Escríbenos y agenda tu instalación cuando quieras.', {
      x: 40, y: PAGE_H - 80, size: 11.5, font: fontRegular, color: C.paperDim,
    });
    page.drawText('WhatsApp: 316 610 5725   ·   Correo: ventas@tugps24.com   ·   Web: www.tugps24.com', {
      x: 40, y: PAGE_H - 108, size: 10.5, font: fontRegular, color: C.paper,
    });

    const rightBoxX = PAGE_W - 205;
    const rightBoxW = 165;
    const rightBoxY = 70;
    const rightBoxH = PAGE_H - 130 - 90;
    drawContainImage(page, closeImg, rightBoxX, rightBoxY, rightBoxW, rightBoxH, C.ink800);
    page.drawRectangle({ x: rightBoxX, y: rightBoxY, width: rightBoxW, height: rightBoxH, borderColor: C.amber, borderWidth: 1.5 });

    page.drawText('Nuestras sucursales', { x: 40, y: PAGE_H - 170, size: 13, font: fontBold, color: C.tealBright });
    let by = PAGE_H - 194;
    const leftColW = rightBoxX - 60;
    Object.entries(BRANCHES).forEach(([name, addr]) => {
      page.drawText(name + ':', { x: 40, y: by, size: 9.5, font: fontBold, color: C.paper });
      page.drawText(addr, { x: 40, y: by - 13, size: 8.8, font: fontRegular, color: C.paperDim, maxWidth: leftColW });
      by -= 34;
    });

    page.drawText('TuGPS24 — Digital Global S.A.S. · NIT 900.996.607-9', {
      x: 40, y: 40, size: 9, font: fontRegular, color: C.slate,
    });
  }

  const pdfBytes = await pdfDoc.save();

  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="Cotizacion-TuGPS24-${clientLabel.replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`,
    },
  });
};
