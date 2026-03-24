import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { sendSuccess } from '../utils/response';
import { ValidationError, NotFoundError } from '../utils/AppError';

const router = Router();
router.use(authenticate);

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().optional(),
});

// POST /api/push/subscribe
router.post('/subscribe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid subscription data');

    const { endpoint, keys, userAgent } = parsed.data;

    await pool.query(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = $4, auth = $5, user_agent = $6`,
      [uuidv4(), req.user!.userId, endpoint, keys.p256dh, keys.auth, userAgent ?? null]
    );

    sendSuccess(res, null, 'Subscribed to push notifications');
  } catch (err) {
    next(err);
  }
});

// DELETE /api/push/unsubscribe
router.delete('/unsubscribe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { endpoint } = req.body as { endpoint?: string };
    if (!endpoint) throw new ValidationError('endpoint is required');

    const result = await pool.query(
      `DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2 RETURNING id`,
      [endpoint, req.user!.userId]
    );
    if (!result.rows[0]) throw new NotFoundError('Subscription not found');

    sendSuccess(res, null, 'Unsubscribed from push notifications');
  } catch (err) {
    next(err);
  }
});

export default router;
