/**
 * InvoiceDeduplicator
 * -------------------
 * Prevents re-processing invoices that were already upserted in a previous
 * sync run for the same company / period.
 *
 * Keys:  gdt:dedup:{companyId}:{yyyymm}:{direction}  (Redis SADD / SISMEMBER)
 * TTL:   7 200 s  (2 h — covers one full sync cycle with margin)
 */
import type { Redis } from 'ioredis';

const TTL_SECONDS = 7_200;

export class InvoiceDeduplicator {
  constructor(private readonly redis: Redis) {}

  private key(companyId: string, yyyymm: string, direction: 'output' | 'input'): string {
    return `gdt:dedup:${companyId}:${yyyymm}:${direction}`;
  }

  /**
   * Load all existing invoice keys for this period into the Redis set.
   * Call once before the processing loop starts.
   */
  async warmup(
    companyId: string,
    yyyymm: string,
    direction: 'output' | 'input',
    existingKeys: string[],
  ): Promise<void> {
    if (existingKeys.length === 0) return;
    const k = this.key(companyId, yyyymm, direction);
    // Use pipeline for efficiency
    const pipe = this.redis.pipeline();
    for (const key of existingKeys) pipe.sadd(k, key);
    pipe.expire(k, TTL_SECONDS);
    await pipe.exec();
  }

  /** Build the canonical dedup key for a single invoice. */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  invoiceKey(invoiceNumber: string, serialNumber: string): string {
    return `${serialNumber}:${invoiceNumber}`;
  }

  /** Returns true if this invoice was already processed (exists in the set). */
  async exists(
    companyId: string,
    yyyymm: string,
    direction: 'output' | 'input',
    key: string,
  ): Promise<boolean> {
    const k = this.key(companyId, yyyymm, direction);
    const r = await this.redis.sismember(k, key);
    return r === 1;
  }

  /** Mark invoice as processed so it is skipped on the next run's warm-up. */
  async markSeen(
    companyId: string,
    yyyymm: string,
    direction: 'output' | 'input',
    key: string,
  ): Promise<void> {
    const k = this.key(companyId, yyyymm, direction);
    await this.redis.sadd(k, key);
    await this.redis.expire(k, TTL_SECONDS);
  }

  /** Remove the dedup set (e.g. when a full re-sync is forced). */
  async clear(companyId: string, yyyymm: string, direction: 'output' | 'input'): Promise<void> {
    await this.redis.del(this.key(companyId, yyyymm, direction));
  }
}
