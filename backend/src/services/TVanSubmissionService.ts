/**
 * TVanSubmissionService — submits HTKK XML declarations to GDT via T-VAN intermediary.
 *
 * T-VAN (Trung gian T-VAN) is the authorized network for electronic tax submission.
 * Base URL and T-VAN partner credentials are injected via environment variables.
 *
 * Submission flow:
 *   1. POST XML to T-VAN endpoint → receive submissionId
 *   2. Poll GET /status/{submissionId} until GDT acknowledges (accepted/rejected)
 *   3. Store result in tax_declarations.submission_status + submission_ref
 */

import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';

export type TVanSubmitResult = {
  submissionId: string;
  status: 'pending' | 'accepted' | 'rejected';
  message?: string;
  receivedAt: string;
};

export class TVanSubmissionService {
  private readonly client: AxiosInstance;
  private readonly partnerId: string;
  private readonly partnerToken: string;

  constructor() {
    const baseURL = process.env.TVAN_BASE_URL ?? '';
    this.partnerId = process.env.TVAN_PARTNER_ID ?? '';
    this.partnerToken = process.env.TVAN_PARTNER_TOKEN ?? '';

    if (!baseURL) {
      throw new Error('TVAN_BASE_URL is not configured. Set it in your .env file.');
    }

    this.client = axios.create({
      baseURL,
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'X-Partner-Id': this.partnerId,
        'X-Partner-Token': this.partnerToken,
      },
    });
  }

  /**
   * Submit an HTKK XML declaration to T-VAN.
   * @param declarationId UUID of the tax_declarations row
   * @param xmlContent    Full HTKK-standard XML string
   */
  async submit(declarationId: string, xmlContent: string): Promise<TVanSubmitResult> {
    const transactionId = uuidv4();

    const response = await this.client.post<{
      submissionId: string;
      status: string;
      message?: string;
      receivedAt: string;
    }>('/api/declarations/submit', xmlContent, {
      headers: { 'X-Transaction-Id': transactionId },
    });

    const result: TVanSubmitResult = {
      submissionId: response.data.submissionId,
      status: this.mapStatus(response.data.status),
      message: response.data.message,
      receivedAt: response.data.receivedAt,
    };

    // Persist submission reference immediately
    await pool.query(
      `UPDATE tax_declarations
       SET submission_status = $1,
           submission_ref    = $2,
           submission_at     = NOW(),
           updated_at        = NOW()
       WHERE id = $3`,
      [result.status === 'rejected' ? 'rejected' : 'submitted', result.submissionId, declarationId]
    );

    return result;
  }

  /**
   * Poll T-VAN for status of a previously submitted declaration.
   * Call this endpoint after an initial `submit()` returns status='pending'.
   */
  async pollStatus(submissionId: string): Promise<TVanSubmitResult> {
    const response = await this.client.get<{
      submissionId: string;
      status: string;
      message?: string;
      receivedAt: string;
    }>(`/api/declarations/status/${submissionId}`);

    return {
      submissionId: response.data.submissionId,
      status: this.mapStatus(response.data.status),
      message: response.data.message,
      receivedAt: response.data.receivedAt,
    };
  }

  private mapStatus(raw: string): TVanSubmitResult['status'] {
    const s = (raw ?? '').toUpperCase();
    if (s === 'ACCEPTED' || s === '01') return 'accepted';
    if (s === 'REJECTED' || s === '03') return 'rejected';
    return 'pending';
  }
}
