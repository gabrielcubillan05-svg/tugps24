import type { APIRoute } from 'astro';
import { getRedis } from '../../lib/redis';
import { logAudit } from '../../lib/audit';
import { SESSION_COOKIE, getSession, canManageUsers, getUsers, saveUser, branchesOf, verifySameOrigin, BRANCHES } from '../../lib/auth';

export const prerender = false;

// Lista inicial de responsables de inventario por sucursal (dada por gerencia el 2 de octubre
// de 2026). Es una carga de una sola vez: la fuente de verdad después es el campo "Inventario
// en" de cada usuario en Usuarios. Si alguien de la lista no tiene sucursal en su perfil, no
// se le puede deducir cuál inventario lleva y se devuelve para asignarlo a mano.
const RESPONSABLES = [
  'Cristian Zambrano',
  'Josue Gonzalez',
  'Gabriel Cubillan',
  'Juan Plata',
  'Arle Moguea',
  'Monica Cubillan',
  'Jose Miguel Reales',
  'Junior Cardenas',
  'Pierangela Sanchez',
  'Kelly Lara',
  'Alejandra Molina',
  'hisnaldis',
  'yoniparra',
];

// Cristian (Bucaramanga) lleva el inventario de todas las sucursales a nivel nacional: se le
// marcan todas, no solo la de su perfil.
const RESPONSABLES_NACIONALES = ['Cristian Zambrano'];
// Sucursal fija, independiente de la del perfil, y que REEMPLAZA lo que tenga marcado: el 2 de
// octubre se le asignaron todas a Isnaldi por error, y José Miguel (supervisor de turno) tiene
// la Central en su perfil, así que no se le deducía ninguna.
const RESPONSABLES_FIJOS: Record<string, string[]> = {
  hisnaldis: ['Riohacha'],
  'Jose Miguel Reales': ['Riohacha'],
  yoniparra: ['Bucaramanga'],
};
const TODAS_LAS_SUCURSALES = BRANCHES.filter((b) => b !== 'Central de Monitoreo');

function tokens(name: string): string[] {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// "Jose Miguel Reales" coincide con "José Miguel Reales Pérez": todas las palabras de la lista
// deben estar en el nombre del usuario. Una entrada de una sola palabra también puede ser el
// nombre de usuario (ej. "hisnaldis").
function matches(listName: string, userName: string, username: string): boolean {
  const wanted = tokens(listName);
  // Una sola palabra es un nombre de usuario exacto; por nombre coincidiría con cualquiera
  // que la tenga entre sus nombres (p. ej. "Hisnaldis Junior Cárdenas").
  if (wanted.length === 1) return wanted[0] === tokens(username).join('');
  const have = new Set(tokens(userName));
  return wanted.length > 0 && wanted.every((t) => have.has(t));
}

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!verifySameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'invalid origin' }), { status: 403 });
  }
  const session = await getSession(cookies.get(SESSION_COOKIE)?.value);
  if (!session || !canManageUsers(session.role)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const redis = getRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const users = (await getUsers(redis)).filter((u) => u.active);
  const assigned: string[] = [];
  const alreadySet: string[] = [];
  const withoutBranch: string[] = [];
  const notFound: string[] = [];

  for (const listName of RESPONSABLES) {
    const candidates = users.filter((u) => matches(listName, u.name, u.username));
    if (!candidates.length) {
      notFound.push(listName);
      continue;
    }
    for (const user of candidates) {
      const fixed = RESPONSABLES_FIJOS[listName];
      const branches = fixed
        ? fixed
        : RESPONSABLES_NACIONALES.includes(listName)
          ? TODAS_LAS_SUCURSALES
          : branchesOf(user).filter((b) => b !== 'Central de Monitoreo');
      if (!branches.length) {
        withoutBranch.push(user.name);
        continue;
      }
      const current = user.inventoryBranches || [];
      const sameSet = current.length === branches.length && branches.every((b) => current.includes(b));
      if (fixed ? sameSet : current.length && branches.every((b) => current.includes(b))) {
        alreadySet.push(`${user.name} (${current.join(', ')})`);
        continue;
      }
      // Con sucursal fija se reemplaza lo marcado (sirve para quitar de más); en los demás solo se agrega.
      user.inventoryBranches = fixed ? [...branches] : [...new Set([...current, ...branches])];
      user.updatedAt = new Date().toISOString();
      await saveUser(redis, user);
      await logAudit(redis, session, 'user_inventory_branches_update', user.username, user.inventoryBranches.join(', '));
      assigned.push(`${user.name} (${user.inventoryBranches.join(', ')})`);
    }
  }

  return new Response(JSON.stringify({ ok: true, assigned, alreadySet, withoutBranch, notFound }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
