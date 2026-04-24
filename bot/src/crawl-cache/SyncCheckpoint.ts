/**
 * SyncCheckpoint
 * --------------
 * Saves the last successfully processed page index so a failed sync job
 * can resume from where it left off instead of restarting from page 0.
 *
 * Key:  gdt:checkpoint:{companyId}:{yyyymm}:{direction}:{scope}
 * TTL:  3 600 s  (1 h)
 */
import type { Redis } from 'ioredis';

const TTL_SECONDS = 3_600;

interface CheckpointData {
  lastPage: number;   // last page successfully fetched (0-based)
  savedAt:  number;   // Unix timestamp ms
}

export class SyncCheckpoint {
  constructor(private readonly redis: Redis) {}

  private key(
    companyId: string,
    yyyymm: string,
    direction: 'output' | 'input',
    scope: string = 'default',
  ): string {
    return `gdt:checkpoint:${companyId}:${yyyymm}:${direction}:${scope}`;
  }

  /** Persist the checkpoint after processing a page. */
  async save(
    companyId: string,
    yyyymm: string,
    direction: 'output' | 'input',
    lastPage: number,
    scope: string = 'default',
  ): Promise<void> {
    const data: CheckpointData = { lastPage, savedAt: Date.now() };
    await this.redis.set(
      this.key(companyId, yyyymm, direction, scope),
      JSON.stringify(data),
      'EX',
      TTL_SECONDS,
    );
  }

  /**
   * Load the saved checkpoint.
   * Returns the next page to fetch (lastPage + 1), or 0 if none.
   */
  async loadStartPage(
    companyId: string,
    yyyymm: string,
    direction: 'output' | 'input',
    scope: string = 'default',
  ): Promise<number> {
    const raw = await this.redis.get(this.key(companyId, yyyymm, direction, scope));
    if (!raw) return 0;
    try {
      const data: CheckpointData = JSON.parse(raw) as CheckpointData;
      return data.lastPage + 1;
    } catch {
      return 0;
    }
  }

  /** Remove the checkpoint after a successful full sync. */
  async clear(
    companyId: string,
    yyyymm: string,
    direction: 'output' | 'input',
    scope: string = 'default',
  ): Promise<void> {
    await this.redis.del(this.key(companyId, yyyymm, direction, scope));
  }
}
