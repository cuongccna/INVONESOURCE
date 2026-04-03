import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { NotFoundError, ValidationError } from '../utils/AppError';
import { sendSuccess } from '../utils/response';

const router = Router();
router.use(authenticate);

// ── Schemas ──────────────────────────────────────────────────────────────────

const upsertSchema = z.object({
  recipe: z.record(z.unknown()),
  notes:  z.string().max(1000).optional(),
});

// ── GET /api/crawler-recipes — list all recipes ──────────────────────────────

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT id, name, version, is_active, recipe, notes, updated_at, updated_by
         FROM crawler_recipes
        ORDER BY name`,
    );
    sendSuccess(res, result.rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/crawler-recipes/:name — get one recipe ──────────────────────────

router.get('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT id, name, version, is_active, recipe, notes, updated_at, updated_by
         FROM crawler_recipes
        WHERE name = $1
        LIMIT 1`,
      [req.params['name']],
    );
    if (result.rows.length === 0) throw new NotFoundError(`Recipe '${req.params['name']}' not found`);
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/crawler-recipes/:name — upsert recipe ───────────────────────────

router.put(
  '/:name',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = upsertSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors.map(e => e.message).join('; '));
      }
      const { recipe, notes } = parsed.data;
      const name  = req.params['name']!;
      const email = (req as Request & { user?: { email?: string } }).user?.email ?? null;

      const result = await pool.query(
        `INSERT INTO crawler_recipes (name, recipe, notes, updated_by)
              VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (name) DO UPDATE
               SET recipe     = EXCLUDED.recipe,
                   notes      = COALESCE(EXCLUDED.notes, crawler_recipes.notes),
                   version    = crawler_recipes.version + 1,
                   updated_at = NOW(),
                   updated_by = EXCLUDED.updated_by
           RETURNING id, name, version, is_active, recipe, notes, updated_at, updated_by`,
        [name, JSON.stringify(recipe), notes ?? null, email],
      );
      sendSuccess(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/crawler-recipes/:name/activate ─────────────────────────────────

router.post(
  '/:name/activate',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `UPDATE crawler_recipes SET is_active = true, updated_at = NOW()
          WHERE name = $1
          RETURNING id, name, version, is_active, updated_at`,
        [req.params['name']],
      );
      if (result.rows.length === 0) throw new NotFoundError(`Recipe '${req.params['name']}' not found`);
      sendSuccess(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/crawler-recipes/:name/deactivate ───────────────────────────────

router.post(
  '/:name/deactivate',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `UPDATE crawler_recipes SET is_active = false, updated_at = NOW()
          WHERE name = $1
          RETURNING id, name, version, is_active, updated_at`,
        [req.params['name']],
      );
      if (result.rows.length === 0) throw new NotFoundError(`Recipe '${req.params['name']}' not found`);
      sendSuccess(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
