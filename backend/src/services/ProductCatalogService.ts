import { pool } from '../db/pool';

export interface ProductProfitability {
  product_code: string | null;
  product_name: string;
  unit: string | null;
  total_revenue: number;
  total_vat: number;
  quantity_sold: number;
  avg_unit_price: number;
  invoice_count: number;
  revenue_share_pct: number;
  cumulative_pct: number;
  abc_class: 'A' | 'B' | 'C';
}

export interface ProductProfitabilitySummary {
  items: ProductProfitability[];
  total_revenue: number;
  total_vat: number;
  total_items: number;
  period_month: number;
  period_year: number;
}

export class ProductCatalogService {
  async getProfitability(
    companyId: string,
    month: number,
    year: number,
  ): Promise<ProductProfitabilitySummary> {
    // Build Pareto (ABC) profitability from invoice_line_items for the period
    const { rows } = await pool.query<{
      product_code: string | null;
      product_name: string;
      unit: string | null;
      total_revenue: string;
      total_vat: string;
      quantity_sold: string;
      avg_unit_price: string;
      invoice_count: string;
      grand_total: string;
    }>(
      `WITH line_totals AS (
        SELECT
          ili.item_code   AS product_code,
          ili.item_name   AS product_name,
          ili.unit,
          SUM(ili.subtotal)        AS total_revenue,
          SUM(ili.vat_amount)      AS total_vat,
          SUM(ili.quantity)        AS quantity_sold,
          AVG(ili.unit_price)      AS avg_unit_price,
          COUNT(DISTINCT ili.invoice_id) AS invoice_count
        FROM invoice_line_items ili
        JOIN invoices inv ON inv.id = ili.invoice_id
        WHERE inv.company_id = $1
          AND EXTRACT(MONTH FROM inv.invoice_date) = $2
          AND EXTRACT(YEAR  FROM inv.invoice_date) = $3
          AND inv.direction = 'output'
          AND inv.status != 'cancelled'
        GROUP BY ili.item_code, ili.item_name, ili.unit
      ),
      totals AS (
        SELECT SUM(total_revenue) AS grand_total FROM line_totals
      )
      SELECT
        lt.*,
        t.grand_total
      FROM line_totals lt, totals t
      ORDER BY lt.total_revenue DESC`,
      [companyId, month, year],
    );

    const grandTotal = rows.length > 0 ? Number(rows[0].grand_total) : 0;
    let cumulative = 0;
    const items: ProductProfitability[] = rows.map((r) => {
      const rev = Number(r.total_revenue);
      const share = grandTotal > 0 ? (rev / grandTotal) * 100 : 0;
      cumulative += share;
      const abc_class: 'A' | 'B' | 'C' =
        cumulative <= 80 ? 'A' : cumulative <= 95 ? 'B' : 'C';
      return {
        product_code: r.product_code,
        product_name: r.product_name,
        unit: r.unit,
        total_revenue: rev,
        total_vat: Number(r.total_vat),
        quantity_sold: Number(r.quantity_sold),
        avg_unit_price: Number(r.avg_unit_price),
        invoice_count: Number(r.invoice_count),
        revenue_share_pct: Math.round(share * 10) / 10,
        cumulative_pct: Math.round(cumulative * 10) / 10,
        abc_class,
      };
    });

    const totalRev = items.reduce((s, i) => s + i.total_revenue, 0);
    const totalVat = items.reduce((s, i) => s + i.total_vat, 0);

    return {
      items,
      total_revenue: totalRev,
      total_vat: totalVat,
      total_items: items.length,
      period_month: month,
      period_year: year,
    };
  }
}

export const productCatalogService = new ProductCatalogService();
