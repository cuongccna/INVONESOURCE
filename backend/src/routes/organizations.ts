import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendSuccess, sendError } from '../utils/response';
import { AppError } from '../utils/AppError';

const router = Router();
router.use(authenticate);

// ─── Helper: assert user has access to org ─────────────────────────────────
async function assertOrgAccess(userId: string, orgId: string): Promise<void> {
  const chk = await pool.query(
    `SELECT 1 FROM user_companies uc
     JOIN companies c ON c.id = uc.company_id
     WHERE uc.user_id = $1 AND c.organization_id = $2
     LIMIT 1`,
    [userId, orgId],
  );
  if (chk.rowCount === 0) throw new AppError('Organization not found or access denied', 403, 'ORG_ACCESS_DENIED');
}

// GET /api/organizations — list orgs the current user belongs to
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const result = await pool.query(
    `SELECT o.id, o.name, o.short_name, o.created_at,
            COUNT(DISTINCT c.id)::int AS company_count,
            MIN(uc.role) AS user_role
     FROM organizations o
     JOIN companies c ON c.organization_id = o.id
     JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $1
     GROUP BY o.id
     ORDER BY o.name`,
    [userId],
  );
  sendSuccess(res, result.rows);
});

// POST /api/organizations — create new org
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { name, short_name } = req.body as { name?: string; short_name?: string };
  if (!name?.trim()) throw new AppError('name is required', 400, 'VALIDATION_ERROR');

  const result = await pool.query(
    `INSERT INTO organizations (name, short_name) VALUES ($1, $2) RETURNING *`,
    [name.trim(), short_name?.trim() ?? null],
  );
  res.status(201).json({ success: true, data: result.rows[0] });
});

// GET /api/organizations/:id — org detail + company tree
router.get('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const orgId = req.params.id;
  await assertOrgAccess(userId, orgId);

  const [orgRes, companiesRes] = await Promise.all([
    pool.query(`SELECT * FROM organizations WHERE id = $1`, [orgId]),
    pool.query(
      `SELECT c.id, c.name, c.tax_code, c.level, c.entity_type, c.parent_id,
              c.is_consolidated, c.organization_id
       FROM companies c
       WHERE c.organization_id = $1
       ORDER BY c.level, c.name`,
      [orgId],
    ),
  ]);
  if (orgRes.rowCount === 0) throw new AppError('Organization not found', 404, 'NOT_FOUND');

  // Build nested tree
  interface CompanyNode {
    id: string; name: string; tax_code: string; level: number;
    entity_type: string; parent_id: string | null;
    is_consolidated: boolean; children: CompanyNode[];
  }
  const all = companiesRes.rows as CompanyNode[];
  const byId = new Map(all.map((c) => [c.id, { ...c, children: [] as CompanyNode[] }]));
  const roots: CompanyNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  sendSuccess(res, { ...orgRes.rows[0], companies: roots });
});

// PUT /api/organizations/:id — update org
router.put('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const orgId = req.params.id;
  await assertOrgAccess(userId, orgId);

  const { name, short_name } = req.body as { name?: string; short_name?: string };
  if (!name?.trim()) throw new AppError('name is required', 400, 'VALIDATION_ERROR');

  const result = await pool.query(
    `UPDATE organizations SET name=$1, short_name=$2 WHERE id=$3 RETURNING *`,
    [name.trim(), short_name?.trim() ?? null, orgId],
  );
  sendSuccess(res, result.rows[0]);
});

// POST /api/organizations/:id/companies — add existing company to org
router.post('/:id/companies', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const orgId = req.params.id;
  await assertOrgAccess(userId, orgId);

  const { companyId, parentId, entityType } = req.body as {
    companyId?: string; parentId?: string; entityType?: string;
  };
  if (!companyId) throw new AppError('companyId is required', 400, 'VALIDATION_ERROR');

  // Verify user owns the company
  const access = await pool.query(
    `SELECT 1 FROM user_companies WHERE user_id=$1 AND company_id=$2`, [userId, companyId]);
  if (access.rowCount === 0) throw new AppError('No access to company', 403, 'FORBIDDEN');

  await pool.query(
    `UPDATE companies SET organization_id=$1, parent_id=$2, entity_type=COALESCE($3::text, entity_type)
     WHERE id=$4`,
    [orgId, parentId ?? null, entityType ?? null, companyId],
  );
  sendSuccess(res, { ok: true });
});

// DELETE /api/organizations/:id/companies/:companyId — remove company from org
router.delete('/:id/companies/:companyId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const orgId = req.params.id;
  await assertOrgAccess(userId, orgId);

  await pool.query(
    `UPDATE companies SET organization_id=NULL, parent_id=NULL
     WHERE id=$1 AND organization_id=$2`,
    [req.params.companyId, orgId],
  );
  sendSuccess(res, { ok: true });
});

// PATCH /api/organizations/:id/companies/:companyId/parent — change parent
router.patch('/:id/companies/:companyId/parent', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const orgId = req.params.id;
  await assertOrgAccess(userId, orgId);

  const { parentId } = req.body as { parentId?: string | null };
  await pool.query(
    `UPDATE companies SET parent_id=$1 WHERE id=$2 AND organization_id=$3`,
    [parentId ?? null, req.params.companyId, orgId],
  );
  sendSuccess(res, { ok: true });
});

export default router;
