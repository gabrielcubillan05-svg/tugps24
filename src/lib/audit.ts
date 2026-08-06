import { randomUUID } from 'node:crypto';
import { getRedis } from './redis';
import type { Session } from './auth';

const REDIS_KEY = 'internal:audit';

export interface AuditEntry {
  id: string;
  at: string;
  userId: string;
  username: string;
  action: string;
  target: string;
  meta?: string;
}

type Redis = NonNullable<ReturnType<typeof getRedis>>;

export async function logAudit(
  redis: Redis,
  actor: Pick<Session, 'userId' | 'username'> | { userId: string; username: string },
  action: string,
  target: string,
  meta?: string
): Promise<void> {
  const entry: AuditEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    userId: actor.userId,
    username: actor.username,
    action,
    target,
    meta,
  };
  try {
    await redis.lpush(REDIS_KEY, JSON.stringify(entry));
  } catch {
    // el log de auditoría nunca debe tumbar la operación principal
  }
}

export async function readAudit(redis: Redis, limit = 500): Promise<AuditEntry[]> {
  const raw = (await redis.lrange<string>(REDIS_KEY, 0, limit - 1)) || [];
  return raw
    .map((r) => {
      try {
        return typeof r === 'string' ? JSON.parse(r) : r;
      } catch {
        return null;
      }
    })
    .filter((e): e is AuditEntry => e !== null);
}
