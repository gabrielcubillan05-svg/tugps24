import type { APIRoute } from 'astro';
import ExcelJS from 'exceljs';
import { getRedis } from '../../lib/redis';
import { SESSION_COOKIE, getSession, canManageAiAgents } from '../../lib/auth';
import { branchForCityName } from '../../lib/pricing';
import { todayInColombia } from '../../lib/colombia-time';
import { readLeads, type Lead } from './leads';

export const prerender = false;

// Excel con todos los leads que Andrés concretó (entregó a sucursal). Mismo criterio que el
// contador "Concretados" del panel de agentes: canales donde Andrés conversa (WhatsApp Ads y
// chat web) y etapa "entregado". Pedido por Gabriel el 2026-10-08.
const CANAL: Record<string, string> = { 'whatsapp-ads': 'WhatsApp Ads', 'web-chat': 'Chat web', 'meta-leadgen': 'Formulario Meta', manual: 'Manual' };

function fechaHora(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function esConcretadoPorAndres(l: Lead): boolean {
  return (l.source === 'whatsapp-ads' || l.source === 'web-chat') && l.aiStage === 'entregado';
}

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageAiAgents(session)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const redis = getRedis();
  if (!redis) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });

  const leads = (await readLeads(redis)).filter(esConcretadoPorAndres).sort((a, b) => String(b.aiHandoffAt || b.createdAt).localeCompare(String(a.aiHandoffAt || a.createdAt)));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Concretados por Andrés');
  ws.columns = [
    { header: 'Concretado el', key: 'concretado', width: 18 },
    { header: 'Nombre', key: 'nombre', width: 28 },
    { header: 'Teléfono', key: 'telefono', width: 16 },
    { header: 'Ciudad', key: 'ciudad', width: 16 },
    { header: 'Sucursal', key: 'sucursal', width: 16 },
    { header: 'Canal', key: 'canal', width: 14 },
    { header: 'Campaña', key: 'campana', width: 22 },
    { header: 'Vehículo', key: 'vehiculo', width: 12 },
    { header: 'Motos', key: 'motos', width: 8 },
    { header: 'Carros', key: 'carros', width: 8 },
    { header: 'Estado en el CRM', key: 'estado', width: 24 },
    { header: 'Secretaria', key: 'secretaria', width: 18 },
    { header: 'Instalación agendada', key: 'agendada', width: 18 },
    { header: 'Instalado', key: 'instalado', width: 10 },
    { header: 'Instalado el', key: 'instaladoEl', width: 18 },
    { header: 'Gerente enterado', key: 'gerente', width: 24 },
    { header: 'Lead creado el', key: 'creado', width: 18 },
    { header: 'Última nota', key: 'nota', width: 50 },
  ];
  for (const l of leads) {
    const ultimaNota = (l.notes || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    ws.addRow({
      concretado: fechaHora(l.aiHandoffAt),
      nombre: l.name,
      telefono: l.phone,
      ciudad: l.city,
      sucursal: l.convertedBranch || branchForCityName(l.city) || '',
      canal: CANAL[l.source] || l.source,
      campana: l.campaign,
      vehiculo: l.vehicleType,
      motos: l.motosCount || 0,
      carros: l.carrosCount || 0,
      estado: l.status,
      secretaria: l.secretary,
      agendada: l.scheduledInstallDate || '',
      instalado: l.installed ? 'Sí' : 'No',
      instaladoEl: fechaHora(l.installedAt),
      gerente: l.managerAckAt ? `${l.managerAckBy || ''} · ${fechaHora(l.managerAckAt)}`.replace(/^ · /, '') : '',
      creado: fechaHora(l.createdAt),
      nota: ultimaNota ? ultimaNota.text : '',
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: `R${Math.max(1, leads.length + 1)}` };

  const buffer = await wb.xlsx.writeBuffer();
  return new Response(buffer as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="concretados-andres_${todayInColombia()}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
};
