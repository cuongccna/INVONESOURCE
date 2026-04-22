/**
 * LicenseService — BOT-LICENSE-01
 *
 * Resolves a user's effective license tier (from DB joined with license_tiers),
 * caches in Redis for 5 min, falls back to FREE_TIER on any error.
 *
 * Used by bot.ts route to pass the correct rate-limit plan to the bot worker.
 */
import IORedis from 'ioredis';
import { pool } from '../db/pool';
import { env } from '../config/env';

export interface LicenseTier {
  planId:       string;
  syncPerHour:  number;
  burstMax:     number;
  invoiceQuota: number;
  maxCompanies: number;
  canExportXml: boolean;
  canUseAiAudit: boolean;
}

export const FREE_TIER: LicenseTier = {
  planId:        'free',
  syncPerHour:   3,
  burstMax:      3,
  invoiceQuota:  100,
  maxCompanies:  1,
  canExportXml:  false,
  canUseAiAudit: false,
};

const CACHE_TTL_SEC = 5 * 60;
const CACHE_KEY = (userId: string) => `license:plan:${userId}`;

export class LicenseService {
  private readonly _redis: IORedis;

  constructor(redis?: IORedis) {
    this._redis = redis ?? new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  }

  /** Returns the resolved tier, never throws. Falls back to FREE_TIER. */
  async getTier(userId: string): Promise<LicenseTier> {
    try {
      const cached = await this._redis.get(CACHE_KEY(userId));
      if (cached) {
        return JSON.parse(cached) as LicenseTier;
      }
    } catch {
      // Redis unavailable — skip cache
    }

    try {
      const { rows } = await pool.query<{
        plan_id:        string | null;
        sync_per_hour:  number | null;
        burst_max:      number | null;
        quota_total:    number | null;
        max_companies:  number | null;
        can_export_xml: boolean | null;
        can_use_ai_audit: boolean | null;
        sub_status:     string | null;
      }>(
        `SELECT
           us.status            AS sub_status,
           us.quota_total,
           lt.plan_id,
           lt.sync_per_hour,
           lt.burst_max,
           lt.max_companies,
           lt.can_export_xml,
           lt.can_use_ai_audit
         FROM user_subscriptions us
         LEFT JOIN license_tiers lt ON lt.plan_id = us.plan
         WHERE us.user_id = $1
           AND us.status IN ('trial', 'active')
         ORDER BY us.created_at DESC
         LIMIT 1`,
        [userId]
      );

      const row = rows[0];
      if (!row || !row.plan_id) {
        return FREE_TIER;
      }

      const tier: LicenseTier = {
        planId:        row.plan_id,
        syncPerHour:   row.sync_per_hour  ?? FREE_TIER.syncPerHour,
        burstMax:      row.burst_max      ?? FREE_TIER.burstMax,
        invoiceQuota:  row.quota_total    ?? FREE_TIER.invoiceQuota,
        maxCompanies:  row.max_companies  ?? FREE_TIER.maxCompanies,
        canExportXml:  row.can_export_xml ?? false,
        canUseAiAudit: row.can_use_ai_audit ?? false,
      };

      try {
        await this._redis.set(CACHE_KEY(userId), JSON.stringify(tier), 'EX', CACHE_TTL_SEC);
      } catch {
        // non-fatal
      }

      return tier;
    } catch {
      return FREE_TIER;
    }
  }

  /** Convenience: return just the plan string */
  async getPlanId(userId: string): Promise<string> {
    const tier = await this.getTier(userId);
    return tier.planId;
  }

  /** Invalidate cached tier for a user (call after subscription change) */
  async invalidate(userId: string): Promise<void> {
    try {
      await this._redis.del(CACHE_KEY(userId));
    } catch {
      // non-fatal
    }
  }
}

export const licenseService = new LicenseService();
