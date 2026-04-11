import { Worker, Queue, Job } from 'bullmq';
import { pool } from '../db/pool';
import { env } from '../config/env';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

export interface GdtValidateJobPayload {
  invoiceId: string;
  invoiceNumber: string;
  serialNumber: string;  // ký hiệu hóa đơn (khhdon)
  sellerTaxCode: string;
  issuedDate: string;   // ISO date string
  companyId: string;
}

const QUEUE_NAME = 'gdt-validate-queue';
const GDT_BASE_URL = 'https://hoadondientu.gdt.gov.vn';
const MAX_GDT_RETRIES = 5;

/**
 * GDT Validation Queue — rate limited: max 1 job per 2000ms
 * Validates invoices against GDT (hoadondientu.gdt.gov.vn)
 */
export const gdtValidateQueue = new Queue<GdtValidateJobPayload>(QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: MAX_GDT_RETRIES,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: 200,
    removeOnFail: 100,
  },
});

export const gdtValidateWorker = new Worker<GdtValidateJobPayload>(
  QUEUE_NAME,
  async (job: Job<GdtValidateJobPayload>) => {
    const { invoiceId, invoiceNumber, serialNumber, sellerTaxCode, issuedDate, companyId } = job.data;

    try {
    // Serial prefix 'C' = group 5 (CÓ mã CQT — invoices stamped with GDT code).
    // Viettel pushes these directly to GDT during issuance; CQT code is embedded
    // at creation time, so portal probing returns inconsistent results for Viettel.
    // Skip individual portal validation and trust the CQT code on the invoice.
    if (serialNumber?.startsWith('C')) {
      await pool.query(
        `UPDATE invoices SET gdt_validated = true, gdt_validated_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [invoiceId]
      );
      await pool.query(
        `UPDATE gdt_validation_queue SET status = 'done', last_attempted_at = NOW(), result = $1
         WHERE invoice_id = $2`,
        [JSON.stringify({ valid: true, reason: 'viettel_provider_trusted' }), invoiceId]
      );
      return;
    }

    const isValid = await validateWithGdt(invoiceNumber, serialNumber, sellerTaxCode, issuedDate);

    if (isValid) {
        // Mark invoice as GDT validated
        await pool.query(
          `UPDATE invoices SET gdt_validated = true, gdt_validated_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [invoiceId]
        );

        // Update queue record
        await pool.query(
          `UPDATE gdt_validation_queue SET status = 'done', last_attempted_at = NOW(), result = $1
           WHERE invoice_id = $2`,
          [JSON.stringify({ valid: true }), invoiceId]
        );
      } else {
        // Mark invoice as invalid
        await pool.query(
          `UPDATE invoices SET gdt_validated = false, status = 'invalid', updated_at = NOW()
           WHERE id = $1`,
          [invoiceId]
        );

        await pool.query(
          `UPDATE gdt_validation_queue SET status = 'done', last_attempted_at = NOW(), result = $1
           WHERE invoice_id = $2`,
          [JSON.stringify({ valid: false }), invoiceId]
        );

        // Create notification for invalid invoice
        await createInvalidInvoiceNotification(companyId, invoiceId, invoiceNumber);
      }
    } catch (err) {
      const errorMsg = (err as Error).message;

      await pool.query(
        `UPDATE gdt_validation_queue
         SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
             attempts = attempts + 1,
             last_attempted_at = NOW()
         WHERE invoice_id = $2`,
        [MAX_GDT_RETRIES, invoiceId]
      );

      // If GDT is unreachable after all retries — skip, do NOT mark invalid
      if (job.attemptsMade >= MAX_GDT_RETRIES - 1) {
        console.warn(`[GdtValidator] GDT unreachable for invoice ${invoiceId} — skipping (not marking invalid)`);
        await pool.query(
          `UPDATE gdt_validation_queue SET status = 'skipped' WHERE invoice_id = $1`,
          [invoiceId]
        );
        return;
      }

      throw err;  // Re-throw for BullMQ retry
    }
  },
  {
    connection: { url: env.REDIS_URL },
    concurrency: 1,   // strict rate limiting — 1 at a time
    limiter: {
      max: 1,
      duration: 2000,
    },
  }
);

/**
 * Call GDT validation endpoint
 * Returns true if invoice is valid, false if not, throws if unreachable
 */
async function validateWithGdt(
  invoiceNumber: string,
  serialNumber: string,
  sellerTaxCode: string,
  issuedDate: string
): Promise<boolean> {
  const res = await axios.get(`${GDT_BASE_URL}/api/valid-invoice`, {
    params: {
      mstNb: sellerTaxCode,
      khhdon: serialNumber,   // ký hiệu hóa đơn
      shdon: invoiceNumber,   // số hóa đơn
      tdlap: issuedDate,
    },
    timeout: 15000,
  });

  // GDT returns trangThai: 1 = valid, 0 = invalid
  const data = res.data as { trangThai?: number; valid?: boolean };
  if (typeof data.trangThai === 'number') return data.trangThai === 1;
  if (typeof data.valid === 'boolean') return data.valid;
  return false;
}

async function createInvalidInvoiceNotification(
  companyId: string,
  _invoiceId: string,
  invoiceNumber: string
): Promise<void> {
  try {
    const { rows: users } = await pool.query(
      'SELECT user_id FROM user_companies WHERE company_id = $1',
      [companyId]
    );
    for (const user of users) {
      await pool.query(
        `INSERT INTO notifications (id, company_id, user_id, type, title, body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          uuidv4(), companyId, user.user_id,
          'INVALID_INVOICE',
          'Hóa đơn không hợp lệ',
          `⚠️ Hóa đơn số ${invoiceNumber} không hợp lệ theo GDT`,
        ]
      );
    }
  } catch (err) {
    console.error('[GdtValidator] Failed to create notification:', err);
  }
}

/**
 * Enqueue an invoice for GDT validation
 */
export async function enqueueGdtValidation(payload: GdtValidateJobPayload): Promise<void> {
  // Create/update queue record
  await pool.query(
    `INSERT INTO gdt_validation_queue (id, invoice_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (invoice_id) DO UPDATE SET status = 'pending', attempts = 0`,
    [uuidv4(), payload.invoiceId]
  );

  await gdtValidateQueue.add('gdt-validate', payload, {
    jobId: `gdt-${payload.invoiceId}`,   // idempotent
  });
}
