/**
 * GdtSessionCache
 * ---------------
 * Caches the GDT JWT access token so consecutive sync jobs for the same
 * company + proxy session skip the login round-trip.
 *
 * Key:  gdt:session:{companyId}:{proxySessionId}
 * TTL:  3 000 s  (~50 min — GDT tokens last ~1 h, we leave buffer)
 */
import type { Redis } from 'ioredis';

const DEFAULT_TTL = 3_000;

export class GdtSessionCache {
  constructor(private readonly redis: Redis) {}

  private key(companyId: string, proxySessionId: string): string {
    return `gdt:session:${companyId}:${proxySessionId}`;
  }

  /** Returns the cached token, or null if absent / expired. */
  async get(companyId: string, proxySessionId: string): Promise<string | null> {
    return this.redis.get(this.key(companyId, proxySessionId));
  }

  /** Store a fresh token. */
  async set(
    companyId: string,
    proxySessionId: string,
    token: string,
    ttlSeconds = DEFAULT_TTL,
  ): Promise<void> {
    await this.redis.set(this.key(companyId, proxySessionId), token, 'EX', ttlSeconds);
  }

  /** Invalidate (e.g. when we get a 401). */
  async invalidate(companyId: string, proxySessionId: string): Promise<void> {
    await this.redis.del(this.key(companyId, proxySessionId));
  }

  /**
   * Invalidate ALL cached tokens for a company (any proxySessionId).
   * Used when a job times out — the cached JWT from the timed-out run may be
   * partially consumed / rate-limited by GDT, so the next retry must re-login.
   */
  async invalidateAllForCompany(companyId: string): Promise<void> {
    const pattern = `gdt:session:${companyId}:*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }
}
