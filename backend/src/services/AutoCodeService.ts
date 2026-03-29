/**
 * Group 36 — CAT-01: Auto-code generation engine
 * Generates deterministic human-readable codes for products, customers, suppliers.
 * Idempotent: same tax_code / item_name always gets same code per company.
 */
import { pool } from '../db/pool';

// ── Province prefix map (first 2 digits of tax code) ──────────────────────
const PROVINCE_MAP: Record<string, string> = {
  '01': 'HNO', '02': 'HAI', '03': 'QNI', '04': 'BAC', '05': 'HAB',
  '06': 'HAT', '07': 'HCM', '08': 'BDU', '09': 'DAN', '10': 'CAN',
  '11': 'VPH', '12': 'THA', '13': 'BTH', '14': 'LAN', '15': 'NAD',
  '16': 'HYN', '17': 'HPH', '18': 'TTH', '19': 'KHO', '20': 'GLA',
  '21': 'BRH', '22': 'DNI', '23': 'LCH', '24': 'SLA', '25': 'YBA',
  '26': 'HGB', '27': 'TNQ', '28': 'CBO', '29': 'TYN', '30': 'PTO',
  '31': 'VTU', '32': 'TGG', '33': 'BTE', '34': 'HDG', '35': 'NBH',
  '36': 'TBH', '37': 'NGH', '38': 'HTI', '39': 'QBI', '40': 'QNM',
  '41': 'KTM', '42': 'DAK', '43': 'LDO', '44': 'NTH', '45': 'BTN',
  '46': 'STR', '47': 'KGG', '48': 'ATG', '49': 'VLG', '50': 'TNH',
};

function getProvince(taxCode: string): string {
  const prefix = taxCode.substring(0, 2);
  return PROVINCE_MAP[prefix] ?? 'XXX';
}

// ── Product category detection via keyword rules ───────────────────────────
const CATEGORY_RULES: Array<{ keywords: string[]; code: string; name: string; isService: boolean }> = [
  { keywords: ['giấy', 'bút', 'mực', 'văn phòng', 'in', 'photocopy', 'phong bì', 'kẹp', 'đóng'], code: 'VPPM', name: 'Văn phòng phẩm', isService: false },
  { keywords: ['thực phẩm', 'đồ uống', 'nước', 'bia', 'rượu', 'thức ăn', 'bánh', 'kẹo', 'gạo', 'mì'], code: 'TPCN', name: 'Thực phẩm & đồ uống', isService: false },
  { keywords: ['xây dựng', 'xi măng', 'sắt thép', 'gạch', 'cát', 'đá', 'vật liệu xây', 'công trình', 'nhà'], code: 'XDCT', name: 'Xây dựng & công trình', isService: false },
  { keywords: ['máy tính', 'laptop', 'điện thoại', 'thiết bị', 'server', 'router', 'máy in', 'màn hình', 'điện tử', 'phần mềm'], code: 'MTBM', name: 'Máy tính & thiết bị', isService: false },
  { keywords: ['bao bì', 'thùng', 'hộp', 'túi', 'nhãn', 'đóng gói', 'carton', 'nilon'], code: 'BBHH', name: 'Bao bì & đóng gói', isService: false },
  { keywords: ['vật liệu', 'nguyên liệu', 'hóa chất', 'nhựa', 'cao su', 'kim loại', 'phụ kiện sản xuất'], code: 'VLSX', name: 'Vật liệu sản xuất', isService: false },
  { keywords: ['vận tải', 'vận chuyển', 'giao hàng', 'logistics', 'cước', 'chuyển phát'], code: 'DVVU', name: 'Dịch vụ vận tải', isService: true },
  { keywords: ['tư vấn', 'kiểm toán', 'kế toán', 'pháp lý', 'luật', 'thiết kế', 'marketing', 'quảng cáo'], code: 'DVTU', name: 'Dịch vụ tư vấn', isService: true },
  { keywords: ['dịch vụ', 'sửa chữa', 'bảo trì', 'bảo dưỡng', 'lắp đặt', 'thi công'], code: 'DVKH', name: 'Dịch vụ khác', isService: true },
];

function detectCategory(itemName: string): { code: string; name: string; isService: boolean } {
  const lower = itemName.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return { code: rule.code, name: rule.name, isService: rule.isService };
    }
  }
  return { code: 'HHKH', name: 'Hàng hóa khác', isService: false };
}

// ── Sequence management ────────────────────────────────────────────────────
async function nextSeq(companyId: string, seqType: string, prefix: string): Promise<number> {
  const result = await pool.query<{ current_val: number }>(
    `INSERT INTO code_sequences (company_id, seq_type, prefix, current_val)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (company_id, seq_type, prefix)
     DO UPDATE SET current_val = code_sequences.current_val + 1
     RETURNING current_val`,
    [companyId, seqType, prefix],
  );
  return result.rows[0]!.current_val;
}

function padSeq(n: number): string {
  return String(n).padStart(4, '0');
}

// ── Public API ─────────────────────────────────────────────────────────────
export class AutoCodeService {
  /** Upsert customer_catalog row and return/assign code. Idempotent. */
  async ensureCustomer(companyId: string, taxCode: string, name: string, invoiceDate?: string | null): Promise<string> {
    const province = getProvince(taxCode);
    const prefix = `KH-${province}`;

    // Upsert — only assign code if not yet assigned
    const existing = await pool.query<{ customer_code: string | null }>(
      `SELECT customer_code FROM customer_catalog WHERE company_id=$1 AND tax_code=$2`,
      [companyId, taxCode],
    );

    if (existing.rows.length > 0 && existing.rows[0]!.customer_code) {
      // Update stats only
      await pool.query(
        `UPDATE customer_catalog SET
           name=COALESCE($3,name),
           invoice_count_12m = invoice_count_12m + 1,
           last_invoice_date = GREATEST(last_invoice_date, $4::date),
           updated_at = NOW()
         WHERE company_id=$1 AND tax_code=$2`,
        [companyId, taxCode, name, invoiceDate ?? null],
      );
      return existing.rows[0]!.customer_code;
    }

    const seq = await nextSeq(companyId, 'customer', prefix);
    const code = `${prefix}-${padSeq(seq)}`;

    await pool.query(
      `INSERT INTO customer_catalog (company_id, customer_code, tax_code, name, province_code, invoice_count_12m, last_invoice_date)
       VALUES ($1,$2,$3,$4,$5,1,$6)
       ON CONFLICT (company_id, tax_code) DO UPDATE SET
         customer_code = COALESCE(customer_catalog.customer_code, EXCLUDED.customer_code),
         name = EXCLUDED.name,
         invoice_count_12m = customer_catalog.invoice_count_12m + 1,
         last_invoice_date = GREATEST(customer_catalog.last_invoice_date, EXCLUDED.last_invoice_date),
         updated_at = NOW()`,
      [companyId, code, taxCode, name, province, invoiceDate ?? null],
    );
    return code;
  }

  /** Upsert supplier_catalog row. Idempotent. */
  async ensureSupplier(companyId: string, taxCode: string, name: string, invoiceDate?: string | null): Promise<string> {
    const province = getProvince(taxCode);
    const prefix = `NCC-${province}`;

    const existing = await pool.query<{ supplier_code: string | null }>(
      `SELECT supplier_code FROM supplier_catalog WHERE company_id=$1 AND tax_code=$2`,
      [companyId, taxCode],
    );

    if (existing.rows.length > 0 && existing.rows[0]!.supplier_code) {
      await pool.query(
        `UPDATE supplier_catalog SET
           name=COALESCE($3,name),
           invoice_count_12m = invoice_count_12m + 1,
           last_invoice_date = GREATEST(last_invoice_date, $4::date),
           updated_at = NOW()
         WHERE company_id=$1 AND tax_code=$2`,
        [companyId, taxCode, name, invoiceDate ?? null],
      );
      return existing.rows[0]!.supplier_code;
    }

    const seq = await nextSeq(companyId, 'supplier', prefix);
    const code = `${prefix}-${padSeq(seq)}`;

    await pool.query(
      `INSERT INTO supplier_catalog (company_id, supplier_code, tax_code, name, invoice_count_12m, last_invoice_date)
       VALUES ($1,$2,$3,$4,1,$5)
       ON CONFLICT (company_id, tax_code) DO UPDATE SET
         supplier_code = COALESCE(supplier_catalog.supplier_code, EXCLUDED.supplier_code),
         name = EXCLUDED.name,
         invoice_count_12m = supplier_catalog.invoice_count_12m + 1,
         last_invoice_date = GREATEST(supplier_catalog.last_invoice_date, EXCLUDED.last_invoice_date),
         updated_at = NOW()`,
      [companyId, code, taxCode, name, invoiceDate ?? null],
    );
    return code;
  }

  /** Upsert product_catalog row with auto-detected category. Idempotent by item_name. */
  async ensureProduct(companyId: string, itemName: string): Promise<string> {
    const category = detectCategory(itemName);
    const prefix = `HH-${category.code}`;
    const normalizedName = itemName.trim().toLowerCase();

    const existing = await pool.query<{ item_code: string | null }>(
      `SELECT item_code FROM product_catalog WHERE company_id=$1 AND normalized_name=$2`,
      [companyId, normalizedName],
    );

    if (existing.rows.length > 0 && existing.rows[0]!.item_code) {
      return existing.rows[0]!.item_code;
    }

    const seq = await nextSeq(companyId, 'product', prefix);
    const code = `${prefix}-${padSeq(seq)}`;

    await pool.query(
      `INSERT INTO product_catalog (company_id, normalized_name, display_name, item_code, category_code, category_name, is_service)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, normalized_name) DO UPDATE SET
         item_code = COALESCE(product_catalog.item_code, EXCLUDED.item_code),
         category_code = EXCLUDED.category_code,
         category_name = EXCLUDED.category_name,
         is_service = EXCLUDED.is_service`,
      [companyId, normalizedName, itemName.trim(), code, category.code, category.name, category.isService],
    );
    return code;
  }

  /** Rebuild all catalogs for a company from existing invoice data. */
  async rebuildCatalogs(companyId: string): Promise<void> {
    // Customers (from output invoices — exclude deleted)
    const customers = await pool.query<{ tax_code: string; name: string; date: string }>(
      `SELECT DISTINCT ON (buyer_tax_code) buyer_tax_code AS tax_code, buyer_name AS name, invoice_date::text AS date
       FROM invoices WHERE company_id=$1 AND direction='output' AND buyer_tax_code IS NOT NULL
         AND deleted_at IS NULL
       ORDER BY buyer_tax_code, invoice_date DESC`,
      [companyId],
    );
    for (const r of customers.rows) {
      if (r.tax_code) await this.ensureCustomer(companyId, r.tax_code, r.name ?? '', r.date);
    }

    // Remove customer catalog entries that no longer have any valid invoices
    await pool.query(
      `DELETE FROM customer_catalog
       WHERE company_id = $1
         AND tax_code NOT IN (
           SELECT DISTINCT buyer_tax_code FROM invoices
           WHERE company_id = $1 AND direction = 'output'
             AND buyer_tax_code IS NOT NULL AND deleted_at IS NULL
         )`,
      [companyId],
    );

    // Suppliers (from input invoices — exclude deleted)
    const suppliers = await pool.query<{ tax_code: string; name: string; date: string }>(
      `SELECT DISTINCT ON (seller_tax_code) seller_tax_code AS tax_code, seller_name AS name, invoice_date::text AS date
       FROM invoices WHERE company_id=$1 AND direction='input' AND seller_tax_code IS NOT NULL
         AND deleted_at IS NULL
       ORDER BY seller_tax_code, invoice_date DESC`,
      [companyId],
    );
    for (const r of suppliers.rows) {
      if (r.tax_code) await this.ensureSupplier(companyId, r.tax_code, r.name ?? '', r.date);
    }

    // Remove supplier catalog entries that no longer have any valid invoices
    await pool.query(
      `DELETE FROM supplier_catalog
       WHERE company_id = $1
         AND tax_code NOT IN (
           SELECT DISTINCT seller_tax_code FROM invoices
           WHERE company_id = $1 AND direction = 'input'
             AND seller_tax_code IS NOT NULL AND deleted_at IS NULL
         )`,
      [companyId],
    );

    // Products (from line items — exclude deleted invoices)
    const items = await pool.query<{ item_name: string }>(
      `SELECT DISTINCT ili.item_name FROM invoice_line_items ili
       JOIN invoices i ON i.id = ili.invoice_id
       WHERE i.company_id=$1 AND i.deleted_at IS NULL
         AND ili.item_name IS NOT NULL AND TRIM(ili.item_name) != ''`,
      [companyId],
    );
    for (const r of items.rows) {
      if (r.item_name?.trim()) await this.ensureProduct(companyId, r.item_name);
    }
  }
}

export const autoCodeService = new AutoCodeService();
