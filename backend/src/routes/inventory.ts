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

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/inventory?month=&year=
router.get('/', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  if (month < 1 || month > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');

  const rows = await inventoryService.getBalanceReport(companyId, month, year);
  sendSuccess(res, rows);
});

// POST /api/inventory/build  — rebuild inventory movements for a period
router.post('/build', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { month, year } = req.body as { month?: number; year?: number };
  const m = parseInt(String(month)) || new Date().getMonth() + 1;
  const y = parseInt(String(year)) || new Date().getFullYear();
  if (m < 1 || m > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');

  const count = await inventoryService.buildMovements(companyId, m, y);
  sendSuccess(res, { movements_built: count, month: m, year: y });
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
