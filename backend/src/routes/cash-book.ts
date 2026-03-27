/**
 * Group 38 — CASH routes
 * Cash book (So Quy Tien / So Ngan Hang).
 */
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { cashBookService } from '../services/CashBookService';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/cash-book?month=&year=&method=cash|bank
router.get('/', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const method = req.query.method as string | undefined;
  if (month < 1 || month > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');

  const data = await cashBookService.getEntries(companyId, month, year, method);
  sendSuccess(res, data);
});

// POST /api/cash-book/entries  — manual phieu thu/chi
router.post('/entries', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { entry_type, entry_date, amount, description, partner_name, partner_tax_code,
          reference_number, category, payment_method, bank_account } = req.body as Record<string, unknown>;

  if (!entry_type || !entry_date || amount === undefined) {
    throw new AppError('entry_type, entry_date, amount required', 400, 'VALIDATION');
  }
  if (!['receipt','payment','transfer','opening'].includes(entry_type as string)) {
    throw new AppError('Invalid entry_type', 400, 'VALIDATION');
  }

  const entry = await cashBookService.addEntry(companyId, {
    entry_type: entry_type as 'receipt' | 'payment' | 'transfer' | 'opening',
    entry_date: entry_date as string,
    amount: Number(amount),
    description: description ? String(description) : undefined,
    partner_name: partner_name ? String(partner_name) : undefined,
    partner_tax_code: partner_tax_code ? String(partner_tax_code) : undefined,
    reference_number: reference_number ? String(reference_number) : undefined,
    category: category ? String(category) : undefined,
    payment_method: payment_method ? String(payment_method) : 'cash',
    bank_account: bank_account ? String(bank_account) : undefined,
  }, req.user!.userId);

  sendSuccess(res, entry, 'Entry created');
});

// PUT /api/cash-book/entries/:id
router.put('/entries/:id', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const updates = req.body as Record<string, unknown>;
  await cashBookService.updateEntry(companyId, id, updates);
  sendSuccess(res, null, 'Entry updated');
});

// DELETE /api/cash-book/entries/:id
router.delete('/entries/:id', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  await cashBookService.deleteEntry(companyId, id);
  sendSuccess(res, null, 'Entry deleted');
});

// POST /api/cash-book/sync/:invoiceId  — sync from single invoice
router.post('/sync/:invoiceId', async (req: Request, res: Response) => {
  const { invoiceId } = req.params;
  await cashBookService.syncFromInvoice(invoiceId);
  sendSuccess(res, null, 'Synced');
});

export default router;
