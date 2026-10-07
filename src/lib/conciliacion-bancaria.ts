import { createHash } from 'node:crypto';
import type { PagoCliente } from './pagos-verificacion';

// Conciliación entre los comprobantes aprobados en el panel y los abonos reales de la cuenta.
// El extracto que entrega Bancolombia (CSV, 10 columnas, sin encabezado) NO trae la referencia
// del comprobante ni el nombre del pagador salvo en Bre-B/QR: para Nequi y transferencias solo
// hay fecha (sin hora), valor y un código de tipo. Con 60 abonos de 44.000 el mismo día no se
// puede emparejar uno a uno; se concilia por grupos (fecha, valor, canal) y, cuando el extracto
// trae nombre, por nombre.

export interface MovimientoBanco {
  id: string;
  cuenta: string;
  fecha: string; // AAAA-MM-DD
  valor: number;
  codigo: string;
  descripcion: string;
  canal: Canal;
  nombre: string; // pagador si el extracto lo trae (PAGO LLAVE / PAGO QR)
  cargaId: string;
}

export type Canal = 'electronico' | 'efectivo' | 'otro';

export interface CargaBanco {
  id: string;
  fileName: string;
  uploadedAt: string;
  uploadedByName: string;
  cuenta: string;
  desde: string;
  hasta: string;
  filas: number;
  abonos: number;
  nuevos: number;
  sumaAbonos: number;
}

// Clasifica un abono por su descripción. Lo que no es pago de clientes (intereses, tarjetas,
// Wompi, proveedores) queda como "otro" y no entra al cruce.
export function canalDe(descripcion: string): Canal {
  const d = descripcion.toUpperCase();
  if (/CONSIGNACION|CORRESPONSAL|EFECTIVO|DEPOSITO/.test(d)) return 'efectivo';
  if (/NEQUI|SUC VIRTUAL|PAGO LLAVE|PAGO QR|TRANSFERENCIA|INTERBANCARIO|PSE|DAVIPLATA|TRANSFIYA/.test(d)) return 'electronico';
  return 'otro';
}

export function nombreDe(descripcion: string): string {
  const m = descripcion.match(/^PAGO (?:LLAVE|QR)\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function fechaIso(yyyymmdd: string): string {
  const m = String(yyyymmdd).trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = String(yyyymmdd).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return d ? `${d[3]}-${d[2]}-${d[1]}` : '';
}

export interface ParseResult {
  movimientos: Omit<MovimientoBanco, 'cargaId'>[];
  filas: number;
  cuenta: string;
  desde: string;
  hasta: string;
  error?: string;
}

// Formato Bancolombia: cuenta, oficina, _, fecha AAAAMMDD, _, valor con signo, código, descripción, _, _
export function parseExtractoBancolombia(text: string): ParseResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const movimientos: Omit<MovimientoBanco, 'cargaId'>[] = [];
  const ordinal = new Map<string, number>();
  let cuenta = '';
  let filas = 0;
  for (const line of lines) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 8) continue;
    const fecha = fechaIso(cols[3]);
    const valor = Number(cols[5]);
    if (!fecha || !Number.isFinite(valor)) continue;
    filas++;
    cuenta = cuenta || cols[0].replace(/\D/g, '');
    if (valor <= 0) continue;
    const descripcion = cols[7].replace(/\s+/g, ' ').trim();
    const base = `${cuenta}|${fecha}|${valor.toFixed(2)}|${cols[6]}|${descripcion}`;
    // Dos abonos idénticos el mismo día son dos pagos distintos: el ordinal los separa, y si el
    // mismo extracto se vuelve a subir (o dos extractos se solapan) caen en las mismas llaves.
    const n = (ordinal.get(base) || 0) + 1;
    ordinal.set(base, n);
    movimientos.push({
      id: createHash('sha1').update(`${base}|${n}`).digest('hex').slice(0, 24),
      cuenta,
      fecha,
      valor,
      codigo: cols[6],
      descripcion,
      canal: canalDe(descripcion),
      nombre: nombreDe(descripcion),
    });
  }
  if (!filas) return { movimientos: [], filas: 0, cuenta: '', desde: '', hasta: '', error: 'No se reconoció el formato del extracto (se espera el CSV de movimientos de Bancolombia).' };
  const fechas = movimientos.map((m) => m.fecha).sort();
  return { movimientos, filas, cuenta, desde: fechas[0] || '', hasta: fechas[fechas.length - 1] || '' };
}

function tokens(s: string): string[] {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter((t) => t.length >= 3);
}

function nombresCoinciden(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length < 2 || tb.length < 1) return false;
  return tb.filter((t) => ta.includes(t)).length >= Math.min(2, tb.length);
}

function canalDelPago(p: PagoCliente): Canal {
  const banco = `${p.extracted?.banco || ''} ${p.extracted?.tipoDestino || ''}`.toLowerCase();
  if (/efectivo|corresponsal|consignaci|efecty|baloto|ventanilla|cajero/.test(banco)) return 'efectivo';
  return 'electronico';
}

function diaSiguiente(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface Conciliacion {
  desde: string;
  hasta: string;
  comprobantes: number;
  conciliados: { pagoId: string; movimientoId: string; porNombre: boolean }[];
  sinRespaldo: string[]; // ids de comprobantes aprobados sin abono que los respalde
  sinComprobante: MovimientoBanco[]; // abonos de clientes sin comprobante registrado
  otros: number; // abonos que no son pagos de clientes (intereses, tarjetas, proveedores)
  porDia: { fecha: string; abonos: number; sumaAbonos: number; comprobantes: number; sumaComprobantes: number; conciliados: number }[];
}

// Cruce por grupos: cada comprobante busca un abono libre del mismo canal y valor, el mismo día
// o el siguiente (los pagos de la noche se acreditan al otro día). Cuando el extracto trae el
// nombre (Bre-B, QR) se exige además que el nombre cuadre con el cliente o el pagador.
export function conciliar(pagos: PagoCliente[], movimientos: MovimientoBanco[], desde: string, hasta: string): Conciliacion {
  const enRango = pagos.filter((p) => (p.status === 'verde' || p.status === 'aprobado') && p.extracted?.fecha && p.extracted.fecha >= desde && p.extracted.fecha <= hasta);
  const libres = new Map(movimientos.filter((m) => m.canal !== 'otro' && m.fecha >= desde && m.fecha <= diaSiguiente(hasta)).map((m) => [m.id, m]));
  const conciliados: Conciliacion['conciliados'] = [];
  const sinRespaldo: string[] = [];
  // Primero los que se pueden emparejar por nombre: son los únicos cruces uno a uno de verdad.
  const ordenados = [...enRango].sort((a, b) => (a.extracted!.fecha + a.id).localeCompare(b.extracted!.fecha + b.id));
  const pendientes: PagoCliente[] = [];
  for (const p of ordenados) {
    const valor = Math.round(p.extracted!.valor || 0);
    const canal = canalDelPago(p);
    const candidatos = [...libres.values()].filter((m) => m.canal === canal && Math.round(m.valor) === valor && (m.fecha === p.extracted!.fecha || m.fecha === diaSiguiente(p.extracted!.fecha)) && m.nombre);
    const porNombre = candidatos.find((m) => nombresCoinciden(`${p.clientName} ${p.extracted!.pagador || ''}`, m.nombre));
    if (porNombre) {
      libres.delete(porNombre.id);
      conciliados.push({ pagoId: p.id, movimientoId: porNombre.id, porNombre: true });
    } else pendientes.push(p);
  }
  for (const p of pendientes) {
    const valor = Math.round(p.extracted!.valor || 0);
    const canal = canalDelPago(p);
    const mismoDia = [...libres.values()].find((m) => m.canal === canal && Math.round(m.valor) === valor && m.fecha === p.extracted!.fecha && !m.nombre);
    const siguiente = mismoDia || [...libres.values()].find((m) => m.canal === canal && Math.round(m.valor) === valor && m.fecha === diaSiguiente(p.extracted!.fecha) && !m.nombre);
    // Un abono con nombre que no cuadró con nadie también puede respaldar un pago sin nombre legible.
    const conNombre = siguiente || [...libres.values()].find((m) => m.canal === canal && Math.round(m.valor) === valor && (m.fecha === p.extracted!.fecha || m.fecha === diaSiguiente(p.extracted!.fecha)));
    const elegido = conNombre;
    if (elegido) {
      libres.delete(elegido.id);
      conciliados.push({ pagoId: p.id, movimientoId: elegido.id, porNombre: false });
    } else sinRespaldo.push(p.id);
  }
  const sinComprobante = [...libres.values()].filter((m) => m.fecha <= hasta).sort((a, b) => a.fecha.localeCompare(b.fecha) || b.valor - a.valor);
  const otros = movimientos.filter((m) => m.canal === 'otro' && m.fecha >= desde && m.fecha <= hasta).length;
  const dias = new Map<string, Conciliacion['porDia'][number]>();
  const dia = (f: string) => dias.get(f) || (dias.set(f, { fecha: f, abonos: 0, sumaAbonos: 0, comprobantes: 0, sumaComprobantes: 0, conciliados: 0 }), dias.get(f)!);
  for (const m of movimientos) if (m.canal !== 'otro' && m.fecha >= desde && m.fecha <= hasta) { const d = dia(m.fecha); d.abonos++; d.sumaAbonos += m.valor; }
  for (const p of enRango) { const d = dia(p.extracted!.fecha); d.comprobantes++; d.sumaComprobantes += p.extracted!.valor || 0; }
  const conciliadoIds = new Set(conciliados.map((c) => c.pagoId));
  for (const p of enRango) if (conciliadoIds.has(p.id)) dia(p.extracted!.fecha).conciliados++;
  return {
    desde,
    hasta,
    comprobantes: enRango.length,
    conciliados,
    sinRespaldo,
    sinComprobante,
    otros,
    porDia: [...dias.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)).map((d) => ({ ...d, sumaAbonos: Math.round(d.sumaAbonos), sumaComprobantes: Math.round(d.sumaComprobantes) })),
  };
}
