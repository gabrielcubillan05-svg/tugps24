import { createHash } from 'node:crypto';

export const AUTH_COOKIE = 'internal_auth';

export function expectedToken(): string | null {
  const password = import.meta.env.INTERNAL_PANEL_PASSWORD;
  if (!password) return null;
  return createHash('sha256').update(password).digest('hex');
}

export function checkPassword(input: string): boolean {
  const password = import.meta.env.INTERNAL_PANEL_PASSWORD;
  return Boolean(password) && input === password;
}

export function isAuthorized(cookieValue: string | undefined): boolean {
  const expected = expectedToken();
  return Boolean(expected) && cookieValue === expected;
}
