import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';
import { buildDashboardBucketKey, buildTrailingDashboardBuckets } from '../utils/dashboardBuckets';
import { resolvePeriod, type PeriodType } from '../utils/period';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const VIETNAM_TIMEZONE = 'Asia/Ho_Chi_Minh';

function _notReplacedClause(alias: string): string {
  return `AND NOT EXISTS (
       SELECT 1 FROM invoices _r
       WHERE _r.tc_hdon = 1
         AND _r.deleted_at IS NULL
         AND _r.company_id = ${alias}.company_id
         AND TRIM(COALESCE(_r.khhd_cl_quan,  '')) = TRIM(COALESCE(${alias}.serial_number,  ''))
         AND TRIM(COALESCE(_r.so_hd_cl_quan, '')) = TRIM(COALESCE(${alias}.invoice_number, ''))
         AND COALESCE(_r.seller_tax_code, '') = COALESCE(${alias}.seller_tax_code, '')
     )`;
}

function _validOutputVatCondition(alias: string): string {
  return `${alias}.direction = 'output'
               AND ${alias}.status IN ('valid', 'replaced', 'adjusted')
               ${_notReplacedClause(alias)}`;
}

function _deductibleInputVatCondition(alias: string): string {
  return `${alias}.direction = 'input'
               AND ${alias}.status IN ('valid', 'replaced', 'adjusted')
               AND (${alias}.non_deductible = false OR ${alias}.non_deductible IS NULL)
               AND (
                 (${alias}.invoice_group = 5 AND ${alias}.gdt_validated = true)
                 OR (${alias}.invoice_group IN (6, 8))
                 OR (${alias}.invoice_group IS NULL AND ${alias}.gdt_validated = true)
               )
               AND (
                 ${alias}.total_amount <= 20000000
                 OR ${alias}.payment_method IS NULL
                 OR LOWER(${alias}.payment_method) <> 'cash'
               )
               ${_notReplacedClause(alias)}`;
}

async function getCarryForwardInfo(
  companyId: string,
  periodType: PeriodType,
  month: number,
  quarter: number,
  year: number,
): Promise<{ amount: number; label: string }> {
  if (periodType === 'monthly') {
    let prevMonth = month - 1;
    let prevYear = year;
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear -= 1;
    }

    const { rows } = await pool.query<{ amount: string }>(
      `SELECT COALESCE(ct43_carry_forward_vat, 0) AS amount
       FROM tax_declarations
       WHERE company_id = $1
         AND period_month = $2
         AND period_year = $3
         AND form_type = '01/GTGT'
         AND period_type = 'monthly'
       ORDER BY created_at DESC
       LIMIT 1`,
      [companyId, prevMonth, prevYear],
    );

    return {
      amount: Number(rows[0]?.amount ?? 0),
      label: `T${prevMonth}/${String(prevYear).slice(-2)}`,
    };
  }

  if (periodType === 'quarterly') {
    let prevQuarter = quarter - 1;
    let prevYear = year;
    if (prevQuarter === 0) {
      prevQuarter = 4;
      prevYear -= 1;
    }

    const quarterly = await pool.query<{ amount: string }>(
      `SELECT COALESCE(ct43_carry_forward_vat, 0) AS amount
       FROM tax_declarations
       WHERE company_id = $1
         AND period_month = $2
         AND period_year = $3
         AND form_type = '01/GTGT'
         AND period_type = 'quarterly'
       ORDER BY created_at DESC
       LIMIT 1`,
      [companyId, prevQuarter, prevYear],
    );

    if (quarterly.rows.length > 0) {
      return {
        amount: Number(quarterly.rows[0].amount ?? 0),
        label: `Q${prevQuarter}/${String(prevYear).slice(-2)}`,
      };
    }

    const fallbackMonth = prevQuarter * 3;
    const monthly = await pool.query<{ amount: string }>(
      `SELECT COALESCE(ct43_carry_forward_vat, 0) AS amount
       FROM tax_declarations
       WHERE company_id = $1
         AND period_month = $2
         AND period_year = $3
         AND form_type = '01/GTGT'
         AND period_type = 'monthly'
       ORDER BY created_at DESC
       LIMIT 1`,
      [companyId, fallbackMonth, prevYear],
    );

    return {
      amount: Number(monthly.rows[0]?.amount ?? 0),
      label: `Q${prevQuarter}/${String(prevYear).slice(-2)}`,
    };
  }

  const prevYear = year - 1;
  const quarterly = await pool.query<{ amount: string }>(
    `SELECT COALESCE(ct43_carry_forward_vat, 0) AS amount
     FROM tax_declarations
     WHERE company_id = $1
       AND period_month = 4
       AND period_year = $2
       AND form_type = '01/GTGT'
       AND period_type = 'quarterly'
     ORDER BY created_at DESC
     LIMIT 1`,
    [companyId, prevYear],
  );

  if (quarterly.rows.length > 0) {
    return {
      amount: Number(quarterly.rows[0].amount ?? 0),
      label: `Năm ${prevYear}`,
    };
  }

  const monthly = await pool.query<{ amount: string }>(
    `SELECT COALESCE(ct43_carry_forward_vat, 0) AS amount
     FROM tax_declarations
     WHERE company_id = $1
       AND period_month = 12
       AND period_year = $2
       AND form_type = '01/GTGT'
       AND period_type = 'monthly'
     ORDER BY created_at DESC
     LIMIT 1`,
    [companyId, prevYear],
  );

  return {
    amount: Number(monthly.rows[0]?.amount ?? 0),
    label: `Năm ${prevYear}`,
  };
}

// GET /api/dashboard/kpi - key performance indicators for current period
router.get('/kpi', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user?.companyId;
    if (!companyId) {
      throw new Error('Missing companyId in dashboard KPI route');
    }
    const resolved = resolvePeriod(req.query);
    const [invoiceStats, vatStats, syncStats, ytdStats, riskStats, carryForwardInfo, declLookup, reconLookup] = await Promise.all([
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
           AND invoice_date BETWEEN $2 AND $3
           AND deleted_at IS NULL`,
        [companyId, resolved.start, resolved.end]
      ),
      pool.query<{
        output_vat: string;
        input_vat: string;
        deductible_vat: string;
        payable_vat: string;
      }>(
        `SELECT
           COALESCE(SUM(i.vat_amount) FILTER (WHERE i.direction = 'input' AND i.status NOT IN ('cancelled', 'replaced_original')), 0) AS input_vat,
           COALESCE(SUM(i.vat_amount) FILTER (WHERE ${_validOutputVatCondition('i')}), 0) AS output_vat,
           COALESCE(SUM(i.vat_amount) FILTER (WHERE ${_deductibleInputVatCondition('i')}), 0) AS deductible_vat,
           GREATEST(0,
             COALESCE(SUM(i.vat_amount) FILTER (WHERE ${_validOutputVatCondition('i')}), 0) -
             COALESCE(SUM(i.vat_amount) FILTER (WHERE ${_deductibleInputVatCondition('i')}), 0)
           ) AS payable_vat
         FROM invoices i
         WHERE i.company_id = $1
           AND i.invoice_date BETWEEN $2 AND $3
           AND i.deleted_at IS NULL`,
        [companyId, resolved.start, resolved.end]
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
        [companyId, resolved.year]
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
      getCarryForwardInfo(companyId, resolved.periodType, resolved.month, resolved.quarter, resolved.year),
      // Lookup saved tax declaration for this period — when found, ct23/ct41 override tạm tính estimates.
      // period_month stores month (1-12) for monthly, quarter number (1-4) for quarterly.
      pool.query<{ ct23_deductible_input_vat: string; ct41_payable_vat: string; ct40a_total_output_vat: string }>(
        `SELECT ct23_deductible_input_vat, ct41_payable_vat, ct40a_total_output_vat
         FROM tax_declarations
         WHERE company_id = $1
           AND period_month = $2
           AND period_year  = $3
           AND form_type    = '01/GTGT'
           AND period_type  = $4
         ORDER BY updated_at DESC
         LIMIT 1`,
        [
          companyId,
          resolved.periodType === 'quarterly' ? resolved.quarter : resolved.month,
          resolved.year,
          resolved.periodType === 'yearly' ? 'monthly' : resolved.periodType, // yearly has no standard tờ khai
        ]
      ).catch(() => ({ rows: [] as { ct23_deductible_input_vat: string; ct41_payable_vat: string; ct40a_total_output_vat: string }[] })),
      // Lookup vat_reconciliations — populated by VatReconciliationService each time TaxDeclarationEngine
      // runs (even for preview). Used as authoritative ct23 source when no saved declaration exists.
      pool.query<{ input_vat: string; output_vat: string }>(
        `SELECT input_vat, output_vat
         FROM vat_reconciliations
         WHERE company_id = $1
           AND period_month = $2
           AND period_year  = $3
         ORDER BY generated_at DESC
         LIMIT 1`,
        [
          companyId,
          resolved.periodType === 'quarterly' ? resolved.quarter : resolved.month,
          resolved.year,
        ]
      ).catch(() => ({ rows: [] as { input_vat: string; output_vat: string }[] })),
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

    // Tax deadlines — monthly (all 12 months) + quarterly (4 quarters) + annual
    // daysUntil uses Vietnam UTC+7 wall-clock to avoid off-by-one at night.
    const VN_OFFSET_MS = 7 * 60 * 60 * 1_000;
    const todayVN = Math.floor((Date.now() + VN_OFFSET_MS) / 86_400_000);
    const daysUntil = (d: Date) => {
      const dueVN = Math.floor((d.getTime() + VN_OFFSET_MS) / 86_400_000);
      return dueVN - todayVN;
    };
    const monthlyDeadlines = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1; // invoice month 1-12
      const dueMonth = m === 12 ? 1 : m + 1;
      const dueYear  = m === 12 ? resolved.year + 1 : resolved.year;
      const due = new Date(dueYear, dueMonth - 1, 20);
      return {
        label: `Nộp GTGT T${m}/${resolved.year}`,
        due: due.toISOString().split('T')[0],
        days_left: daysUntil(due),
        type: 'gtgt_monthly',
      };
    });
    // Quarterly: last day of first month of next quarter
    // Q1→30/04, Q2→31/07, Q3→31/10, Q4→31/01 next year (Điều 44 Luật 38/2019/QH14)
    const QUARTER_DUE: Record<number, { month: number; day: number }> = {
      1: { month: 4,  day: 30 },
      2: { month: 7,  day: 31 },
      3: { month: 10, day: 31 },
      4: { month: 1,  day: 31 },
    };
    const quarterlyDeadlines = [1, 2, 3, 4].map((q) => {
      const { month: dueMonth, day: dueDay } = QUARTER_DUE[q]!;
      const dueYear = q === 4 ? resolved.year + 1 : resolved.year;
      const due = new Date(dueYear, dueMonth - 1, dueDay);
      return {
        label: `Nộp GTGT Q${q}/${resolved.year}`,
        due: due.toISOString().split('T')[0],
        days_left: daysUntil(due),
        type: 'gtgt_quarterly',
      };
    });
    const taxDeadlines = [...monthlyDeadlines, ...quarterlyDeadlines,
      {
        label: `Quyết toán TNDN ${resolved.year}`,
        due: `${resolved.year + 1}-03-31`,
        days_left: daysUntil(new Date(resolved.year + 1, 2, 31)),
        type: 'cit_annual',
      },
    ].sort((a, b) => a.days_left - b.days_left);

    const rawVatRow = vatStats.rows[0] ?? { output_vat: '0', input_vat: '0', deductible_vat: '0', payable_vat: '0' };
    const declRow   = declLookup.rows[0];
    const reconRow  = reconLookup.rows[0];

    // Priority for deductible VAT (ct23):
    // 1) Saved tax declaration → ct23 from tax_declarations (most authoritative, via pipeline)
    // 2) vat_reconciliations  → input_vat computed by VatReconciliationService (pipeline-filtered,
    //    written on every TaxDeclarationEngine run incl. preview) — matches declaration page values
    // 3) Raw SQL tạm tính     → _deductibleInputVatCondition without pipeline filter (approximate)
    const vatRow = declRow
      ? {
          ...rawVatRow,
          deductible_vat:       declRow.ct23_deductible_input_vat,
          payable_vat:          declRow.ct41_payable_vat,
          output_vat:           declRow.ct40a_total_output_vat,
          vat_from_declaration: true,
        }
      : reconRow
      ? {
          ...rawVatRow,
          deductible_vat: reconRow.input_vat,
          output_vat:     reconRow.output_vat,
          payable_vat: String(Math.max(
            0,
            Number(reconRow.output_vat) -
            Number(reconRow.input_vat)  -
            carryForwardInfo.amount,
          )),
          vat_from_declaration: false,
        }
      : {
          ...rawVatRow,
          // Tạm tính: fix payable_vat to include carry-forward [ct24] so it matches [41] formula
          payable_vat: String(Math.max(
            0,
            Number(rawVatRow.output_vat) -
            Number(rawVatRow.deductible_vat) -
            carryForwardInfo.amount,
          )),
          vat_from_declaration: false,
        };

    sendSuccess(res, {
      period: {
        month: resolved.month,
        quarter: resolved.quarter,
        periodType: resolved.periodType,
        year: resolved.year,
      },
      invoices: invoiceStats.rows[0],
      vat: vatRow,
      recentSyncs: syncStats.rows,
      cit_estimate: citEstimate,
      ytd_revenue: ytdRevenue,
      ytd_cost: ytdCost,
      ytd_profit: ytdProfit,
      risk_score: riskScore,
      carry_forward_vat: carryForwardInfo.amount,
      carry_forward_source_label: carryForwardInfo.label,
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
    const resolved = resolvePeriod(req.query);
    const buckets = buildTrailingDashboardBuckets(resolved.periodType, {
      year: resolved.year,
      month: resolved.month,
      quarter: resolved.quarter,
    });
    const windowStart = buckets[0]!.startDate;
    const windowEndExclusive = buckets[buckets.length - 1]!.endExclusiveDate;

    let vatResult;
    let countTrend;

    if (resolved.periodType === 'quarterly') {
      vatResult = await pool.query<{
        period_year: number;
        period_quarter: number;
        output_vat: string;
        input_vat: string;
      }>(
        `SELECT
           EXTRACT(YEAR FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_year,
           EXTRACT(QUARTER FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_quarter,
           COALESCE(SUM(vat_amount) FILTER (
             WHERE direction = 'output'
               AND status IN ('valid', 'replaced', 'adjusted')
               ${_notReplacedClause('invoices')}
           ), 0) AS output_vat,
           COALESCE(SUM(vat_amount) FILTER (
             WHERE direction = 'input'
               AND status IN ('valid', 'replaced', 'adjusted')
               AND (non_deductible = false OR non_deductible IS NULL)
               AND (
                 (invoice_group = 5 AND gdt_validated = true)
                 OR (invoice_group IN (6, 8))
                 OR (invoice_group IS NULL AND gdt_validated = true)
               )
               AND (
                 total_amount <= 20000000
                 OR payment_method IS NULL
                 OR LOWER(payment_method) <> 'cash'
               )
               ${_notReplacedClause('invoices')}
           ), 0) AS input_vat
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= $2
           AND invoice_date < $3
           AND deleted_at IS NULL
         GROUP BY period_year, period_quarter
         ORDER BY period_year ASC, period_quarter ASC`,
        [companyId, windowStart, windowEndExclusive],
      );

      countTrend = await pool.query<{
        period_year: number;
        period_quarter: number;
        output_total: string;
        input_total: string;
      }>(
        `SELECT
           EXTRACT(YEAR FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_year,
           EXTRACT(QUARTER FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_quarter,
           COALESCE(SUM(total_amount) FILTER (WHERE direction = 'output' AND status != 'cancelled'), 0) AS output_total,
           COALESCE(SUM(total_amount) FILTER (WHERE direction = 'input' AND status != 'cancelled'), 0) AS input_total
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= $2
           AND invoice_date < $3
           AND deleted_at IS NULL
         GROUP BY period_year, period_quarter
         ORDER BY period_year ASC, period_quarter ASC`,
        [companyId, windowStart, windowEndExclusive],
      );
    } else if (resolved.periodType === 'yearly') {
      vatResult = await pool.query<{
        period_year: number;
        output_vat: string;
        input_vat: string;
      }>(
        `SELECT
           EXTRACT(YEAR FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_year,
           COALESCE(SUM(vat_amount) FILTER (
             WHERE direction = 'output'
               AND status IN ('valid', 'replaced', 'adjusted')
               ${_notReplacedClause('invoices')}
           ), 0) AS output_vat,
           COALESCE(SUM(vat_amount) FILTER (
             WHERE direction = 'input'
               AND status IN ('valid', 'replaced', 'adjusted')
               AND (non_deductible = false OR non_deductible IS NULL)
               AND (
                 (invoice_group = 5 AND gdt_validated = true)
                 OR (invoice_group IN (6, 8))
                 OR (invoice_group IS NULL AND gdt_validated = true)
               )
               AND (
                 total_amount <= 20000000
                 OR payment_method IS NULL
                 OR LOWER(payment_method) <> 'cash'
               )
               ${_notReplacedClause('invoices')}
           ), 0) AS input_vat
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= $2
           AND invoice_date < $3
           AND deleted_at IS NULL
         GROUP BY period_year
         ORDER BY period_year ASC`,
        [companyId, windowStart, windowEndExclusive],
      );

      countTrend = await pool.query<{
        period_year: number;
        output_total: string;
        input_total: string;
      }>(
        `SELECT
           EXTRACT(YEAR FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_year,
           COALESCE(SUM(total_amount) FILTER (WHERE direction = 'output' AND status != 'cancelled'), 0) AS output_total,
           COALESCE(SUM(total_amount) FILTER (WHERE direction = 'input' AND status != 'cancelled'), 0) AS input_total
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= $2
           AND invoice_date < $3
           AND deleted_at IS NULL
         GROUP BY period_year
         ORDER BY period_year ASC`,
        [companyId, windowStart, windowEndExclusive],
      );
    } else {
      vatResult = await pool.query<{
        period_year: number;
        period_month: number;
        output_vat: string;
        input_vat: string;
      }>(
        `SELECT
           EXTRACT(MONTH FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_month,
           EXTRACT(YEAR  FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_year,
           COALESCE(SUM(vat_amount) FILTER (
             WHERE direction = 'output'
               AND status IN ('valid', 'replaced', 'adjusted')
               ${_notReplacedClause('invoices')}
           ), 0) AS output_vat,
           COALESCE(SUM(vat_amount) FILTER (
             WHERE direction = 'input'
               AND status IN ('valid', 'replaced', 'adjusted')
               AND (non_deductible = false OR non_deductible IS NULL)
               AND (
                 (invoice_group = 5 AND gdt_validated = true)
                 OR (invoice_group IN (6, 8))
                 OR (invoice_group IS NULL AND gdt_validated = true)
               )
               AND (
                 total_amount <= 20000000
                 OR payment_method IS NULL
                 OR LOWER(payment_method) <> 'cash'
               )
               ${_notReplacedClause('invoices')}
           ), 0) AS input_vat
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= $2
           AND invoice_date < $3
           AND deleted_at IS NULL
         GROUP BY period_month, period_year
         ORDER BY period_year ASC, period_month ASC`,
        [companyId, windowStart, windowEndExclusive],
      );

      countTrend = await pool.query<{
        period_year: number;
        period_month: number;
        output_total: string;
        input_total: string;
      }>(
        `SELECT
           EXTRACT(MONTH FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_month,
           EXTRACT(YEAR  FROM invoice_date AT TIME ZONE '${VIETNAM_TIMEZONE}')::int AS period_year,
           COALESCE(SUM(total_amount) FILTER (WHERE direction = 'output' AND status != 'cancelled'), 0) AS output_total,
           COALESCE(SUM(total_amount) FILTER (WHERE direction = 'input' AND status != 'cancelled'), 0) AS input_total
         FROM invoices
         WHERE company_id = $1
           AND invoice_date >= $2
           AND invoice_date <  $3
           AND deleted_at IS NULL
         GROUP BY period_month, period_year
         ORDER BY period_year ASC, period_month ASC`,
        [companyId, windowStart, windowEndExclusive],
      );
    }

    const vatMap = new Map(
      vatResult.rows.map((row) => {
        const bucketMonth = 'period_month' in row
          ? Number((row as { period_month: number }).period_month)
          : 1;
        const bucketQuarter = 'period_quarter' in row
          ? Number((row as { period_quarter: number }).period_quarter)
          : 1;
        const key = buildDashboardBucketKey(
          resolved.periodType,
          row.period_year,
          bucketMonth,
          bucketQuarter,
        );

        return [key, row] as const;
      }),
    );

    const invoiceMap = new Map(
      countTrend.rows.map((row) => {
        const bucketMonth = 'period_month' in row
          ? Number((row as { period_month: number }).period_month)
          : 1;
        const bucketQuarter = 'period_quarter' in row
          ? Number((row as { period_quarter: number }).period_quarter)
          : 1;
        const key = buildDashboardBucketKey(
          resolved.periodType,
          row.period_year,
          bucketMonth,
          bucketQuarter,
        );

        return [key, row] as const;
      }),
    );

    sendSuccess(res, {
      periodType: resolved.periodType,
      vatTrend: buckets.map((bucket) => {
        const row = vatMap.get(bucket.key);
        const outputVat = Number(row?.output_vat ?? 0);
        const inputVat = Number(row?.input_vat ?? 0);

        return {
          key: bucket.key,
          label: bucket.label,
          output_vat: outputVat,
          input_vat: inputVat,
          payable_vat: Math.max(0, outputVat - inputVat),
        };
      }),
      invoiceTrend: buckets.map((bucket) => {
        const row = invoiceMap.get(bucket.key);
        const outputTotal = Number(row?.output_total ?? 0);
        const inputTotal = Number(row?.input_total ?? 0);

        return {
          key: bucket.key,
          label: bucket.label,
          output_total: outputTotal,
          input_total: inputTotal,
          gross_profit: outputTotal - inputTotal,
        };
      }),
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

