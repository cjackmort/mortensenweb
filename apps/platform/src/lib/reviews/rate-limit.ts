/**
 * A fixed-window counter per key, held in memory.
 *
 * For the public review links. It is per function instance, so it slows a
 * burst from one address hitting a warm instance and no more than that. What
 * actually protects the database is earlier: a link that is not signed by us
 * is refused before any query (see `tokens.ts`). This is the second, cheaper
 * layer, for a real link being hammered.
 *
 * Bounded: past `maxKeys` the oldest windows are dropped first, so a flood of
 * distinct addresses cannot grow the map without limit.
 */

export interface RateLimiter {
  allow(key: string, now?: number): boolean;
  size(): number;
}

export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
}: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): RateLimiter {
  const windows = new Map<string, { startedAt: number; count: number }>();

  return {
    allow(key, now = Date.now()) {
      const current = windows.get(key);
      if (!current || now - current.startedAt >= windowMs) {
        windows.delete(key);
        windows.set(key, { startedAt: now, count: 1 });
        while (windows.size > maxKeys) {
          const oldest = windows.keys().next().value;
          if (oldest === undefined) break;
          windows.delete(oldest);
        }
        return true;
      }
      current.count += 1;
      return current.count <= limit;
    },
    size: () => windows.size,
  };
}
