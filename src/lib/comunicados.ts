import type { Role, Session } from './auth';
import { logAudit } from './audit';

// Comunicados de gerencia que cada persona debe confirmar haber recibido. Salen como ventana en
// el centro del panel hasta que pulsa "Confirmo"; la confirmación (quién y cuándo) queda guardada
// y en Auditoría como constancia de entrega.
export interface Comunicado {
  id: string;
  titulo: string;
  // HTML escrito aquí mismo (no viene de usuarios), por eso se inserta tal cual.
  html: string;
  roles: Role[];
}

const ACKS_PREFIX = 'internal:comunicado-acks:';

export const COMUNICADOS: Comunicado[] = [
  {
    id: 'cumplimiento-funciones-2026-10-17',
    titulo: 'Cumplimiento de funciones y metas – Todo el personal',
    roles: ['secretaria', 'gerente', 'supervisor', 'operador', 'tecnico'],
    html: `
<p>Buen día, equipo de TuGPS24.</p>
<p>Les recordamos las funciones de cada cargo.</p>
<p><strong>Secretarias:</strong></p>
<ul>
  <li><strong>Cobranza:</strong> llamar a los clientes con saldo pendiente y registrar el resultado de cada gestión.</li>
  <li><strong>Interesados:</strong> hacer seguimiento a los leads asignados y a los concretados por Andrés, confirmarlos y agendar la instalación.</li>
  <li><strong>Atención al cliente:</strong> responder a tiempo los chats, las llamadas y las solicitudes.</li>
  <li><strong>Registro:</strong> dejar cada gestión en el panel, porque de ahí salen las estadísticas de desempeño.</li>
</ul>
<p><strong>Gerentes:</strong></p>
<ul>
  <li><strong>Supervisión diaria:</strong> verificar que el personal de su sucursal cumpla sus funciones y sus metas.</li>
  <li><strong>Concretados:</strong> confirmar y dar seguimiento a los concretados de Andrés y a las instalaciones de su sucursal.</li>
  <li><strong>Resultados:</strong> responder por las estadísticas de cobranza, ventas, atención e instalaciones de su sucursal.</li>
  <li><strong>Alertas:</strong> atender a tiempo las tareas y los avisos de GPSITO.</li>
</ul>
<p><strong>Supervisores:</strong></p>
<ul>
  <li><strong>Supervisión de operadores:</strong> verificar en cada turno que los operadores monitoreen la plataforma, atiendan de inmediato las alertas, registren las novedades y entreguen sus reportes completos y a tiempo.</li>
  <li><strong>Casos importantes:</strong> atender, escalar y hacer seguimiento a los casos importantes y a las situaciones de riesgo que reporten los operadores hasta su cierre.</li>
  <li><strong>Reporte de incumplimientos:</strong> documentar con pruebas los incumplimientos de los operadores a su cargo e informarlos a la gerencia general para iniciar el procedimiento correspondiente.</li>
  <li><strong>Alertas:</strong> atender a tiempo las tareas y los avisos de GPSITO.</li>
</ul>
<p><strong>Operadores:</strong></p>
<ul>
  <li><strong>Monitoreo:</strong> vigilar la plataforma de forma permanente durante el turno y atender de inmediato las alertas y eventos de los vehículos.</li>
  <li><strong>Novedades:</strong> registrar en el panel todas las novedades del turno, completas y a tiempo.</li>
  <li><strong>Reportes:</strong> elaborar y enviar los reportes que les correspondan, completos, correctos y en los tiempos establecidos.</li>
  <li><strong>Clientes y procedimientos:</strong> ejecutar los apagados programados y los procedimientos de seguridad, y comunicarse con los clientes cuando el evento lo requiera.</li>
  <li><strong>Entrega de turno:</strong> entregarlo con la información al día.</li>
</ul>
<p><strong>Técnicos:</strong></p>
<ul>
  <li><strong>Instalaciones y revisiones:</strong> cumplir las instalaciones, revisiones y garantías agendadas, en la fecha y hora acordadas con el cliente.</li>
  <li><strong>Calidad del trabajo:</strong> realizar las instalaciones de forma correcta, siguiendo el procedimiento técnico establecido y sin causar daños al vehículo del cliente (cableado, tablero, sistema eléctrico, tapicería ni ninguna otra parte).</li>
  <li><strong>Evidencias:</strong> registrar en el panel cada trabajo realizado, con sus evidencias.</li>
  <li><strong>Herramientas e inventario:</strong> mantener al día las planillas de vehículo y el inventario a su cargo.</li>
  <li><strong>Trato al cliente:</strong> atender al cliente con puntualidad y buen trato.</li>
</ul>
<p>Hemos visto incumplimientos repetidos en estas funciones y en las estadísticas de desempeño.</p>
<p><strong>A partir de hoy, cada incumplimiento se tramitará formalmente conforme a la ley y al reglamento interno de trabajo:</strong></p>
<ol>
  <li><strong>Llamado de atención por escrito</strong>, con la descripción del incumplimiento.</li>
  <li><strong>Presentación de las pruebas</strong> correspondientes (registros del panel, estadísticas, reportes).</li>
  <li><strong>Citación a diligencia de descargos</strong>, donde el trabajador podrá dar su versión y presentar sus propias pruebas.</li>
</ol>
<p><strong>Una vez agotado este procedimiento y cumplidos los requisitos mínimos que exige la ley, la reincidencia en el incumplimiento de las funciones será justa causa de terminación del contrato de trabajo.</strong></p>
<p>Contamos con el compromiso de todos. Si tienen alguna dificultad para cumplir sus funciones, comuníquenla de inmediato a su gerente o a la gerencia general para buscar una solución.</p>
<p>Atentamente,<br />Gerencia – TuGPS24 / Digital Global S.A.S.</p>`,
  },
];

export interface ConfirmacionComunicado {
  name: string;
  at: string;
}

export async function leerConfirmaciones(redis: any, comunicadoId: string): Promise<Record<string, ConfirmacionComunicado>> {
  const raw = ((await redis.hgetall(ACKS_PREFIX + comunicadoId)) || {}) as Record<string, unknown>;
  const out: Record<string, ConfirmacionComunicado> = {};
  for (const [userId, v] of Object.entries(raw)) {
    try {
      out[userId] = typeof v === 'string' ? JSON.parse(v) : (v as ConfirmacionComunicado);
    } catch {
      // registro dañado: se ignora
    }
  }
  return out;
}

export async function comunicadosPendientes(redis: any, session: Session): Promise<{ id: string; titulo: string; html: string }[]> {
  const aplicables = COMUNICADOS.filter((c) => c.roles.includes(session.role));
  if (!aplicables.length) return [];
  const confirmados = await Promise.all(aplicables.map((c) => redis.hexists(ACKS_PREFIX + c.id, session.userId)));
  return aplicables.filter((_, i) => !confirmados[i]).map(({ id, titulo, html }) => ({ id, titulo, html }));
}

export async function confirmarComunicado(redis: any, session: Session, comunicadoId: string, nombre: string): Promise<boolean> {
  const comunicado = COMUNICADOS.find((c) => c.id === comunicadoId);
  if (!comunicado || !comunicado.roles.includes(session.role)) return false;
  // hsetnx: la primera confirmación es la que vale como constancia; no se reescribe la hora.
  const nuevo = await redis.hsetnx(ACKS_PREFIX + comunicadoId, session.userId, JSON.stringify({ name: nombre, at: new Date().toISOString() }));
  if (nuevo) await logAudit(redis, session, 'comunicado_confirmado', comunicado.titulo, nombre).catch(() => {});
  return true;
}
