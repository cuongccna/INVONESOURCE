/**
 * Group 37 — INV-01: Inventory movement engine
 * Derives Xuat Nhap Ton from invoice line items without requiring a separate warehouse.
 */
import { pool } from '../db/pool';

export interface InventoryBalanceRow {
  item_code: string | null;
  normalized_item_name: string;
  item_name: string;
  unit: string | null;
  opening_qty: number;
  opening_value: number;
  in_qty: number;
  in_value: number;
  out_qty: number;
  out_value: number;
  closing_qty: number;
  closing_value: number;
  avg_cost_price: number | null;
}

export class InventoryService {
  /**
   * Build inventory_movements from invoice_line_items for a period.
   * Idempotent: uses ON CONFLICT by (company_id, line_item_id) if line_item linked,
   * otherwise deduplicates by (company_id, invoice_id, normalized_item_name).
   */
  async buildMovements(companyId: string, month: number, year: number): Promise<number> {
    // Fetch line items for this period
    const { rows } = await pool.query<{
      id: string; invoice_id: string; invoice_date: string; direction: string;
      seller_name: string; seller_tax_code: string; buyer_name: string; buyer_tax_code: string;
      item_name: string; unit: string; quantity: string; unit_price: string; total: string;
    }>(
      `SELECT ili.id, ili.invoice_id, i.invoice_date::text, i.direction,
              i.seller_name, i.seller_tax_code, i.buyer_name, i.buyer_tax_code,
              ili.item_name, ili.unit, ili.quantity, ili.unit_price, ili.total
       FROM invoice_line_items ili
       JOIN invoices i ON i.id = ili.invoice_id
       WHERE i.company_id = $1
         AND EXTRACT(YEAR FROM i.invoice_date) = $2
         AND EXTRACT(MONTH FROM i.invoice_date) = $3
         AND i.status != 'cancelled'
         AND ili.item_name IS NOT NULL
         AND TRIM(ili.item_name) != ''`,
      [companyId, year, month],
    );

    let upserted = 0;
    for (const r of rows) {
      const movType = r.direction === 'input' ? 'IN' : 'OUT';
      const qty = Math.abs(Number(r.quantity ?? 0));
      const unitCost = r.direction === 'input' ? Number(r.unit_price ?? 0) : null;
      const unitPrice = r.direction === 'output' ? Number(r.unit_price ?? 0) : null;
      const totalVal = Math.abs(Number(r.total ?? 0));
      const normalizedName = (r.item_name ?? '').trim().toLowerCase();
      const partner = r.direction === 'input' ? r.seller_name : r.buyer_name;
      const partnerTax = r.direction === 'input' ? r.seller_tax_code : r.buyer_tax_code;

      // Get item code from product_catalog
      const pc = await pool.query<{ item_code: string }>(
        `SELECT item_code FROM product_catalog WHERE company_id=$1 AND LOWER(TRIM(item_name))=$2 LIMIT 1`,
        [companyId, normalizedName],
      );
      const itemCode = pc.rows[0]?.item_code ?? null;

      await pool.query(
        `INSERT INTO inventory_movements
         (company_id, invoice_id, line_item_id, movement_type, item_code, item_name, normalized_item_name,
          unit, quantity, unit_cost, unit_price, total_value, movement_date, partner_name, partner_tax_code, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15,'invoice')
         ON CONFLICT DO NOTHING`,
        [companyId, r.invoice_id, r.id, movType, itemCode, r.item_name?.trim(), normalizedName,
         r.unit, qty, unitCost, unitPrice, totalVal, r.invoice_date, partner, partnerTax],
      );
      upserted++;
    }
    return upserted;
  }

  /** Get balance report for a given period (opening = before period, closing = through period). */
  async getBalanceReport(companyId: string, month: number, year: number): Promise<InventoryBalanceRow[]> {
    const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const periodEnd = new Date(year, month, 0).toISOString().split('T')[0]; // last day of month

    const { rows } = await pool.query<{
      item_code: string; normalized_item_name: string; item_name: string; unit: string;
      open_in: string; open_out: string; open_in_val: string; open_out_val: string;
      period_in: string; period_out: string; period_in_val: string; period_out_val: string;
    }>(
      `SELECT
         MAX(item_code) AS item_code,
         normalized_item_name,
         MAX(item_name) AS item_name,
         MAX(unit) AS unit,
         SUM(CASE WHEN movement_type='IN'  AND movement_date < $2 THEN quantity ELSE 0 END) AS open_in,
         SUM(CASE WHEN movement_type='OUT' AND movement_date < $2 THEN quantity ELSE 0 END) AS open_out,
         SUM(CASE WHEN movement_type='IN'  AND movement_date < $2 THEN total_value ELSE 0 END) AS open_in_val,
         SUM(CASE WHEN movement_type='OUT' AND movement_date < $2 THEN total_value ELSE 0 END) AS open_out_val,
         SUM(CASE WHEN movement_type='IN'  AND movement_date BETWEEN $2 AND $3 THEN quantity ELSE 0 END) AS period_in,
         SUM(CASE WHEN movement_type='OUT' AND movement_date BETWEEN $2 AND $3 THEN quantity ELSE 0 END) AS period_out,
         SUM(CASE WHEN movement_type='IN'  AND movement_date BETWEEN $2 AND $3 THEN total_value ELSE 0 END) AS period_in_val,
         SUM(CASE WHEN movement_type='OUT' AND movement_date BETWEEN $2 AND $3 THEN total_value ELSE 0 END) AS period_out_val
       FROM inventory_movements
       WHERE company_id = $1 AND movement_type IN ('IN','OUT','opening_balance')
       GROUP BY normalized_item_name
       ORDER BY MAX(item_name)`,
      [companyId, periodStart, periodEnd],
    );

    return rows.map((r) => {
      const openQty = Number(r.open_in) - Number(r.open_out);
      const openValue = Number(r.open_in_val) - Number(r.open_out_val);
      const periodIn = Number(r.period_in);
      const periodOut = Number(r.period_out);
      const periodInVal = Number(r.period_in_val);
      const periodOutVal = Number(r.period_out_val);
      const closingQty = openQty + periodIn - periodOut;
      // Weighted average cost
      const totalCostUnits = (openQty > 0 ? openQty : 0) + periodIn;
      const totalCostValue = (openValue > 0 ? openValue : 0) + periodInVal;
      const avgCost = totalCostUnits > 0 ? totalCostValue / totalCostUnits : 0;
      const closingValue = closingQty * avgCost;

      return {
        item_code: r.item_code ?? null,
        normalized_item_name: r.normalized_item_name,
        item_name: r.item_name,
        unit: r.unit ?? null,
        opening_qty: openQty,
        opening_value: openValue,
        in_qty: periodIn,
        in_value: periodInVal,
        out_qty: periodOut,
        out_value: periodOutVal,
        closing_qty: closingQty,
        closing_value: Math.round(closingValue * 100) / 100,
        avg_cost_price: Math.round(avgCost * 100) / 100 || null,
      };
    });
  }

  /** List all movements for one item in a date range. */
  async getMovementDetail(companyId: string, normalizedItemName: string, from: string, to: string) {
    const { rows } = await pool.query(
      `SELECT m.*, i.invoice_number, i.direction
       FROM inventory_movements m
       LEFT JOIN invoices i ON i.id = m.invoice_id
       WHERE m.company_id=$1 AND m.normalized_item_name=$2
         AND m.movement_date BETWEEN $3 AND $4
       ORDER BY m.movement_date, m.created_at`,
      [companyId, normalizedItemName, from, to],
    );
    return rows;
  }

  /** Insert opening balance manually. */
  async upsertOpeningBalance(
    companyId: string,
    itemName: string,
    unit: string,
    quantity: number,
    unitCost: number,
    asOfDate: string,
    createdBy: string,
  ): Promise<void> {
    const normalizedName = itemName.trim().toLowerCase();
    const totalValue = quantity * unitCost;
    // Remove existing opening for same item
    await pool.query(
      `DELETE FROM inventory_movements
       WHERE company_id=$1 AND normalized_item_name=$2 AND source='opening_balance'`,
      [companyId, normalizedName],
    );
    await pool.query(
      `INSERT INTO inventory_movements
       (company_id, movement_type, item_name, normalized_item_name, unit, quantity, unit_cost, total_value, movement_date, source, created_by)
       VALUES ($1,'opening_balance',$2,$3,$4,$5,$6,$7,$8::date,'opening_balance',$9)`,
      [companyId, itemName.trim(), normalizedName, unit, quantity, unitCost, totalValue, asOfDate, createdBy],
    );
  }
}

export const inventoryService = new InventoryService();
