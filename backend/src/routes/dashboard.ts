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
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const [invoiceStats, vatStats, syncStats] = await Promise.all([
      pool.query<{
        total: string; output_count: string; input_count: string;
        invalid_count: string; unvalidated_count: string;
      }>(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE direction = 'output') as output_count,
           COUNT(*) FILTER (WHERE direction = 'input') as input_count,
           COUNT(*) FILTER (WHERE status = 'cancelled') as invalid_count,
           COUNT(*) FILTER (WHERE gdt_validated = false AND status = 'valid') as unvalidated_count
         FROM invoices
         WHERE company_id = $1
           AND EXTRACT(MONTH FROM invoice_date) = $2
           AND EXTRACT(YEAR FROM invoice_date) = $3`,
        [companyId, month, year]
      ),
      pool.query(
        `SELECT output_vat, input_vat, payable_vat
         FROM vat_reconciliations
         WHERE company_id = $1 AND period_month = $2 AND period_year = $3`,
        [companyId, month, year]
      ),
      pool.query(
        `SELECT provider, errors_count, error_detail, started_at
         FROM sync_logs WHERE company_id = $1
         ORDER BY started_at DESC LIMIT 10`,
        [companyId]
      ),
    ]);

    sendSuccess(res, {
      period: { month, year },
      invoices: invoiceStats.rows[0],
      vat: vatStats.rows[0] ?? null,
      recentSyncs: syncStats.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/charts - monthly VAT trend (last 12 months)
router.get('/charts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId;

    const result = await pool.query(
      `SELECT
         period_month, period_year,
         output_vat, input_vat, payable_vat
       FROM vat_reconciliations
       WHERE company_id = $1
         AND (period_year * 100 + period_month) >= (EXTRACT(YEAR FROM NOW() - INTERVAL '11 months')::int * 100 + EXTRACT(MONTH FROM NOW() - INTERVAL '11 months')::int)
       ORDER BY period_year ASC, period_month ASC`,
      [companyId]
    );

    // Invoice count trend by month
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
         AND invoice_date >= NOW() - INTERVAL '11 months'
       GROUP BY 1, 2
       ORDER BY 2 ASC, 1 ASC`,
      [companyId]
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

    const [customers, suppliers, statusBreakdown] = await Promise.all([
      pool.query(
        `SELECT buyer_name AS counterparty_name, buyer_tax_code AS counterparty_tax_code,
                COUNT(*) AS invoice_count,
                SUM(total_amount) AS total_amount,
                SUM(vat_amount) AS total_vat
         FROM invoices
         WHERE company_id = $1 AND direction = 'output'
           AND invoice_date >= NOW() - ($2::int * INTERVAL '1 month')
           AND status = 'valid'
           AND buyer_name IS NOT NULL
         GROUP BY buyer_name, buyer_tax_code
         ORDER BY total_amount DESC NULLS LAST
         LIMIT 5`,
        [companyId, months]
      ),
      pool.query(
        `SELECT seller_name AS counterparty_name, seller_tax_code AS counterparty_tax_code,
                COUNT(*) AS invoice_count,
                SUM(total_amount) AS total_amount,
                SUM(vat_amount) AS total_vat
         FROM invoices
         WHERE company_id = $1 AND direction = 'input'
           AND invoice_date >= NOW() - ($2::int * INTERVAL '1 month')
           AND status = 'valid'
           AND seller_name IS NOT NULL
         GROUP BY seller_name, seller_tax_code
         ORDER BY total_amount DESC NULLS LAST
         LIMIT 5`,
        [companyId, months]
      ),
      pool.query(
        `SELECT status, direction, COUNT(*) AS count
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= NOW() - ($2::int * INTERVAL '1 month')
         GROUP BY status, direction
         ORDER BY count DESC`,
        [companyId, months]
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

