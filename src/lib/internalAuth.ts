import { createHash } from 'node:crypto';

export const AUTH_COOKIE = 'internal_auth';
export const SUPERVISOR_COOKIE = 'supervisor_auth';
export const PANEL_PATH = '/operadores';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function expectedToken(): string | null {
  const password = import.meta.env.INTERNAL_PANEL_PASSWORD;
  if (!password) return null;
  return hash(password);
}

export function checkPassword(input: string): boolean {
  const password = import.meta.env.INTERNAL_PANEL_PASSWORD;
  return Boolean(password) && input === password;
}

export function isAuthorized(cookieValue: string | undefined): boolean {
  const expected = expectedToken();
  return Boolean(expected) && cookieValue === expected;
}

export function expectedSupervisorToken(): string | null {
  const password = import.meta.env.SUPERVISOR_PANEL_PASSWORD;
  if (!password) return null;
  return hash(password);
}

export function checkSupervisorPassword(input: string): boolean {
  const password = import.meta.env.SUPERVISOR_PANEL_PASSWORD;
  return Boolean(password) && input === password;
}

export function isSupervisor(cookieValue: string | undefined): boolean {
  const expected = expectedSupervisorToken();
  return Boolean(expected) && cookieValue === expected;
}
