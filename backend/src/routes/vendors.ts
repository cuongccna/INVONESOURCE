import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { pool } from '../db/pool';
import { sendSuccess, sendPaginated } from '../utils/response';
import { AppError } from '../utils/AppError';
import { VendorPriceTrackingService } from '../services/VendorPriceTrackingService';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/vendors?month=&year= — vendor list for period
router.get('/', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const m = parseInt(req.query.month as string ?? String(new Date().getMonth() + 1), 10);
  const y = parseInt(req.query.year  as string ?? String(new Date().getFullYear()), 10);
  const data = await VendorPriceTrackingService.getVendorList(companyId, m, y);
  sendSuccess(res, data);
});

// GET /api/vendors/price-alerts?unacknowledged=true&page=&pageSize=
router.get('/price-alerts', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const unackOnly = req.query.unacknowledged === 'true';
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 50);
  const { data, total } = await VendorPriceTrackingService.getAlerts(companyId, unackOnly, page, pageSize);
  sendPaginated(res, data as object[], total, page, pageSize);
});

// POST /api/vendors/price-alerts/scan — trigger scan for current period
router.post('/price-alerts/scan', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const m = parseInt(req.body.month ?? String(new Date().getMonth() + 1), 10);
  const y = parseInt(req.body.year  ?? String(new Date().getFullYear()), 10);
  const alerts = await VendorPriceTrackingService.trackPriceChanges(companyId, m, y);
  sendSuccess(res, { scanned: alerts.length, alerts });
});

// PATCH /api/vendors/price-alerts/:id/acknowledge
router.patch('/price-alerts/:id/acknowledge', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const result = await pool.query(
    `UPDATE price_alerts SET is_acknowledged = true
     WHERE id = $1 AND company_id = $2 RETURNING id`,
    [req.params.id, companyId],
  );
  if (result.rowCount === 0) throw new AppError('Alert not found', 404, 'NOT_FOUND');
  sendSuccess(res, { ok: true });
});

// GET /api/vendors/:taxCode/history — price history for a vendor's items
router.get('/:taxCode/history', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { taxCode } = req.params;
  const { itemName } = req.query as { itemName?: string };

  const itemFilter = itemName ? 'AND il.item_name = $3' : '';
  const params: unknown[] = [companyId, taxCode];
  if (itemName) params.push(itemName);

  const res2 = await pool.query(
    `SELECT
       EXTRACT(MONTH FROM inv.invoice_date)::int AS month,
       EXTRACT(YEAR  FROM inv.invoice_date)::int AS year,
       il.item_name,
       AVG(il.unit_price)::numeric(18,2) AS avg_price,
       SUM(il.quantity) AS total_qty,
       COUNT(*)::int AS line_count
     FROM invoice_line_items il
     JOIN invoices inv ON inv.id = il.invoice_id
     WHERE inv.company_id = $1
       AND inv.seller_tax_code = $2
       AND inv.direction = 'input' AND inv.status = 'valid'
       AND inv.deleted_at IS NULL
       AND il.unit_price > 0
       ${itemFilter}
     GROUP BY il.item_name, EXTRACT(MONTH FROM inv.invoice_date), EXTRACT(YEAR FROM inv.invoice_date)
     ORDER BY year, month`,
    params,
  );
  sendSuccess(res, res2.rows);
});

export default router;
