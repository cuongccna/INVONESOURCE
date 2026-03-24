import { ViettelConnector } from '../../src/connectors/ViettelConnector';
import { encryptCredentials } from '../../src/utils/encryption';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const VIETTEL_BASE = 'https://sinvoice.viettel.vn:8443';

const server = setupServer(
  http.post(`${VIETTEL_BASE}/InvoiceAPI/InvoiceUtilsWS/getListInvoiceDataControl`, () =>
    HttpResponse.json({
      general_invoice_info: [
        {
          invoiceId: 'VIETTEL-001',
          invoiceNo: 'HD000001',
          serial: 'BB/24E',
          invoiceDate: 1705276800000, // 2024-01-15 in ms
          sellerName: 'Cty Viettel Test',
          sellerTaxCode: '0100109106',
          buyerName: 'Cty Mua Hàng',
          buyerTaxCode: '0123456789',
          amount: 20000000,
          taxAmount: 2000000,
          taxPercentage: '10',
          totalAmount: 22000000,
          invoiceStatus: '1',
          transactionMethod: 'CK',
        },
      ],
    })
  )
);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('ViettelConnector', () => {
  let connector: ViettelConnector;

  beforeEach(() => {
    connector = new ViettelConnector();
  });

  it('has correct plugin metadata', () => {
    expect(connector.id).toBe('viettel');
    expect(connector.name).toBe('Viettel SInvoice');
  });

  it('authenticate with Basic credentials does not throw', async () => {
    await expect(
      connector.authenticate({ encrypted: encryptCredentials({ username: '0100109106-215', password: '111111a@A', taxCode: '0100109106' }) })
    ).resolves.not.toThrow();
  });

  it('pullOutputInvoices sends millisecond timestamps', async () => {
    let capturedBody: unknown;
    server.use(
      http.post(`${VIETTEL_BASE}/InvoiceAPI/InvoiceUtilsWS/getListInvoiceDataControl`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ general_invoice_info: [] });
      })
    );

    await connector.authenticate({ encrypted: encryptCredentials({ username: '0100109106-215', password: '111111a@A', taxCode: '0100109106' }) });
    await connector.pullOutputInvoices({
      companyId: 'test-company',
      fromDate: new Date('2024-01-01'),
      toDate: new Date('2024-01-31'),
      taxCode: '0100109106',
    });

    // Dates must be milliseconds (numbers), not strings
    const body = capturedBody as Record<string, unknown>;
    expect(typeof body.startDate).toBe('number');
    expect(typeof body.endDate).toBe('number');
    expect(body.startDate).toBeGreaterThan(1e12); // epoch ms > 1 trillion
  });

  it('pullOutputInvoices returns normalized invoices', async () => {
    await connector.authenticate({ encrypted: encryptCredentials({ username: '0100109106-215', password: '111111a@A', taxCode: '0100109106' }) });
    const invoices = await connector.pullOutputInvoices({
      companyId: 'test-company',
      fromDate: new Date('2024-01-01'),
      toDate: new Date('2024-01-31'),
      taxCode: '0100109106',
    });

    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.externalId).toBe('VIETTEL-001');
    expect(invoices[0]!.vatRate).toBe(10);
    expect(invoices[0]!.vatAmount).toBe(2000000);
  });
});
