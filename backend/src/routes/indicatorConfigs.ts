import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { sendSuccess } from '../utils/response';
import { NotFoundError } from '../utils/AppError';

const router = Router();
router.use(authenticate);

// GET /api/indicator-configs?form_type=01/GTGT
router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const formType = String(req.query.form_type ?? '01/GTGT');
      const { rows } = await pool.query(
        `SELECT * FROM declaration_indicator_configs
         WHERE form_type = $1 AND is_active = true
         ORDER BY display_order ASC`,
        [formType]
      );
      sendSuccess(res, rows);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/indicator-configs/:id — update label/notes/formula (OWNER only)
router.patch(
  '/:id',
  requireRole('OWNER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({
        label:               z.string().min(1).optional(),
        notes:               z.string().nullable().optional(),
        formula_expression:  z.string().nullable().optional(),
      }).parse(req.body);

      const sets: string[] = [];
      const params: unknown[] = [req.params.id];
      let idx = 2;
      if (body.label               !== undefined) { sets.push(`label = $${idx++}`);               params.push(body.label); }
      if (body.notes               !== undefined) { sets.push(`notes = $${idx++}`);               params.push(body.notes); }
      if (body.formula_expression  !== undefined) { sets.push(`formula_expression = $${idx++}`);  params.push(body.formula_expression); }

      if (!sets.length) { sendSuccess(res, {}, 'Không có thay đổi'); return; }
      sets.push('updated_at = NOW()');

      const { rows } = await pool.query(
        `UPDATE declaration_indicator_configs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );
      if (!rows[0]) throw new NotFoundError('Indicator config not found');
      sendSuccess(res, rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
