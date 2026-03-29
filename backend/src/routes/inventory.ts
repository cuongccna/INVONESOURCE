/**
 * Group 37 — INV routes
 * Xuat Nhap Ton inventory report from invoice line items.
 */
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { inventoryService } from '../services/InventoryService';
import { resolvePeriod } from '../utils/period';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/inventory?month=&year=&periodType=monthly|quarterly|yearly&quarter=
router.get('/', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { start, end, month, year } = resolvePeriod(req.query);

  const rows = await inventoryService.getBalanceReport(companyId, month, year, start, end);
  sendSuccess(res, rows);
});

// POST /api/inventory/build  — rebuild inventory movements for a period
router.post('/build', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const body = req.body as { month?: number; year?: number; quarter?: number; periodType?: string };
  const { start, end, month: m, year: y, periodType } = resolvePeriod({
    month: String(body.month ?? new Date().getMonth() + 1),
    year: String(body.year ?? new Date().getFullYear()),
    quarter: String(body.quarter ?? 1),
    periodType: body.periodType ?? 'monthly',
  } as Record<string, string>);

  let totalCount = 0;
  if (periodType === 'monthly') {
    totalCount = await inventoryService.buildMovements(companyId, m, y);
  } else {
    // For quarterly/yearly: build for each month in the date range
    const startDate = new Date(start);
    const endDate = new Date(end);
    for (let d = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
         d <= endDate;
         d.setMonth(d.getMonth() + 1)) {
      totalCount += await inventoryService.buildMovements(companyId, d.getMonth() + 1, d.getFullYear());
    }
  }
  sendSuccess(res, { movements_built: totalCount, periodType, start, end });
});

// GET /api/inventory/detail?item=&from=&to=
router.get('/detail', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const item = (req.query.item as string | undefined)?.trim();
  if (!item) throw new AppError('item param required', 400, 'VALIDATION');

  const from = (req.query.from as string | undefined) ?? `${new Date().getFullYear()}-01-01`;
  const to = (req.query.to as string | undefined) ?? new Date().toISOString().split('T')[0];

  const rows = await inventoryService.getMovementDetail(companyId, item, from, to);
  sendSuccess(res, rows);
});

// POST /api/inventory/opening-balance
router.post('/opening-balance', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { item_name, unit, quantity, unit_cost, as_of_date } = req.body as Record<string, unknown>;
  if (!item_name || quantity === undefined || unit_cost === undefined) {
    throw new AppError('item_name, quantity, unit_cost required', 400, 'VALIDATION');
  }

  const asOf = (as_of_date as string | undefined) ?? new Date().toISOString().split('T')[0];
  await inventoryService.upsertOpeningBalance(
    companyId,
    String(item_name),
    unit ? String(unit) : '',
    Number(quantity),
    Number(unit_cost),
    asOf,
    req.user!.userId,
  );
  sendSuccess(res, null, 'Opening balance saved');
});

export default router;
