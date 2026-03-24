import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  direction: z.enum(['output', 'input']).optional(),
  status: z.enum(['valid', 'cancelled', 'replaced', 'adjusted', 'invalid']).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  search: z.string().optional(),
});

// GET /api/invoices
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listSchema.safeParse(req.query);
    if (!query.success) throw new ValidationError(query.error.issues[0]?.message ?? 'Invalid query');

    const { page, pageSize, direction, status, fromDate, toDate, search } = query.data;
    const companyId = req.user!.companyId;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['company_id = $1'];
    const params: unknown[] = [companyId];
    let idx = 2;

    if (direction) { conditions.push(`direction = $${idx++}`); params.push(direction); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (fromDate) { conditions.push(`invoice_date >= $${idx++}`); params.push(fromDate); }
    if (toDate) { conditions.push(`invoice_date <= $${idx++}`); params.push(toDate); }
    if (search) {
      conditions.push(`(invoice_number ILIKE $${idx} OR seller_name ILIKE $${idx} OR buyer_name ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.join(' AND ');

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM invoices WHERE ${where}`, params),
      pool.query(
        `SELECT id, invoice_number, serial_number, invoice_date, direction, status,
                seller_name, seller_tax_code, buyer_name, buyer_tax_code,
                total_amount, vat_amount, vat_rate, gdt_validated, provider
         FROM invoices WHERE ${where}
         ORDER BY invoice_date DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, pageSize, offset]
      ),
    ]);

    sendPaginated(res, dataResult.rows, Number(countResult.rows[0].count), page, pageSize);
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user!.companyId]
    );
    if (!result.rows[0]) throw new NotFoundError('Invoice not found');
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/sync — trigger manual sync
router.post('/sync', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { syncQueue } = await import('../jobs/SyncWorker');
    const companyId = req.user!.companyId;
    if (!companyId) throw new Error('Company not associated with user');
    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const toDate = now.toISOString();
    const jobId = await syncQueue.add(
      'manual-sync',
      { companyId, fromDate, toDate, triggeredBy: 'manual' },
      { jobId: `manual-${companyId}-${Date.now()}` }
    );
    sendSuccess(res, { jobId: jobId.id }, 'Sync job queued');
  } catch (err) {
    next(err);
  }
});

export default router;
