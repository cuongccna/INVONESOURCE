/**
 * QuotaService (GROUP 44 — LIC-02)
 *
 * Enforces monthly invoice-sync quotas per user.
 *
 * Tiers:
 *  - No subscription  → FREE tier: 100 invoices/month (soft limit, never hard-blocks unexpectedly)
 *  - Active subscription → quota_total copied from license plan at grant time
 *  - Suspended/expired   → block immediately with SUBSCRIPTION_REQUIRED
 *
 * Quota resets on the 1st of every month (QuotaResetJob cron).
 * Usage is tracked in quota_usage_log for admin analytics.
 */
import { pool } from '../db/pool';
import { AppError } from '../utils/AppError';

export const FREE_TIER_MONTHLY_QUOTA = 100;

// ── Error classes ─────────────────────────────────────────────────────────────

export class QuotaExceededError extends AppError {
  constructor(message: string, code: 'FREE_QUOTA_EXCEEDED' | 'SUBSCRIPTION_QUOTA_EXCEEDED') {
    super(message, 429, code);
    this.name = 'QuotaExceededError';
    Object.setPrototypeOf(this, QuotaExceededError.prototype);
  }
}

export class SubscriptionRequiredError extends AppError {
  constructor(public readonly subStatus: string) {
    super(
      `Subscription ${subStatus} — vui lòng liên hệ admin để gia hạn gói dịch vụ`,
      403,
      'SUBSCRIPTION_REQUIRED',
    );
    this.name = 'SubscriptionRequiredError';
    Object.setPrototypeOf(this, SubscriptionRequiredError.prototype);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubscriptionRow {
  id: string;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  status: string;
  quota_total: number;
  quota_used: number;
  quota_reset_at: Date | null;
  expires_at: Date;
  started_at: Date;
  trial_ends_at: Date | null;
  granted_by: string | null;
  is_manually_set: boolean;
  last_paid_at: Date | null;
  payment_reference: string | null;
}

export interface QuotaCheck {
  allowed: boolean;
  isFree: boolean;
  remaining: number;
  quota_total: number;
  quota_used: number;
  subscription: SubscriptionRow | null;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class QuotaService {

  /** Fetch the user's active subscription (with plan details). Returns null if none. */
  async getSubscription(userId: string): Promise<SubscriptionRow | null> {
    const { rows } = await pool.query<SubscriptionRow>(
      `SELECT
         us.id, us.plan_id, lp.code AS plan_code, lp.name AS plan_name,
         us.status, us.quota_total, us.quota_used, us.quota_reset_at,
         us.expires_at, us.started_at, us.trial_ends_at,
         us.granted_by, us.is_manually_set,
         us.last_paid_at, us.payment_reference
       FROM user_subscriptions us
       JOIN license_plans lp ON lp.id = us.plan_id
       WHERE us.user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Check whether the user can sync `estimated` more invoices.
   * Throws QuotaExceededError or SubscriptionRequiredError on block.
   * Returns QuotaCheck on success.
   */
  async checkCanSync(userId: string, estimated = 1): Promise<QuotaCheck> {
    const sub = await this.getSubscription(userId);

    // ── No subscription → FREE tier ───────────────────────────────────────
    if (!sub) {
      const used = await this._freeUsedThisMonth(userId);
      const remaining = FREE_TIER_MONTHLY_QUOTA - used;
      if (used + estimated > FREE_TIER_MONTHLY_QUOTA) {
        throw new QuotaExceededError(
          `Bạn đã dùng hết ${FREE_TIER_MONTHLY_QUOTA} hóa đơn miễn phí trong tháng này. ` +
          `Liên hệ admin để cấp gói license.`,
          'FREE_QUOTA_EXCEEDED',
        );
      }
      return { allowed: true, isFree: true, remaining, quota_total: FREE_TIER_MONTHLY_QUOTA, quota_used: used, subscription: null };
    }

    // ── Blocked statuses ──────────────────────────────────────────────────
    if (sub.status === 'suspended' || sub.status === 'cancelled') {
      throw new SubscriptionRequiredError(sub.status);
    }
    if (sub.status === 'expired' || new Date(sub.expires_at) < new Date()) {
      throw new SubscriptionRequiredError('expired');
    }

    // ── Active / trial → check quota ──────────────────────────────────────
    const remaining = sub.quota_total - sub.quota_used;
    if (sub.quota_used + estimated > sub.quota_total) {
      throw new QuotaExceededError(
        `Đã sử dụng ${sub.quota_used}/${sub.quota_total} hóa đơn trong tháng này. ` +
        `Liên hệ admin để nâng cấp gói hoặc gia hạn.`,
        'SUBSCRIPTION_QUOTA_EXCEEDED',
      );
    }
    return { allowed: true, isFree: false, remaining, quota_total: sub.quota_total, quota_used: sub.quota_used, subscription: sub };
  }

  /**
   * Record invoice usage after a successful sync.
   * Updates quota_used on the subscription (if any) and inserts a log row.
   * Fire-and-forget safe — never throws to the caller.
   */
  async consumeQuota(
    userId: string,
    companyId: string | null,
    count: number,
    source: 'gdt_bot' | 'manual_import' | 'provider_sync' | 'free_tier',
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert usage log
      await client.query(
        `INSERT INTO quota_usage_log (user_id, company_id, invoices_added, source)
         VALUES ($1, $2, $3, $4)`,
        [userId, companyId, count, source],
      );

      // Increment quota_used on subscription (if exists)
      await client.query(
        `UPDATE user_subscriptions
         SET quota_used = quota_used + $1, updated_at = NOW()
         WHERE user_id = $2`,
        [count, userId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Log but don't rethrow — quota accounting should never abort a sync
      console.error('[QuotaService] consumeQuota failed', { userId, count, source, err });
    } finally {
      client.release();
    }
  }

  /** Reset quota_used=0 for all active/trial subscriptions. Called by QuotaResetJob. */
  async resetAllMonthlyQuotas(): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE user_subscriptions
       SET quota_used = 0, quota_reset_at = NOW(), updated_at = NOW()
       WHERE status IN ('active', 'trial')`,
    );
    return rowCount ?? 0;
  }

  /** Admin: reset a single user's quota. */
  async resetUserQuota(userId: string): Promise<void> {
    await pool.query(
      `UPDATE user_subscriptions
       SET quota_used = 0, quota_reset_at = NOW(), updated_at = NOW()
       WHERE user_id = $1`,
      [userId],
    );
  }

  /** Admin: adjust quota_used by a delta (can be negative to add back quota). */
  async adjustQuota(userId: string, adjustment: number, adminId: string, reason: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE user_subscriptions
         SET quota_used = GREATEST(0, quota_used + $1), updated_at = NOW()
         WHERE user_id = $2`,
        [adjustment, userId],
      );
      await client.query(
        `INSERT INTO quota_usage_log (user_id, company_id, invoices_added, source)
         VALUES ($1, NULL, $2, 'admin_adjustment')`,
        [userId, adjustment],
      );
      // Audit note stored in the log (reason surfaced via admin notes on the row)
      console.info('[QuotaService] adjustQuota', { userId, adjustment, adminId, reason });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Get monthly invoice usage for the past N months from quota_usage_log. */
  async getMonthlyHistory(userId: string, months = 6): Promise<Array<{ month: string; invoices: number }>> {
    const { rows } = await pool.query<{ month: string; invoices: string }>(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', logged_at), 'YYYY-MM') AS month,
         SUM(invoices_added)::text AS invoices
       FROM quota_usage_log
       WHERE user_id = $1
         AND logged_at >= NOW() - ($2 || ' months')::INTERVAL
       GROUP BY 1
       ORDER BY 1 ASC`,
      [userId, months],
    );
    return rows.map(r => ({ month: r.month, invoices: parseInt(r.invoices, 10) }));
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Count free-tier usage for the current calendar month. */
  private async _freeUsedThisMonth(userId: string): Promise<number> {
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(invoices_added), 0)::text AS total
       FROM quota_usage_log
       WHERE user_id = $1
         AND DATE_TRUNC('month', logged_at) = DATE_TRUNC('month', NOW())`,
      [userId],
    );
    return parseInt(rows[0]?.total ?? '0', 10);
  }
}

export const quotaService = new QuotaService();
