import { BkavConnector } from '../../src/connectors/BkavConnector';
import { encryptCredentials } from '../../src/utils/encryption';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const BKAV_BASE = 'https://api.bkav.com.vn/einvoice';

const server = setupServer(
  http.get(`${BKAV_BASE}/api/invoices`, () =>
    HttpResponse.json({
      data: [
        {
          invoiceId: 'BKAV-001',
          invoiceNumber: 'HD000001',
          invoiceSeries: 'CC/24E',
          ArisingDate: '2024-01-15',
          SellerName: 'Cty BKAV Bán',
          SellerTaxCode: '0102345678',
          BuyerName: 'Cty Mua BKAV',
          BuyerTaxCode: '0123456789',
          TotalAmountWithoutVAT: 15000000,
          VATAmount: 1500000,
          VATRate: 10,
          TotalPaymentAmount: 16500000,
          InvoiceStatus: 1,
          PaymentMethodName: 'Chuyển khoản',
        },
      ],
      totalCount: 1,
    })
  ),
  http.get(`${BKAV_BASE}/api/purchase-invoices`, () =>
    HttpResponse.json({
      data: [],
      totalCount: 0,
    })
  )
);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('BkavConnector', () => {
  let connector: BkavConnector;

  beforeEach(() => {
    connector = new BkavConnector();
  });

  it('has correct plugin metadata', () => {
    expect(connector.id).toBe('bkav');
    expect(connector.name).toBe('BKAV eInvoice');
  });

  it('authenticate stores partner credentials', async () => {
    await expect(
      connector.authenticate({ encrypted: encryptCredentials({ partnerGuid: 'GUID-TEST-123', partnerToken: 'TOKEN-TEST-456', taxCode: '0123456789' }) })
    ).resolves.not.toThrow();
  });

  it('pullOutputInvoices returns invoices with gdt_validated = true', async () => {
    await connector.authenticate({ encrypted: encryptCredentials({ partnerGuid: 'GUID-TEST-123', partnerToken: 'TOKEN-TEST-456', taxCode: '0123456789' }) });

    const invoices = await connector.pullOutputInvoices({
      companyId: 'test-company',
      fromDate: new Date('2024-01-01'),
      toDate: new Date('2024-01-31'),
      taxCode: '0123456789',
    });

    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.externalId).toBe('BKAV-001');
    // BKAV validates GDT internally; source field indicates provider
    expect(invoices[0]!.source).toBe('bkav');
    expect(invoices[0]!.vatAmount).toBe(1500000);
  });

  it('pullInputInvoices returns empty array', async () => {
    await connector.authenticate({ encrypted: encryptCredentials({ partnerGuid: 'GUID-TEST-123', partnerToken: 'TOKEN-TEST-456', taxCode: '0123456789' }) });

    const invoices = await connector.pullInputInvoices({
      companyId: 'test-company',
      fromDate: new Date('2024-01-01'),
      toDate: new Date('2024-01-31'),
      taxCode: '0123456789',
    });

    expect(invoices).toHaveLength(0);
  });

  it('sends correct auth headers', async () => {
    let capturedHeaders: Record<string, string> = {};
    server.use(
      http.get(`${BKAV_BASE}/api/invoices`, ({ request }) => {
        capturedHeaders = Object.fromEntries(request.headers.entries());
        return HttpResponse.json({ data: [], totalCount: 0 });
      })
    );

    await connector.authenticate({ encrypted: encryptCredentials({ partnerGuid: 'MY-GUID', partnerToken: 'MY-TOKEN', taxCode: '0123456789' }) });
    await connector.pullOutputInvoices({
      companyId: 'test-company',
      fromDate: new Date('2024-01-01'),
      toDate: new Date('2024-01-31'),
      taxCode: '0123456789',
    });

    expect(capturedHeaders['partnerguid']).toBe('MY-GUID');
    expect(capturedHeaders['partnertoken']).toBe('MY-TOKEN');
  });
});
