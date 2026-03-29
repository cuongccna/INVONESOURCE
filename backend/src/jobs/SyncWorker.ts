import { Worker, Queue, Job } from 'bullmq';
import { registry } from '../connectors/ConnectorRegistry';
import { ConnectorPlugin, SyncParams } from '../connectors/types';
import { EncryptedCredentials } from '../connectors/types';
import { pool } from '../db/pool';
import { env } from '../config/env';
import { NormalizedInvoice } from 'shared';
import { v4 as uuidv4 } from 'uuid';
import { enqueueGdtValidation } from './GdtValidatorWorker';
import { priceAnomalyDetector } from '../services/PriceAnomalyDetector';

export interface SyncJobPayload {
  companyId: string;
  fromDate: string;   // ISO string
  toDate: string;     // ISO string
  triggeredBy?: 'cron' | 'manual';
}

const QUEUE_NAME = 'invoice-sync-queue';
const REDIS_CONNECTION = { url: env.REDIS_URL };

// Create the queue
export const syncQueue = new Queue<SyncJobPayload>(QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

/**
 * Sync a single plugin for a company.
 * All errors are caught here — never propagate to affect other plugins.
 */
async function syncPlugin(
  plugin: ConnectorPlugin,
  companyId: string,
  taxCode: string,
  credentials: EncryptedCredentials,
  fromDate: Date,
  toDate: Date,
  syncLogId: string
): Promise<{ recordsFetched: number; errors: string[] }> {
  const errors: string[] = [];
  let recordsFetched = 0;
  let recordsCreated = 0;
  let recordsUpdated = 0;

  try {
    // Check circuit breaker
    if (!registry.canCall(plugin.id)) {
      const msg = `Circuit OPEN for plugin ${plugin.id} — skipping`;
      console.warn(`[SyncWorker][${plugin.id}] ${msg}`);
      errors.push(msg);
      return { recordsFetched: 0, errors };
    }

    await plugin.authenticate(credentials);

    const params: SyncParams = { companyId, taxCode, fromDate, toDate };

    // Pull output invoices
    let outputInvoices: NormalizedInvoice[] = [];
    try {
      outputInvoices = await plugin.pullOutputInvoices(params);
    } catch (err) {
      errors.push(`pullOutputInvoices failed: ${(err as Error).message}`);
    }

    // Pull input invoices
    let inputInvoices: NormalizedInvoice[] = [];
    try {
      inputInvoices = await plugin.pullInputInvoices(params);
    } catch (err) {
      errors.push(`pullInputInvoices failed: ${(err as Error).message}`);
    }

    const all = [...outputInvoices, ...inputInvoices];
    recordsFetched = all.length;

    // Upsert invoices to DB
    if (all.length > 0) {
      const counts = await upsertInvoices(all, companyId, plugin.id);
      recordsCreated = counts.created;
      recordsUpdated = counts.updated;
      if (counts.skipped > 0) {
        errors.push(`${counts.skipped} invoice(s) skipped due to data errors`);
      }
    }

    registry.recordSuccess(plugin.id);

    // Update connector last_sync_at
    await pool.query(
      `UPDATE company_connectors SET last_sync_at = NOW(), consecutive_failures = 0, circuit_state = 'CLOSED'
       WHERE company_id = $1 AND provider = $2`,
      [companyId, plugin.id]
    );

  } catch (err) {
    const errorMsg = (err as Error).message;
    errors.push(errorMsg);
    console.error(`[SyncWorker][${plugin.id}] sync failed:`, errorMsg);

    const circuitOpened = registry.recordFailure(plugin.id);

    // Update circuit state in DB
    await pool.query(
      `UPDATE company_connectors 
       SET consecutive_failures = consecutive_failures + 1,
           circuit_state = CASE WHEN $3 = true THEN 'OPEN'::circuit_state ELSE circuit_state END,
           circuit_opened_at = CASE WHEN $3 = true THEN NOW() ELSE circuit_opened_at END,
           last_error = $4
       WHERE company_id = $1 AND provider = $2`,
      [companyId, plugin.id, circuitOpened, errorMsg]
    );

    if (circuitOpened) {
      // Trigger notification when circuit opens
      await createNotification(
        companyId,
        'CONNECTOR_ERROR',
        `Mất kết nối ${plugin.name}`,
        `🔴 Mất kết nối ${plugin.name} — cần xác thực lại`
      );
    }
  }

  // Update sync log
  await pool.query(
    `UPDATE sync_logs SET finished_at = NOW(), records_fetched = $1, records_created = $2,
       records_updated = $3, errors_count = $4, error_detail = $5
     WHERE id = $6`,
    [recordsFetched, recordsCreated, recordsUpdated, errors.length, errors.join('; ') || null, syncLogId]
  );

  return { recordsFetched, errors };
}

async function upsertInvoices(
  invoices: NormalizedInvoice[],
  companyId: string,
  provider: string
): Promise<{ created: number; updated: number; skipped: number }> {
  const client = await pool.connect();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  try {
    for (const inv of invoices) {
      try {
        // Clamp vatRate to valid NUMERIC(5,2) range — Vietnamese VAT is 0/5/8/10
        const safeVatRate = Math.min(Math.max(Number(inv.vatRate) || 0, -99), 99);
        const result = await client.query(
          `INSERT INTO invoices (
            id, company_id, provider, direction, invoice_number, serial_number, invoice_date,
            seller_tax_code, seller_name, buyer_tax_code, buyer_name,
            subtotal, vat_rate, vat_amount, total_amount, currency,
            status, gdt_validated, raw_xml, external_id, sync_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW()
          )
          ON CONFLICT (company_id, provider, invoice_number, seller_tax_code, invoice_date)
          DO UPDATE SET
            status = EXCLUDED.status,
            vat_amount = EXCLUDED.vat_amount,
            total_amount = EXCLUDED.total_amount,
            raw_xml = COALESCE(EXCLUDED.raw_xml, invoices.raw_xml),
            sync_at = NOW(),
            updated_at = NOW()
          RETURNING id, direction, invoice_number, serial_number, seller_tax_code, invoice_date,
                    (xmax = 0) AS is_new`,
          [
            uuidv4(), companyId, provider, inv.direction, inv.invoiceNumber,
            inv.serialNumber, inv.issuedDate, inv.sellerTaxCode, inv.sellerName,
            inv.buyerTaxCode, inv.buyerName, inv.subtotal, safeVatRate,
            inv.vatAmount, inv.total, inv.currency, inv.status,
            provider === 'bkav' ? true : false,
            inv.rawXml ?? null, inv.externalId
          ]
        );
        const row = result.rows[0];
        if (row?.is_new) created++; else updated++;

        // Enqueue input invoices (non-BKAV) for GDT validation
        if (row && inv.direction === 'input' && provider !== 'bkav') {
          const issuedDateStr = inv.issuedDate instanceof Date
            ? inv.issuedDate.toISOString().split('T')[0]!
            : String(inv.issuedDate);
          await enqueueGdtValidation({
            invoiceId: row.id as string,
            invoiceNumber: inv.invoiceNumber,
            serialNumber: inv.serialNumber,
            sellerTaxCode: inv.sellerTaxCode,
            issuedDate: issuedDateStr,
            companyId,
          });
        }
      } catch (invErr) {
        // Skip this invoice but continue processing the rest
        skipped++;
        console.warn(`[SyncWorker][${provider}] Skipped invoice ${inv.invoiceNumber ?? inv.externalId}: ${(invErr as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
  return { created, updated, skipped };
}

async function createNotification(
  companyId: string,
  type: string,
  title: string,
  body: string
): Promise<void> {
  try {
    // Get all users for this company
    const { rows } = await pool.query(
      'SELECT user_id FROM user_companies WHERE company_id = $1',
      [companyId]
    );
    for (const row of rows) {
      await pool.query(
        `INSERT INTO notifications (id, company_id, user_id, type, title, body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv4(), companyId, row.user_id, type, title, body]
      );
    }
  } catch (err) {
    console.error('[SyncWorker] Failed to create notification:', err);
  }
}

// ============================================================
// BullMQ Worker
// ============================================================

export const syncWorker = new Worker<SyncJobPayload>(
  QUEUE_NAME,
  async (job: Job<SyncJobPayload>) => {
    const { companyId, fromDate, toDate } = job.data;
    const from = new Date(fromDate);
    const to = new Date(toDate);

    console.log(`[SyncWorker] Starting sync for company ${companyId} ${fromDate} → ${toDate}`);

    // Load company info
    const { rows: companRows } = await pool.query(
      'SELECT tax_code FROM companies WHERE id = $1',
      [companyId]
    );
    if (!companRows.length) {
      throw new Error(`Company not found: ${companyId}`);
    }
    const taxCode: string = companRows[0].tax_code;

    let totalFetched = 0;

    // ── Normal mode: load connectors from company_connectors table ──
    const { rows: connectors } = await pool.query(
      `SELECT provider, credentials_encrypted FROM company_connectors
       WHERE company_id = $1 AND enabled = true`,
      [companyId]
    );

    for (const connector of connectors) {
      const plugin = registry.get(connector.provider);
      if (!plugin || !plugin.isEnabled()) {
        console.warn(`[SyncWorker] Plugin not found or disabled: ${connector.provider}`);
        continue;
      }

      // Create sync log entry
      const syncLogId = uuidv4();
      await pool.query(
        `INSERT INTO sync_logs (id, company_id, provider, started_at) VALUES ($1, $2, $3, NOW())`,
        [syncLogId, companyId, connector.provider]
      );

      // Each plugin is fully isolated — errors never propagate
      try {
        const result = await syncPlugin(
          plugin,
          companyId,
          taxCode,
          { encrypted: connector.credentials_encrypted },
          from,
          to,
          syncLogId
        );
        totalFetched += result.recordsFetched;
      } catch (err) {
        console.error(`[SyncWorker][${connector.provider}] Unexpected error:`, err);
        await pool.query(
          `UPDATE sync_logs SET finished_at = NOW(), error_detail = $1 WHERE id = $2`,
          [(err as Error).message, syncLogId]
        );
        // Continue to next plugin — never rethrow
      }
    }

    // Send summary notification if invoices were fetched
    if (totalFetched > 0) {
      await createNotification(
        companyId,
        'SYNC_COMPLETE',
        'Đồng bộ hoàn tất',
        `Đồng bộ xong ${totalFetched} hóa đơn`
      );

      // Auto-run price anomaly detection after each sync — isolated, never throws
      try {
        const anomalies = await priceAnomalyDetector.detectAnomalies(companyId);
        if (anomalies.length > 0) {
          console.log(`[SyncWorker] Anomaly auto-detect: ${anomalies.length} anomalies found for company ${companyId}`);
        }
      } catch (err) {
        console.warn(`[SyncWorker] Anomaly auto-detect failed (non-critical):`, (err as Error).message);
      }
    }

    console.log(`[SyncWorker] Completed sync for company ${companyId}: ${totalFetched} records`);
    return { totalFetched };
  },
  {
    connection: { url: env.REDIS_URL },
    concurrency: 3,
  }
);

syncWorker.on('failed', (job, err) => {
  console.error(`[SyncWorker] Job ${job?.id} failed:`, err.message);
});

// ============================================================
// Schedule cron: every 15 minutes
// ============================================================

export async function scheduleSyncCron(): Promise<void> {
  // Remove existing repeatable jobs first
  const repeatableJobs = await syncQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await syncQueue.removeRepeatableByKey(job.key);
  }

  // Load all companies and schedule sync
  const { rows: companies } = await pool.query(
    'SELECT id FROM companies'
  );

  for (const company of companies) {
    const now = new Date();
    const fromDate = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const toDate = now.toISOString();

    await syncQueue.add(
      `cron-sync-${company.id}`,
      { companyId: company.id, fromDate, toDate, triggeredBy: 'cron' },
      {
        repeat: { every: 15 * 60 * 1000 },  // every 15 minutes
        jobId: `cron-sync-${company.id}`,
      }
    );
  }

  console.log(`[SyncWorker] Cron scheduled for ${companies.length} companies`);
}
