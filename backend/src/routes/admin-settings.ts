/**
 * Admin — System Settings Routes
 *
 * Expose CRUD for the `system_settings` table.
 * Changes are written to DB + Redis Hash + published via Pub/Sub so
 * all running processes (backend, bot) update in-memory with no restart.
 *
 * Mounted at: /api/admin/system-settings
 * Auth: authenticate → requireAdmin (platform admin only)
 */

import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';
import { cfg } from '../config/ConfigStore';
import { sendSuccess } from '../utils/response';
import { ValidationError, NotFoundError } from '../utils/AppError';

const router = Router();
router.use(authenticate, requireAdmin);

// ── Helpers ───────────────────────────────────────────────────────────────────

interface SettingRow {
  key: string;
  value: string;
  type: 'number' | 'string' | 'boolean';
  group_name: string;
  label: string;
  description: string | null;
  example: string | null;
  default_value: string;
  unit: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

const ALLOWED_GROUPS = [
  'bot_safety', 'queue', 'circuit_breaker', 'anti_detection', 'gdt_api', 'business_rules',
] as const;

function validateValue(value: string, type: string, key: string): void {
  if (type === 'number') {
    const n = Number(value);
    if (!isFinite(n)) throw new ValidationError(`${key}: value "${value}" is not a valid number`);
    if (n < 0) throw new ValidationError(`${key}: value must be >= 0`);
  }
  if (type === 'boolean') {
    if (!['true', 'false', '1', '0'].includes(value)) {
      throw new ValidationError(`${key}: boolean value must be one of: true, false, 1, 0`);
    }
  }
}

// ── GET /api/admin/system-settings ───────────────────────────────────────────
// Returns all settings grouped by group_name

router.get('/', async (_req, res) => {
  const { rows } = await pool.query<SettingRow>(`
    SELECT
      s.key, s.value, s.type, s.group_name, s.label,
      s.description, s.example, s.default_value, s.unit,
      s.updated_at,
      u.full_name AS updated_by_name
    FROM system_settings s
    LEFT JOIN users u ON u.id = s.updated_by
    ORDER BY s.group_name, s.key
  `);

  // Group by group_name
  const grouped: Record<string, SettingRow[]> = {};
  for (const row of rows) {
    if (!grouped[row.group_name]) grouped[row.group_name] = [];
    grouped[row.group_name]!.push({
      ...row,
      // Include live in-memory value (may differ if Redis updated but DB write is pending)
      value: cfg.snapshot()[row.key] ?? row.value,
    });
  }

  return sendSuccess(res, {
    groups: ALLOWED_GROUPS.map((g) => ({
      group_name: g,
      settings: grouped[g] ?? [],
    })),
    total: rows.length,
  });
});

// ── GET /api/admin/system-settings/:key ──────────────────────────────────────

router.get('/:key', async (req, res) => {
  const { rows } = await pool.query<SettingRow>(`
    SELECT
      s.key, s.value, s.type, s.group_name, s.label,
      s.description, s.example, s.default_value, s.unit,
      s.updated_at,
      u.full_name AS updated_by_name
    FROM system_settings s
    LEFT JOIN users u ON u.id = s.updated_by
    WHERE s.key = $1
  `, [req.params['key']]);

  if (!rows.length) throw new NotFoundError(`Setting "${req.params['key']}" not found`);
  return sendSuccess(res, rows[0]);
});

// ── PATCH /api/admin/system-settings/:key ────────────────────────────────────
// Update a single setting value

const patchSchema = z.object({
  value: z.string().min(1, 'value must not be empty'),
});

router.patch('/:key', async (req, res) => {
  const { value } = patchSchema.parse(req.body);
  const key = req.params['key']!;

  // Check key exists and get type
  const { rows } = await pool.query<{ type: string }>(
    'SELECT type FROM system_settings WHERE key = $1',
    [key],
  );
  if (!rows.length) throw new NotFoundError(`Setting "${key}" not found`);

  validateValue(value, rows[0]!.type, key);
  await cfg.set(key, value, req.user?.userId);

  return sendSuccess(res, { key, value, updated: true });
});

// ── POST /api/admin/system-settings/:key/reset ───────────────────────────────
// Reset a single setting to its default_value

router.post('/:key/reset', async (req, res) => {
  const key = req.params['key']!;
  await cfg.reset(key, req.user?.userId);

  const { rows } = await pool.query<{ value: string; default_value: string }>(
    'SELECT value, default_value FROM system_settings WHERE key = $1',
    [key],
  );
  if (!rows.length) throw new NotFoundError(`Setting "${key}" not found`);

  return sendSuccess(res, { key, value: rows[0]!.value, reset: true });
});

// ── POST /api/admin/system-settings/bulk ─────────────────────────────────────
// Update multiple settings at once (per-section "Lưu tất cả" button)

const bulkSchema = z.object({
  updates: z.array(z.object({
    key: z.string().min(1),
    value: z.string().min(1),
  })).min(1).max(50),
});

router.post('/bulk', async (req, res) => {
  const { updates } = bulkSchema.parse(req.body);

  // Validate all keys exist and types are correct before writing anything
  const keys = updates.map((u) => u.key);
  const { rows: typeRows } = await pool.query<{ key: string; type: string }>(
    'SELECT key, type FROM system_settings WHERE key = ANY($1)',
    [keys],
  );
  const typeMap = new Map(typeRows.map((r) => [r.key, r.type]));

  const errors: string[] = [];
  for (const { key, value } of updates) {
    if (!typeMap.has(key)) { errors.push(`Unknown key: ${key}`); continue; }
    try {
      validateValue(value, typeMap.get(key)!, key);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length) throw new ValidationError(errors.join('; '));

  // Apply all updates
  const results: { key: string; value: string }[] = [];
  for (const { key, value } of updates) {
    await cfg.set(key, value, req.user?.userId);
    results.push({ key, value });
  }

  return sendSuccess(res, { updated: results.length, results });
});

export default router;
