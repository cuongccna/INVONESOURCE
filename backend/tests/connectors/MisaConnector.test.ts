import { MisaConnector } from '../../src/connectors/MisaConnector';
import { encryptCredentials } from '../../src/utils/encryption';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const MISA_BASE = 'https://api.meinvoice.vn';

// Mock server
const server = setupServer(
  http.post(`${MISA_BASE}/api/auth/login`, () =>
    HttpResponse.json({
      token: 'mock-jwt-token',
      expiredIn: 3600,
    })
  ),
  http.get(`${MISA_BASE}/api/invoice/list`, () =>
    HttpResponse.json({
      data: [
        {
          invoiceId: 'MISA-001',
          no: 'HD000001',
          serial: 'AA/24E',
          issuedDate: '2024-01-15T00:00:00Z',
          sellerName: 'Cty A',
          sellerTaxCode: '0123456789',
          buyerName: 'Cty B',
          buyerTaxCode: '0987654321',
          totalAmountWithoutTax: 10000000,
          taxAmount: 1000000,
          taxRate: 10,
          totalAmount: 11000000,
          status: 'valid',
          paymentMethod: 'bank_transfer',
        },
      ],
      totalRecord: 1,
    })
  )
);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('MisaConnector', () => {
  let connector: MisaConnector;

  beforeEach(() => {
    connector = new MisaConnector();
  });

  it('has correct id and version', () => {
    expect(connector.id).toBe('misa');
    expect(connector.name).toBe('MISA meInvoice');
    expect(connector.version).toBe('1.0.0');
  });

  it('authenticate stores token', async () => {
    await expect(
      connector.authenticate({ encrypted: encryptCredentials({ username: 'test@company.vn', password: 'secret', taxCode: '0123456789' }) })
    ).resolves.not.toThrow();
  });

  it('pullOutputInvoices returns normalized invoices', async () => {
    await connector.authenticate({ encrypted: encryptCredentials({ username: 'test@company.vn', password: 'secret', taxCode: '0123456789' }) });

    const invoices = await connector.pullOutputInvoices({
      companyId: 'test-company',
      fromDate: new Date('2024-01-01'),
      toDate: new Date('2024-01-31'),
      taxCode: '0123456789',
    });

    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.externalId).toBe('MISA-001');
    expect(invoices[0]!.invoiceNumber).toBe('HD000001');
    expect(invoices[0]!.vatAmount).toBe(1000000);
  });

  it('healthCheck returns true when authenticated', async () => {
    await connector.authenticate({ encrypted: encryptCredentials({ username: 'test@company.vn', password: 'secret', taxCode: '0123456789' }) });
    const healthy = await connector.healthCheck();
    expect(healthy).toBe(true);
  });

  it('pullInputInvoices returns empty array (403 paid add-on)', async () => {
    server.use(
      http.get(`${MISA_BASE}/api/purchaseinvoice/list`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 })
      )
    );

    await connector.authenticate({ encrypted: encryptCredentials({ username: 'test@company.vn', password: 'secret', taxCode: '0123456789' }) });
    const invoices = await connector.pullInputInvoices({
      companyId: 'test-company',
      fromDate: new Date('2024-01-01'),
      toDate: new Date('2024-01-31'),
      taxCode: '0123456789',
    });

    expect(invoices).toHaveLength(0);
  });
});
