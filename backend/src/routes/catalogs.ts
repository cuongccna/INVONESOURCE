/**
 * Group 36 — CAT routes
 * Auto-code generation & catalog management for Products, Customers, Suppliers.
 */
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { pool } from '../db/pool';
import { sendSuccess, sendPaginated } from '../utils/response';
import { AppError } from '../utils/AppError';
import { autoCodeService } from '../services/AutoCodeService';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// ─── Products ────────────────────────────────────────────────────────────────

// GET /api/catalogs/products?page=&pageSize=&q=
router.get('/products', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
  const offset = (page - 1) * pageSize;
  const q = (req.query.q as string | undefined)?.trim() ?? '';

  let where = 'WHERE company_id=$1';
  const params: unknown[] = [companyId];
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (display_name ILIKE $${params.length} OR item_code ILIKE $${params.length} OR category_name ILIKE $${params.length})`;
  }

  const countRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM product_catalog ${where}`,
    params,
  );
  const total = parseInt(countRes.rows[0]?.count ?? '0');

  params.push(pageSize, offset);
  const dataRes = await pool.query(
    `SELECT *, display_name AS item_name
     FROM product_catalog ${where} ORDER BY item_code NULLS LAST, display_name LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  sendPaginated(res, dataRes.rows, total, page, pageSize);
});

// PUT /api/catalogs/products/:id
router.put('/products/:id', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const { category_code, category_name, is_service, unit, avg_purchase_price, avg_sale_price } = req.body as Record<string, unknown>;

  const check = await pool.query(
    `SELECT id FROM product_catalog WHERE id=$1 AND company_id=$2`,
    [id, companyId],
  );
  if (!check.rows.length) throw new AppError('Product not found', 404, 'NOT_FOUND');

  const { rows } = await pool.query(
    `UPDATE product_catalog SET
       category_code=COALESCE($3,category_code),
       category_name=COALESCE($4,category_name),
       is_service=COALESCE($5,is_service),
       unit=COALESCE($6,unit),
       avg_purchase_price=COALESCE($7,avg_purchase_price),
       avg_sale_price=COALESCE($8,avg_sale_price),
       updated_at=NOW()
     WHERE id=$1 AND company_id=$2
     RETURNING *`,
    [id, companyId, category_code ?? null, category_name ?? null,
     is_service ?? null, unit ?? null, avg_purchase_price ?? null, avg_sale_price ?? null],
  );
  sendSuccess(res, rows[0]);
});

// ─── Customers ───────────────────────────────────────────────────────────────

// GET /api/catalogs/customers?page=&pageSize=&q=
router.get('/customers', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
  const offset = (page - 1) * pageSize;
  const q = (req.query.q as string | undefined)?.trim() ?? '';

  let where = 'WHERE c.company_id=$1';
  const params: unknown[] = [companyId];
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (c.name ILIKE $${params.length} OR c.customer_code ILIKE $${params.length} OR c.tax_code ILIKE $${params.length})`;
  }

  const countRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM customer_catalog c ${where}`, params);
  const total = parseInt(countRes.rows[0]?.count ?? '0');

  params.push(pageSize, offset);
  // Compute revenue_12m live from invoices (JOIN) so it's always accurate
  const dataRes = await pool.query(
    `SELECT c.*,
       COALESCE(agg.revenue_12m, 0) AS total_revenue_12m,
       COALESCE(agg.inv_count, c.invoice_count_12m) AS invoice_count_12m
     FROM customer_catalog c
     LEFT JOIN (
       SELECT buyer_tax_code,
              SUM(total_amount) AS revenue_12m,
              COUNT(*)          AS inv_count
       FROM invoices
       WHERE company_id = $1
         AND direction = 'output'
         AND status != 'cancelled'
         AND deleted_at IS NULL
         AND invoice_date >= CURRENT_DATE - INTERVAL '12 months'
       GROUP BY buyer_tax_code
     ) agg ON agg.buyer_tax_code = c.tax_code
     ${where} ORDER BY c.customer_code LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  sendPaginated(res, dataRes.rows, total, page, pageSize);
});

// PUT /api/catalogs/customers/:id
router.put('/customers/:id', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const { name, province_code } = req.body as Record<string, unknown>;

  const check = await pool.query(
    `SELECT id FROM customer_catalog WHERE id=$1 AND company_id=$2`, [id, companyId]);
  if (!check.rows.length) throw new AppError('Customer not found', 404, 'NOT_FOUND');

  const { rows } = await pool.query(
    `UPDATE customer_catalog SET
       name=COALESCE($3,name), province_code=COALESCE($4,province_code), updated_at=NOW()
     WHERE id=$1 AND company_id=$2 RETURNING *`,
    [id, companyId, name ?? null, province_code ?? null],
  );
  sendSuccess(res, rows[0]);
});

// ─── Suppliers ───────────────────────────────────────────────────────────────

// GET /api/catalogs/suppliers?page=&pageSize=&q=
router.get('/suppliers', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
  const offset = (page - 1) * pageSize;
  const q = (req.query.q as string | undefined)?.trim() ?? '';

  let where = 'WHERE c.company_id=$1';
  const params: unknown[] = [companyId];
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (c.name ILIKE $${params.length} OR c.supplier_code ILIKE $${params.length} OR c.tax_code ILIKE $${params.length})`;
  }

  const countRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM supplier_catalog c ${where}`, params);
  const total = parseInt(countRes.rows[0]?.count ?? '0');

  params.push(pageSize, offset);
  // Compute spend_12m live from invoices (JOIN) so it's always accurate
  const dataRes = await pool.query(
    `SELECT c.*,
       COALESCE(agg.spend_12m, 0) AS total_spend_12m,
       COALESCE(agg.inv_count, c.invoice_count_12m) AS invoice_count_12m
     FROM supplier_catalog c
     LEFT JOIN (
       SELECT seller_tax_code,
              SUM(total_amount) AS spend_12m,
              COUNT(*)          AS inv_count
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status != 'cancelled'
         AND deleted_at IS NULL
         AND invoice_date >= CURRENT_DATE - INTERVAL '12 months'
       GROUP BY seller_tax_code
     ) agg ON agg.seller_tax_code = c.tax_code
     ${where} ORDER BY c.supplier_code LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  sendPaginated(res, dataRes.rows, total, page, pageSize);
});

// PUT /api/catalogs/suppliers/:id
router.put('/suppliers/:id', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const { name } = req.body as Record<string, unknown>;

  const check = await pool.query(
    `SELECT id FROM supplier_catalog WHERE id=$1 AND company_id=$2`, [id, companyId]);
  if (!check.rows.length) throw new AppError('Supplier not found', 404, 'NOT_FOUND');

  const { rows } = await pool.query(
    `UPDATE supplier_catalog SET name=COALESCE($3,name), updated_at=NOW()
     WHERE id=$1 AND company_id=$2 RETURNING *`,
    [id, companyId, name ?? null],
  );
  sendSuccess(res, rows[0]);
});

// ─── Rebuild catalogs ─────────────────────────────────────────────────────────

// POST /api/catalogs/rebuild
router.post('/rebuild', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const result = await autoCodeService.rebuildCatalogs(companyId);
  sendSuccess(res, result, 'Catalog rebuild queued successfully');
});

export default router;
