import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess, sendPaginated } from '../utils/response';
import { NotFoundError } from '../utils/AppError';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/notifications
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 20);
    const offset = (page - 1) * pageSize;
    const unreadOnly = req.query.unreadOnly === 'true';

    const conditions = ['user_id = $1', 'company_id = $2'];
    const params: unknown[] = [req.user!.userId, req.user!.companyId];

    if (unreadOnly) conditions.push('is_read = false');
    const where = conditions.join(' AND ');

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM notifications WHERE ${where}`, params),
      pool.query(
        `SELECT id, type, title, body, data, is_read, created_at
         FROM notifications WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $3 OFFSET $4`,
        [...params, pageSize, offset]
      ),
    ]);

    sendPaginated(res, dataResult.rows, Number(countResult.rows[0].count), page, pageSize);
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM notifications
       WHERE user_id = $1 AND company_id = $2 AND is_read = false`,
      [req.user!.userId, req.user!.companyId]
    );
    sendSuccess(res, { count: Number(rows[0].count) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/read-all — must be BEFORE /:id/read
router.patch('/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = true
       WHERE user_id = $1 AND company_id = $2 AND is_read = false`,
      [req.user!.userId, req.user!.companyId]
    );
    sendSuccess(res, null);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read — mark single as read
router.patch('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.userId]
    );
    if ((rowCount ?? 0) === 0) throw new NotFoundError('Notification not found');
    sendSuccess(res, null);
  } catch (err) {
    next(err);
  }
});

export default router;
