import ExcelJS from 'exceljs';
import { branchForCityName } from './pricing';
import { dateTimeInColombia } from './colombia-time';
import type { Lead } from '../pages/api/leads';

// Excel de leads para el CRM y para el listado de concretados por Andrés. Reemplaza al CSV
// armado en el navegador: Excel en Colombia espera ';' como separador, así que el CSV con comas
// salía todo en una columna, con fechas ISO y las notas pegadas en una sola celda.
const CANAL: Record<string, string> = { 'whatsapp-ads': 'WhatsApp Ads', 'web-chat': 'Chat web', 'meta-leadgen': 'Formulario Meta', manual: 'Manual' };

export function esConcretadoPorAndres(l: Lead): boolean {
  return (l.source === 'whatsapp-ads' || l.source === 'web-chat') && l.aiStage === 'entregado';
}

export async function buildLeadsWorkbook(leads: Lead[], sheetName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.columns = [
    { header: 'Nombre', key: 'nombre', width: 28 },
    { header: 'Teléfono', key: 'telefono', width: 16 },
    { header: 'Ciudad', key: 'ciudad', width: 16 },
    { header: 'Sucursal', key: 'sucursal', width: 16 },
    { header: 'Canal', key: 'canal', width: 15 },
    { header: 'Campaña', key: 'campana', width: 20 },
    { header: 'Secretaria', key: 'secretaria', width: 24 },
    { header: 'Estado', key: 'estado', width: 24 },
    { header: 'Próximo seguimiento', key: 'seguimiento', width: 14 },
    { header: 'Tipo de cliente', key: 'vehiculo', width: 14 },
    { header: 'Motos', key: 'motos', width: 7 },
    { header: 'Carros', key: 'carros', width: 7 },
    { header: 'Concretado por Andrés el', key: 'concretado', width: 20 },
    { header: 'Instalación agendada', key: 'agendada', width: 14 },
    { header: 'Agendó (venta a su nombre)', key: 'agendo', width: 22 },
    { header: 'Instalado', key: 'instalado', width: 10 },
    { header: 'Instalado el', key: 'instaladoEl', width: 18 },
    { header: 'Creado el', key: 'creado', width: 18 },
    { header: 'Última actividad', key: 'actividad', width: 18 },
    { header: 'Última nota', key: 'ultimaNota', width: 60 },
    { header: 'Todas las notas', key: 'notas', width: 80 },
  ];
  for (const l of leads) {
    const notas = (l.notes || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const linea = (n: { date: string; text: string; by?: string }) => `${dateTimeInColombia(n.date)}${n.by ? ' · ' + n.by : ''} · ${n.text}`;
    ws.addRow({
      nombre: l.name,
      telefono: l.phone,
      ciudad: l.city,
      sucursal: l.convertedBranch || branchForCityName(l.city) || '',
      canal: CANAL[l.source] || l.source,
      campana: l.campaign,
      secretaria: l.secretary,
      estado: l.status,
      seguimiento: l.nextFollowUp || '',
      vehiculo: l.vehicleType || '',
      motos: l.motosCount || 0,
      carros: l.carrosCount || 0,
      concretado: esConcretadoPorAndres(l) ? dateTimeInColombia(l.aiHandoffAt) : '',
      agendada: l.scheduledInstallDate || '',
      agendo: l.scheduledByName || '',
      instalado: l.installed ? 'Sí' : 'No',
      instaladoEl: dateTimeInColombia(l.installedAt),
      creado: dateTimeInColombia(l.createdAt),
      actividad: dateTimeInColombia(l.updatedAt),
      ultimaNota: notas[0] ? notas[0].text : '',
      notas: notas.map(linea).join('\n'),
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  ws.getColumn('ultimaNota').alignment = { wrapText: true, vertical: 'top' };
  ws.getColumn('notas').alignment = { wrapText: true, vertical: 'top' };
  ws.getColumn('telefono').numFmt = '@';
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: `U${Math.max(1, leads.length + 1)}` };
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

export function xlsxResponse(buffer: Buffer, filename: string): Response {
  return new Response(buffer as unknown as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
