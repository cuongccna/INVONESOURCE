import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/dashboard/kpi - key performance indicators for current period
router.get('/kpi', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId;
    const now = new Date();
    const month     = req.query['month']      ? parseInt(String(req.query['month']),      10) : now.getMonth() + 1;
    const year      = req.query['year']       ? parseInt(String(req.query['year']),       10) : now.getFullYear();
    const monthFrom = req.query['month_from'] ? parseInt(String(req.query['month_from']), 10) : month;
    const monthTo   = req.query['month_to']   ? parseInt(String(req.query['month_to']),   10) : month;
    // Convert to date range for flexible monthly/quarterly/yearly filtering
    const periodStart = new Date(year, monthFrom - 1, 1);
    const periodEnd   = new Date(year, monthTo, 1); // exclusive upper bound (first day of month AFTER range)

    const [invoiceStats, vatStats, syncStats, ytdStats, riskStats] = await Promise.all([
      pool.query<{
        total: string; output_count: string; input_count: string;
        invalid_count: string; unvalidated_count: string; input_above_20m_count: string;
      }>(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE direction = 'output') as output_count,
           COUNT(*) FILTER (WHERE direction = 'input') as input_count,
           COUNT(*) FILTER (WHERE status = 'cancelled') as invalid_count,
           COUNT(*) FILTER (WHERE gdt_validated = false AND status = 'valid') as unvalidated_count,
           COUNT(*) FILTER (WHERE direction = 'input' AND total_amount > 20000000) as input_above_20m_count
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= $2
           AND invoice_date <  $3
           AND deleted_at IS NULL`,
        [companyId, periodStart.toISOString(), periodEnd.toISOString()]
      ),
      // Calculate VAT directly from invoices (not from vat_reconciliations which requires manual trigger)
      pool.query(
        `SELECT
           COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'output' AND status != 'cancelled'), 0) AS output_vat,
           COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'input'  AND status != 'cancelled'), 0) AS input_vat,
           GREATEST(0,
             COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'output' AND status != 'cancelled'), 0) -
             COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'input'  AND status != 'cancelled'), 0)
           ) AS payable_vat
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= $2
           AND invoice_date <  $3
           AND deleted_at IS NULL`,
        [companyId, periodStart.toISOString(), periodEnd.toISOString()]
      ),
      pool.query(
        `SELECT provider, errors_count, error_detail, started_at
         FROM sync_logs WHERE company_id = $1
         ORDER BY started_at DESC LIMIT 10`,
        [companyId]
      ),
      // YTD revenue & cost for CIT estimate
      pool.query<{ ytd_revenue: string; ytd_cost: string }>(
        `SELECT
           COALESCE(SUM(total_amount) FILTER (WHERE direction = 'output' AND status != 'cancelled'), 0) AS ytd_revenue,
           COALESCE(SUM(total_amount) FILTER (WHERE direction = 'input'  AND status != 'cancelled'), 0) AS ytd_cost
         FROM invoices
         WHERE company_id = $1
           AND EXTRACT(YEAR FROM invoice_date) = $2
           AND deleted_at IS NULL`,
        [companyId, year]
      ),
      // Risk score from unacknowledged flags
      pool.query<{ critical: string; high: string; medium: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE risk_level = 'critical') AS critical,
           COUNT(*) FILTER (WHERE risk_level = 'high')     AS high,
           COUNT(*) FILTER (WHERE risk_level = 'medium')   AS medium
         FROM company_risk_flags
         WHERE company_id = $1 AND is_acknowledged = false`,
        [companyId]
      ).catch(() => ({ rows: [{ critical: '0', high: '0', medium: '0' }] })),
    ]);

    // CIT estimate: YTD gross profit × 20%
    const ytd = ytdStats.rows[0];
    const ytdRevenue = Number(ytd?.ytd_revenue ?? 0);
    const ytdCost    = Number(ytd?.ytd_cost    ?? 0);
    const ytdProfit  = ytdRevenue - ytdCost;
    const citEstimate = Math.max(0, ytdProfit * 0.20);

    // Risk score: weighted, capped at 100
    const riskRow = riskStats.rows[0] ?? { critical: '0', high: '0', medium: '0' };
    const riskScore = Math.min(100,
      Number(riskRow.critical) * 40 +
      Number(riskRow.high)     * 20 +
      Number(riskRow.medium)   *  5
    );

    // Tax deadlines: next 3 upcoming filing dates (sorted by days remaining)
    const now2 = new Date();
    const daysUntil = (d: Date) => Math.ceil((d.getTime() - now2.getTime()) / 86_400_000);
    const q = Math.ceil(month / 3);
    const taxDeadlines = [
      {
        label: `Thuế GTGT T${month}/${year}`,
        due:   new Date(year, month, 20).toISOString().split('T')[0],
        days_left: daysUntil(new Date(year, month, 20)),
        type: 'gtgt',
      },
      {
        label: `Tạm nộp TNDN Q${q}/${year}`,
        due:   new Date(year, q * 3, 30).toISOString().split('T')[0],
        days_left: daysUntil(new Date(year, q * 3, 30)),
        type: 'cit_provisional',
      },
      {
        label: `Quyết toán TNDN ${year}`,
        due:   `${year + 1}-03-31`,
        days_left: daysUntil(new Date(year + 1, 2, 31)),
        type: 'cit_annual',
      },
    ].sort((a, b) => a.days_left - b.days_left);

    sendSuccess(res, {
      period: { month, monthFrom, monthTo, year },
      invoices: invoiceStats.rows[0],
      // vatStats always returns exactly 1 row (aggregate), ensure non-null
      vat: vatStats.rows[0] ?? { output_vat: '0', input_vat: '0', payable_vat: '0' },
      recentSyncs: syncStats.rows,
      cit_estimate: citEstimate,
      ytd_revenue: ytdRevenue,
      ytd_cost: ytdCost,
      ytd_profit: ytdProfit,
      risk_score: riskScore,
      tax_deadlines: taxDeadlines,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/charts - monthly VAT trend (last 12 months)
router.get('/charts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId;
    const now = new Date();
    const endMonth = req.query['month'] ? parseInt(String(req.query['month']), 10) : now.getMonth() + 1;
    const endYear  = req.query['year']  ? parseInt(String(req.query['year']),  10) : now.getFullYear();

    // Compute start of the 12-month window (11 months before the given period)
    const endDate  = new Date(endYear, endMonth - 1, 1); // first day of endMonth
    const startDate = new Date(endYear, endMonth - 1 - 11, 1); // 11 months back

    // Calculate VAT trend directly from invoices grouped by month
    const result = await pool.query(
      `SELECT
         EXTRACT(MONTH FROM invoice_date)::int AS period_month,
         EXTRACT(YEAR  FROM invoice_date)::int AS period_year,
         COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'output' AND status != 'cancelled'), 0) AS output_vat,
         COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'input'  AND status != 'cancelled'), 0) AS input_vat,
         GREATEST(0,
           COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'output' AND status != 'cancelled'), 0) -
           COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'input'  AND status != 'cancelled'), 0)
         ) AS payable_vat
       FROM invoices
       WHERE company_id = $1
         AND invoice_date >= $2
         AND invoice_date <  $3
         AND deleted_at IS NULL
       GROUP BY period_month, period_year
       ORDER BY period_year ASC, period_month ASC`,
      [companyId, startDate.toISOString(), new Date(endYear, endMonth, 1).toISOString()]
    );

    // Invoice count trend — 12 months ending at the given period
    const countTrend = await pool.query(
      `SELECT
         EXTRACT(MONTH FROM invoice_date)::int as month,
         EXTRACT(YEAR FROM invoice_date)::int as year,
         COUNT(*) FILTER (WHERE direction = 'output') as output_count,
         COUNT(*) FILTER (WHERE direction = 'input') as input_count,
         SUM(total_amount) FILTER (WHERE direction = 'output') as output_total,
         SUM(total_amount) FILTER (WHERE direction = 'input') as input_total
       FROM invoices
       WHERE company_id = $1
         AND invoice_date >= $2
         AND invoice_date <  $3
         AND deleted_at IS NULL
       GROUP BY 1, 2
       ORDER BY 2 ASC, 1 ASC`,
      [companyId, startDate.toISOString(), new Date(endYear, endMonth, 1).toISOString()]
    );

    sendSuccess(res, {
      vatTrend: result.rows,
      invoiceTrend: countTrend.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/analytics - top customers, suppliers, status breakdown
router.get('/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId;
    const months = Math.min(12, Math.max(1, Number(req.query.months ?? 3)));
    const now = new Date();
    const endMonth = req.query['month'] ? parseInt(String(req.query['month']), 10) : now.getMonth() + 1;
    const endYear  = req.query['year']  ? parseInt(String(req.query['year']),  10) : now.getFullYear();
    // End = last day of endMonth; start = `months` months before
    const endDate   = new Date(endYear, endMonth, 1);          // exclusive upper bound (first day next month)
    const startDate = new Date(endYear, endMonth - 1 - (months - 1), 1); // inclusive lower bound

    const [customers, suppliers, statusBreakdown] = await Promise.all([
      pool.query(
        `SELECT buyer_name AS counterparty_name, buyer_tax_code AS counterparty_tax_code,
                COUNT(*) AS invoice_count,
                SUM(total_amount) AS total_amount,
                SUM(vat_amount) AS total_vat
         FROM invoices
         WHERE company_id = $1 AND direction = 'output'
           AND invoice_date >= $2 AND invoice_date < $3
           AND status = 'valid' AND deleted_at IS NULL
           AND buyer_name IS NOT NULL
         GROUP BY buyer_name, buyer_tax_code
         ORDER BY total_amount DESC NULLS LAST
         LIMIT 5`,
        [companyId, startDate.toISOString(), endDate.toISOString()]
      ),
      pool.query(
        `SELECT seller_name AS counterparty_name, seller_tax_code AS counterparty_tax_code,
                COUNT(*) AS invoice_count,
                SUM(total_amount) AS total_amount,
                SUM(vat_amount) AS total_vat
         FROM invoices
         WHERE company_id = $1 AND direction = 'input'
           AND invoice_date >= $2 AND invoice_date < $3
           AND status = 'valid' AND deleted_at IS NULL
           AND seller_name IS NOT NULL
         GROUP BY seller_name, seller_tax_code
         ORDER BY total_amount DESC NULLS LAST
         LIMIT 5`,
        [companyId, startDate.toISOString(), endDate.toISOString()]
      ),
      pool.query(
        `SELECT status, direction, COUNT(*) AS count
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= $2 AND invoice_date < $3
           AND deleted_at IS NULL
         GROUP BY status, direction
         ORDER BY count DESC`,
        [companyId, startDate.toISOString(), endDate.toISOString()]
      ),
    ]);

    sendSuccess(res, {
      topCustomers: customers.rows,
      topSuppliers: suppliers.rows,
      statusBreakdown: statusBreakdown.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/quick-actions — context-aware action cards
router.get('/quick-actions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId;
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const nextMonth20 = new Date(year, month, 20); // 20th of next month
    const daysUntilDeadline = Math.ceil((nextMonth20.getTime() - now.getTime()) / 86_400_000);

    const [anomalyRes, overdueRes, priceAlertRes, repurchaseRes, circuitRes] = await Promise.all([
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM price_anomalies WHERE company_id = $1 AND is_acknowledged = false`,
        [companyId]
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(DISTINCT buyer_tax_code) AS cnt
         FROM invoices
         WHERE company_id = $1 AND direction = 'output' AND status = 'valid'
           AND deleted_at IS NULL
           AND payment_date IS NULL
           AND COALESCE(payment_due_date, invoice_date + INTERVAL '30 days') < NOW()`,
        [companyId]
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM price_anomalies WHERE company_id = $1 AND is_acknowledged = false AND severity = 'critical'`,
        [companyId]
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM repurchase_predictions WHERE company_id = $1 AND is_actioned = false AND predicted_next_date <= NOW() + INTERVAL '7 days'`,
        [companyId]
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM connector_credentials WHERE company_id = $1 AND circuit_state = 'open'`,
        [companyId]
      ).catch(() => ({ rows: [{ cnt: '0' }] })),
    ]);

    const actions: Array<{ key: string; icon: string; label: string; href: string; count?: number; color: string }> = [];

    // Always show
    actions.push({ key: 'invoices', icon: '📄', label: 'Xem Hóa Đơn', href: '/invoices', color: 'bg-blue-50 text-blue-700' });
    actions.push({ key: 'ai', icon: '🤖', label: 'Trợ Lý AI', href: '/ai', color: 'bg-orange-50 text-orange-700' });

    // Conditional
    const anomalyCount = parseInt(anomalyRes.rows[0]?.cnt ?? '0', 10);
    if (anomalyCount > 0) {
      actions.push({ key: 'anomalies', icon: '🔴', label: `${anomalyCount} Bất thường giá`, href: '/audit/anomalies', count: anomalyCount, color: 'bg-red-50 text-red-700' });
    }

    if (daysUntilDeadline <= 10) {
      actions.push({ key: 'declarations', icon: '📅', label: `Nộp tờ khai (${daysUntilDeadline}d)`, href: '/declarations', color: 'bg-green-50 text-green-700' });
    }

    const overdueCount = parseInt(overdueRes.rows[0]?.cnt ?? '0', 10);
    if (overdueCount > 0) {
      actions.push({ key: 'aging', icon: '💰', label: `${overdueCount} HĐ đến hạn`, href: '/crm/aging', count: overdueCount, color: 'bg-amber-50 text-amber-700' });
    }

    const repurchaseCount = parseInt(repurchaseRes.rows[0]?.cnt ?? '0', 10);
    if (repurchaseCount > 0) {
      actions.push({ key: 'repurchase', icon: '📈', label: 'Dự đoán mua lại', href: '/crm/repurchase', count: repurchaseCount, color: 'bg-indigo-50 text-indigo-700' });
    }

    const circuitOpen = parseInt(circuitRes.rows[0]?.cnt ?? '0', 10);
    if (circuitOpen > 0) {
      actions.push({ key: 'connectors', icon: '⚠️', label: 'Lỗi kết nối', href: '/settings/connectors', color: 'bg-red-50 text-red-700' });
    }

    const priceAlertCount = parseInt(priceAlertRes.rows[0]?.cnt ?? '0', 10);
    if (priceAlertCount > 0) {
      actions.push({ key: 'price-alerts', icon: '🏭', label: `${priceAlertCount} Giá NCC tăng`, href: '/vendors/price-alerts', count: priceAlertCount, color: 'bg-orange-50 text-orange-700' });
    }

    // Return top 4 most actionable
    sendSuccess(res, { actions: actions.slice(0, 4) });
  } catch (err) {
    next(err);
  }
});

export default router;

