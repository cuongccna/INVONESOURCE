import { pool } from '../db/pool';

/**
 * Cảnh báo khi có hóa đơn trong kỳ chưa được đồng bộ danh mục hàng hóa/dịch vụ
 * (invoice_line_items rỗng). Dùng chung cho: tính tờ khai, xuất XML, xuất Excel/PDF.
 */
export interface LineItemSyncWarning {
  code: 'MISSING_LINE_ITEMS';
  severity: 'warning';
  totalCount: number;   // tổng số hóa đơn chưa có line items trong kỳ
  inputCount: number;   // hóa đơn đầu vào
  outputCount: number;  // hóa đơn đầu ra
  message: string;
}

/**
 * Kiểm tra hóa đơn trong kỳ kê khai chưa đồng bộ danh mục hàng hóa/dịch vụ.
 *
 * Trả về null nếu tất cả hóa đơn đều đã có line items (hoặc không có hóa đơn nào).
 * Trả về LineItemSyncWarning nếu có hóa đơn thiếu line items — phụ lục NQ142
 * và bảng kê chi tiết có thể chưa đầy đủ.
 *
 * @param companyId  UUID công ty
 * @param periodMonth  tháng (1-12) hoặc quý (1-4) tùy quarterly
 * @param periodYear   năm
 * @param quarterly    true nếu kỳ quý, false nếu kỳ tháng
 */
export async function checkLineItemSync(
  companyId: string,
  periodMonth: number,
  periodYear: number,
  quarterly: boolean,
): Promise<LineItemSyncWarning | null> {
  let periodClause: string;
  let params: unknown[];

  if (quarterly) {
    const firstMonth = (periodMonth - 1) * 3 + 1;
    const lastMonth  = periodMonth * 3;
    periodClause = `EXTRACT(MONTH FROM i.invoice_date) BETWEEN $2 AND $3
                    AND EXTRACT(YEAR FROM i.invoice_date) = $4`;
    params = [companyId, firstMonth, lastMonth, periodYear];
  } else {
    periodClause = `EXTRACT(MONTH FROM i.invoice_date) = $2
                    AND EXTRACT(YEAR FROM i.invoice_date) = $3`;
    params = [companyId, periodMonth, periodYear];
  }

  const { rows } = await pool.query<{
    total_count: string;
    input_count: string;
    output_count: string;
  }>(
    `SELECT
       COUNT(*)                                                      AS total_count,
       COUNT(*) FILTER (WHERE i.direction = 'input')                AS input_count,
       COUNT(*) FILTER (WHERE i.direction = 'output')               AS output_count
     FROM invoices i
     WHERE i.company_id = $1
       AND i.status = 'valid'
       AND i.deleted_at IS NULL
       AND ${periodClause}
       AND NOT EXISTS (
         SELECT 1
         FROM invoice_line_items ili
         WHERE ili.invoice_id = i.id
           AND ili.deleted_at IS NULL
       )`,
    params,
  );

  const totalCount  = parseInt(rows[0]?.total_count  ?? '0', 10);
  if (totalCount === 0) return null;

  const inputCount  = parseInt(rows[0]?.input_count  ?? '0', 10);
  const outputCount = parseInt(rows[0]?.output_count ?? '0', 10);

  const parts: string[] = [];
  if (inputCount  > 0) parts.push(`${inputCount} hóa đơn đầu vào`);
  if (outputCount > 0) parts.push(`${outputCount} hóa đơn đầu ra`);

  return {
    code: 'MISSING_LINE_ITEMS',
    severity: 'warning',
    totalCount,
    inputCount,
    outputCount,
    message:
      `Có ${parts.join(' và ')} trong kỳ chưa đồng bộ danh mục hàng hóa/dịch vụ. ` +
      `Phụ lục NQ142 và bảng kê chi tiết có thể chưa đầy đủ. ` +
      `Vui lòng đồng bộ lại hóa đơn trước khi nộp tờ khai.`,
  };
}
