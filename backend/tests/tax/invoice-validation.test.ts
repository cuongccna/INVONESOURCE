/**
 * Tests for Invoice Validation Pipeline + TaxDeclarationEngine
 *
 * Strategy:
 *  - Mock pool.query for pipeline / engine tests (no real DB needed)
 *  - Test individual plugins via validateBatch() directly
 *  - Test the full pipeline.validate() with mocked DB configs
 *  - Test VatReconciliationService.calculateQuarter() with mocked DB
 *  - Test direction-split ID filter correctness (regression for the 0đ ct40a bug)
 */
import { CancelledFilterPlugin }     from '../../src/tax/validation/plugins/cancelled-filter.plugin';
import { CqtSignatureFilterPlugin }  from '../../src/tax/validation/plugins/cqt-signature-filter.plugin';
import { CashPaymentFilterPlugin }   from '../../src/tax/validation/plugins/cash-payment-filter.plugin';
import { ReplacedFilterPlugin }      from '../../src/tax/validation/plugins/replaced-filter.plugin';
import { VendorRiskFilterPlugin }    from '../../src/tax/validation/plugins/vendor-risk-filter.plugin';
import { ExclusionReasonCode }       from '../../src/tax/validation/types';
import type { InvoiceRow, InvoiceValidationContext } from '../../src/tax/validation/types';

// ── Mock pg pool ──────────────────────────────────────────────────────────────
const mockQuery = jest.fn();
jest.mock('../../src/db/pool', () => ({
  pool: { query: mockQuery },
}));

// ── Mock uuid so pipeline_run_id is deterministic ────────────────────────────
jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeInvoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id:              'inv-0001',
    company_id:      'company-0001',
    direction:       'input',
    status:          'valid',
    invoice_number:  '0001',
    serial_number:   'A1A001',
    invoice_date:    new Date('2026-01-15'),
    seller_tax_code: '0100109106',
    seller_name:     'Công ty bán hàng',
    buyer_tax_code:  '0200234567',
    total_amount:    1000000,
    vat_amount:      100000,
    payment_method:  'bank',
    gdt_validated:   true,
    invoice_group:   5,
    serial_has_cqt:  false,
    has_line_items:  false,
    mccqt:           null,
    tc_hdon:         0,
    lhd_cl_quan:     null,
    khhd_cl_quan:    null,
    so_hd_cl_quan:   null,
    ...overrides,
  };
}

const CTX: InvoiceValidationContext = {
  mst: '0200234567',
  declaration_period: '2026-Q1',
  declaration_type: 'quarterly',
  direction: 'both',
};

const mockDb: any = { query: mockQuery };

// ─── CancelledFilterPlugin ────────────────────────────────────────────────────
describe('CancelledFilterPlugin', () => {
  const plugin = new CancelledFilterPlugin();

  it('excludes cancelled invoices', async () => {
    const invoices = [
      makeInvoice({ id: 'inv-c1', status: 'cancelled' }),
      makeInvoice({ id: 'inv-v1', status: 'valid' }),
    ];
    const results = await plugin.validateBatch(invoices, CTX, mockDb);
    expect(results.size).toBe(1);
    expect(results.get('inv-c1')?.status).toBe('excluded');
    expect(results.get('inv-c1')?.reason_codes).toContain(ExclusionReasonCode.CANCELLED_BY_GDT);
    expect(results.has('inv-v1')).toBe(false);
  });

  it('passes all valid invoices silently', async () => {
    const invoices = [makeInvoice({ id: 'inv-v1' }), makeInvoice({ id: 'inv-v2' })];
    const results = await plugin.validateBatch(invoices, CTX, mockDb);
    expect(results.size).toBe(0);
  });
});

// ─── CqtSignatureFilterPlugin ─────────────────────────────────────────────────
describe('CqtSignatureFilterPlugin', () => {
  const plugin = new CqtSignatureFilterPlugin();

  it('skips invoices without CQT code (serial_has_cqt=false)', async () => {
    const invoices = [makeInvoice({ serial_has_cqt: false, gdt_validated: false, mccqt: null })];
    const results = await plugin.validateBatch(invoices, CTX, mockDb);
    expect(results.size).toBe(0);   // khong_ma → not applicable
  });

  it('skips CQT invoices already gdt_validated (mccqt not yet populated)', async () => {
    const invoices = [makeInvoice({ serial_has_cqt: true, gdt_validated: true, mccqt: null })];
    const results = await plugin.validateBatch(invoices, CTX, mockDb);
    expect(results.size).toBe(0);   // GDT already verified
  });

  it('excludes CQT invoice without mccqt and not gdt_validated', async () => {
    const invoices = [makeInvoice({ serial_has_cqt: true, gdt_validated: false, mccqt: null })];
    const results = await plugin.validateBatch(invoices, CTX, mockDb);
    expect(results.size).toBe(1);
    expect(results.get('inv-0001')?.status).toBe('excluded');
    expect(results.get('inv-0001')?.reason_codes).toContain(ExclusionReasonCode.INVALID_CQT_SIGNATURE);
  });

  it('passes CQT invoice with valid mccqt and not gdt_validated', async () => {
    const invoices = [makeInvoice({ serial_has_cqt: true, gdt_validated: false, mccqt: 'ABcDE12345' })];
    const results = await plugin.validateBatch(invoices, CTX, mockDb);
    expect(results.size).toBe(0);  // mccqt present → pass
  });
});

// ─── CashPaymentFilterPlugin ──────────────────────────────────────────────────
describe('CashPaymentFilterPlugin', () => {
  const plugin = new CashPaymentFilterPlugin();
  const cfg = { name: 'cash_payment_filter', enabled: true, config: { threshold: 5000000, effective_date: '2025-07-01' } };

  it('ignores output invoices (appliesTo=input)', () => {
    expect(plugin.appliesTo).toBe('input');
  });

  it('skips invoices before effective date (2025-07-01)', async () => {
    const invoices = [makeInvoice({ invoice_date: new Date('2025-06-30'), total_amount: 6000000 })];
    const results = await plugin.validateBatch(invoices, CTX, mockDb, cfg);
    expect(results.size).toBe(0);
  });

  it('skips invoices below threshold', async () => {
    const invoices = [makeInvoice({ invoice_date: new Date('2026-01-15'), total_amount: 4000000 })];
    const results = await plugin.validateBatch(invoices, CTX, mockDb, cfg);
    expect(results.size).toBe(0);
  });

  it('warns on >= 5M with no payment flag (undefined)', async () => {
    const invoices = [makeInvoice({ id: 'inv-unk', invoice_date: new Date('2026-01-15'), total_amount: 6000000 })];
    const results = await plugin.validateBatch(invoices, { ...CTX, user_payment_flags: {} }, mockDb, cfg);
    expect(results.get('inv-unk')?.status).toBe('warning');
  });

  it('excludes confirmed cash payment >= 5M', async () => {
    const inv = makeInvoice({ id: 'inv-cash', invoice_date: new Date('2026-01-15'), total_amount: 6000000 });
    const results = await plugin.validateBatch(
      [inv],
      { ...CTX, user_payment_flags: { 'inv-cash': true } },
      mockDb, cfg
    );
    expect(results.get('inv-cash')?.status).toBe('excluded');
    expect(results.get('inv-cash')?.reason_codes).toContain(ExclusionReasonCode.CASH_PAYMENT_OVER_5M);
  });

  it('passes confirmed non-cash payment >= 5M (flagValue=false)', async () => {
    const inv = makeInvoice({ id: 'inv-noncash', invoice_date: new Date('2026-01-15'), total_amount: 6000000 });
    const results = await plugin.validateBatch(
      [inv],
      { ...CTX, user_payment_flags: { 'inv-noncash': false } },
      mockDb, cfg
    );
    expect(results.has('inv-noncash')).toBe(false);
  });
});

// ─── ReplacedFilterPlugin ─────────────────────────────────────────────────────
describe('ReplacedFilterPlugin', () => {
  const plugin = new ReplacedFilterPlugin();

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('passes invoice when no replacement exists in DB', async () => {
    const invoices = [makeInvoice({ id: 'inv-ok' })];
    // DB returns no replacement invoices
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const results = await plugin.validateBatch(invoices, CTX, mockDb);
    expect(results.size).toBe(0);
  });

  it('excludes invoice when replacement exists in DB', async () => {
    const inv = makeInvoice({
      id: 'inv-old',
      invoice_number: '0001',
      serial_number: 'A1A001',
      seller_tax_code: '0100109106',
    });
    // DB returns a replacement that references this invoice
    mockQuery.mockResolvedValueOnce({
      rows: [{
        khhd_cl_quan: 'A1A001',
        so_hd_cl_quan: '0001',
        seller_tax_code: '0100109106',
        invoice_number: '0101',
      }],
    });
    const results = await plugin.validateBatch([inv], CTX, mockDb);
    expect(results.get('inv-old')?.status).toBe('excluded');
    expect(results.get('inv-old')?.reason_codes).toContain(ExclusionReasonCode.REPLACED_BY_NEWER);
  });
});

// ─── VendorRiskFilterPlugin ───────────────────────────────────────────────────
describe('VendorRiskFilterPlugin', () => {
  const plugin = new VendorRiskFilterPlugin();

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('excludes invoices with enforcement_status=active', async () => {
    const inv = makeInvoice({ id: 'inv-enf', seller_tax_code: '0100109106' });
    mockQuery.mockResolvedValueOnce({
      rows: [{ seller_tax_code: '0100109106', enforcement_status: 'active', risk_score: 90 }],
    });
    const cfg = { name: 'vendor_risk_filter', enabled: true, config: { warn_threshold: 70 } };
    const results = await plugin.validateBatch([inv], { ...CTX, direction: 'input' }, mockDb, cfg);
    expect(results.get('inv-enf')?.status).toBe('excluded');
    expect(results.get('inv-enf')?.reason_codes).toContain(ExclusionReasonCode.VENDOR_ENFORCEMENT);
  });

  it('warns on high risk_score >= threshold', async () => {
    const inv = makeInvoice({ id: 'inv-risk', seller_tax_code: '0100109107' });
    mockQuery.mockResolvedValueOnce({
      rows: [{ seller_tax_code: '0100109107', enforcement_status: 'none', risk_score: 75 }],
    });
    const cfg = { name: 'vendor_risk_filter', enabled: true, config: { warn_threshold: 70 } };
    const results = await plugin.validateBatch([inv], { ...CTX, direction: 'input' }, mockDb, cfg);
    expect(results.get('inv-risk')?.status).toBe('warning');
    expect(results.get('inv-risk')?.reason_codes).toContain(ExclusionReasonCode.VENDOR_RISK_FLAGGED);
  });

  it('passes clean vendors', async () => {
    const inv = makeInvoice({ id: 'inv-clean', seller_tax_code: '0100109108' });
    mockQuery.mockResolvedValueOnce({
      rows: [{ seller_tax_code: '0100109108', enforcement_status: 'none', risk_score: 30 }],
    });
    const cfg = { name: 'vendor_risk_filter', enabled: true, config: { warn_threshold: 70 } };
    const results = await plugin.validateBatch([inv], { ...CTX, direction: 'input' }, mockDb, cfg);
    expect(results.size).toBe(0);
  });
});

// ─── InvoiceValidationPipeline ────────────────────────────────────────────────
describe('InvoiceValidationPipeline', () => {
  // Must import AFTER mocks are set up
  let InvoiceValidationPipeline: typeof import('../../src/tax/validation/invoice-validation.pipeline').InvoiceValidationPipeline;

  beforeAll(async () => {
    ({ InvoiceValidationPipeline } = await import('../../src/tax/validation/invoice-validation.pipeline'));
  });

  beforeEach(() => {
    mockQuery.mockReset();
    // Default: no plugin configs in DB (use built-in defaults)
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('returns empty output for 0 invoices', async () => {
    const pipeline = new InvoiceValidationPipeline(mockDb);
    const out = await pipeline.validate([], CTX);
    expect(out.valid_invoices).toHaveLength(0);
    expect(out.excluded_invoices).toHaveLength(0);
  });

  it('correctly separates cancelled vs valid invoices', async () => {
    // First call: loadPluginConfigs (returns empty), then persistAuditLog
    mockQuery
      .mockResolvedValueOnce({ rows: [] })       // loadPluginConfigs
      .mockResolvedValueOnce({ rows: [] });       // persistAuditLog (INSERT)

    const pipeline = new InvoiceValidationPipeline(mockDb);
    const invoices = [
      makeInvoice({ id: 'inv-v1', status: 'valid' }),
      makeInvoice({ id: 'inv-c1', status: 'cancelled' }),
      makeInvoice({ id: 'inv-v2', status: 'valid' }),
    ];
    const out = await pipeline.validate(invoices, CTX);

    expect(out.valid_invoices).toContain('inv-v1');
    expect(out.valid_invoices).toContain('inv-v2');
    expect(out.valid_invoices).not.toContain('inv-c1');
    expect(out.excluded_invoices).toHaveLength(1);
    expect(out.excluded_invoices[0]?.invoice_id).toBe('inv-c1');
    expect(out.excluded_invoices[0]?.reason_codes).toContain(ExclusionReasonCode.CANCELLED_BY_GDT);
  });

  it('accumulates warnings without excluding valid invoices', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })   // loadPluginConfigs
      .mockResolvedValueOnce({ rows: [] })   // ReplacedFilter DB query (no replacements)
      .mockResolvedValueOnce({ rows: [] })   // VendorRisk DB query
      .mockResolvedValueOnce({ rows: [] });  // persistAuditLog

    const pipeline = new InvoiceValidationPipeline(mockDb);
    const inv = makeInvoice({
      id: 'inv-warn',
      status: 'valid',
      total_amount: 6000000,
      invoice_date: new Date('2026-02-01'),
      // user_payment_flags is undefined → warning
    });
    const out = await pipeline.validate([inv], CTX);

    expect(out.valid_invoices).toContain('inv-warn');
    expect(out.warning_invoices.some(w => w.invoice_id === 'inv-warn')).toBe(true);
    expect(out.excluded_invoices).toHaveLength(0);
  });

  it('once excluded, later plugins skip the invoice', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const pipeline = new InvoiceValidationPipeline(mockDb);
    // Cancelled invoice — should be excluded at priority 10 (CancelledFilter)
    // No subsequent plugins should process it
    const invoices = [makeInvoice({ id: 'inv-dead', status: 'cancelled' })];
    const out = await pipeline.validate(invoices, CTX);

    expect(out.valid_invoices).toHaveLength(0);
    expect(out.excluded_invoices[0]?.plugin_name).toBe('cancelled_filter');
  });
});

// ─── Regression: direction-split ID filter (prevents 0đ ct40a bug) ───────────
describe('VatReconciliationService direction-split filter', () => {
  let VatReconciliationService: typeof import('../../src/services/VatReconciliationService').VatReconciliationService;

  beforeAll(async () => {
    ({ VatReconciliationService } = await import('../../src/services/VatReconciliationService'));
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('applies inputIds only to input queries, outputIds only to output query', async () => {
    // Mock 3 queries: inputAll, inputDeductible, outputByRate + upsert
    // We check that the 3rd query (output) uses outputIds correctly
    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // inputAll query
      .mockResolvedValueOnce({ rows: [] })  // inputDeductible query
      .mockResolvedValueOnce({              // outputByRate query → returns data
        rows: [{ vat_rate: '8', vat_sum: '3902474', subtotal_sum: '48780925' }],
      })
      .mockResolvedValueOnce({ rows: [] }); // upsert vat_reconciliations

    const svc = new VatReconciliationService();
    const validIds = {
      inputIds:  ['input-uuid-1', 'input-uuid-2'],
      outputIds: ['output-uuid-1'],
    };

    const result = await svc.calculatePeriod('company-0001', 3, 2026, validIds);

    // Verify output VAT was calculated from the mocked outputByRate row
    expect(result.ct40a_total_output_vat).toBe(3902474);

    // Verify 3rd call (outputByRate) contains outputId, NOT inputIds
    const outputQueryCall = mockQuery.mock.calls[2];
    const outputSql = outputQueryCall[0] as string;
    const outputParams = outputQueryCall[1] as unknown[];

    expect(outputSql).toContain("AND id = ANY($4::uuid[])");
    // outputIds should be passed as $4
    expect(outputParams[3]).toEqual(['output-uuid-1']);
    // inputIds should NOT appear in the output query params
    expect(JSON.stringify(outputParams)).not.toContain('input-uuid-1');
  });

  it('applies no filter when validIds is undefined (all invoices included)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ vat_rate: '8', vat_sum: '100000', subtotal_sum: '1000000' }] })
      .mockResolvedValueOnce({ rows: [{ vat_rate: '8', vat_sum: '80000', subtotal_sum: '800000' }] })
      .mockResolvedValueOnce({ rows: [{ vat_rate: '8', vat_sum: '200000', subtotal_sum: '2000000' }] })
      .mockResolvedValueOnce({ rows: [] }); // upsert

    const svc = new VatReconciliationService();
    const result = await svc.calculatePeriod('company-0001', 3, 2026, undefined);

    // No ID filter → SQL should NOT contain ANY($4)
    for (const call of mockQuery.mock.calls.slice(0, 3)) {
      const sql = call[0] as string;
      expect(sql).not.toContain('ANY($4');
    }

    expect(result.ct40a_total_output_vat).toBe(200000);
    expect(result.ct23_deductible_input_vat).toBe(80000);
  });

  it('outputs ct40a > 0 even when inputIds list is non-empty but outputIds is empty', async () => {
    // Regression: before the fix, passing a merged validInvoiceIds array to both
    // queries would result in the output query finding no rows (0đ ct40a).
    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // inputAll
      .mockResolvedValueOnce({ rows: [] })  // inputDeductible
      .mockResolvedValueOnce({              // outputByRate — should run WITHOUT filter
        rows: [{ vat_rate: '10', vat_sum: '500000', subtotal_sum: '5000000' }],
      })
      .mockResolvedValueOnce({ rows: [] }); // upsert

    const svc = new VatReconciliationService();
    // inputIds is non-empty, outputIds is empty → output query has no ID filter
    const result = await svc.calculatePeriod('company-0001', 3, 2026, {
      inputIds: ['input-only-uuid'],
      outputIds: [],
    });

    // Output query (3rd query) should NOT have $4 ID filter
    const outputQueryCall = mockQuery.mock.calls[2];
    const outputSql = outputQueryCall[0] as string;
    expect(outputSql).not.toContain('ANY($4');

    // ct40a should come from the mocked output rows
    expect(result.ct40a_total_output_vat).toBe(500000);
  });
});
