/**
 * scripts/seed.ts — Development seed data
 * Run: npx ts-node scripts/seed.ts
 */
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { encryptCredentials } from '../backend/src/utils/encryption';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Seeding companies...');
    const company1Id = uuidv4();
    const company2Id = uuidv4();

    await client.query(
      `INSERT INTO companies (id, name, tax_code, address, email, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [company1Id, 'Công ty TNHH Demo ABC', '0123456789', '123 Đường Láng, Đống Đa, Hà Nội', 'keto@demoabc.vn', '0241234567']
    );

    await client.query(
      `INSERT INTO companies (id, name, tax_code, address, email, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [company2Id, 'Công ty CP Thương Mại XYZ', '9876543210', '456 Nguyễn Huệ, Q.1, TP.HCM', 'ketoan@xyz.com.vn', '0289876543']
    );

    console.log('Seeding users...');
    const adminId1 = uuidv4();
    const adminId2 = uuidv4();
    const accountantId = uuidv4();
    const passwordHash = await bcrypt.hash('Admin@123456', 12);
    const accountantHash = await bcrypt.hash('Account@123456', 12);

    await client.query(
      `INSERT INTO users (id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [adminId1, 'admin@demoabc.vn', passwordHash, 'Nguyễn Văn Admin']
    );

    await client.query(
      `INSERT INTO users (id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [adminId2, 'admin@xyz.com.vn', passwordHash, 'Trần Thị Quản Lý']
    );

    await client.query(
      `INSERT INTO users (id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [accountantId, 'ketoan@demoabc.vn', accountantHash, 'Lê Thị Kế Toán']
    );

    console.log('Seeding user_companies...');
    await client.query(
      `INSERT INTO user_companies (id, user_id, company_id, role)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [uuidv4(), adminId1, company1Id, 'OWNER']
    );
    await client.query(
      `INSERT INTO user_companies (id, user_id, company_id, role)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [uuidv4(), adminId2, company2Id, 'OWNER']
    );
    await client.query(
      `INSERT INTO user_companies (id, user_id, company_id, role)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [uuidv4(), accountantId, company1Id, 'ACCOUNTANT']
    );

    console.log('Seeding connectors...');
    const misaCredsEnc = encryptCredentials({ username: 'demo_misa', password: 'demo_password_misa', taxCode: '0123456789' });
    await client.query(
      `INSERT INTO company_connectors (id, company_id, provider_id, credentials_enc, is_enabled, sync_frequency_minutes)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [uuidv4(), company1Id, 'misa', misaCredsEnc, true, 15]
    );

    const viettelCredsEnc = encryptCredentials({ username: '0100109106-215', password: '111111a@A', taxCode: '0123456789' });
    await client.query(
      `INSERT INTO company_connectors (id, company_id, provider_id, credentials_enc, is_enabled, sync_frequency_minutes)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [uuidv4(), company2Id, 'viettel', viettelCredsEnc, true, 15]
    );

    console.log('Seeding invoices (80 records)...');
    const sellers = [
      { name: 'Công ty TNHH Cung Ứng ABC', tax_code: '0123456789' },
      { name: 'Công ty CP Dịch Vụ DEF', tax_code: '0234567891' },
      { name: 'Công ty TNHH Sản Xuất GHI', tax_code: '0345678912' },
    ];

    const now = new Date();
    for (let i = 0; i < 80; i++) {
      const isOutput = i % 2 === 0;
      const seller = sellers[i % 3]!;
      const invoiceDate = new Date(now.getFullYear(), now.getMonth() - (i % 3), 1 + (i % 28));
      const totalAmount = (Math.floor(Math.random() * 50) + 5) * 1_000_000;
      const vatRate = [0, 5, 8, 10][i % 4]!;
      const vatAmount = Math.round(totalAmount * vatRate / 100);
      const provider = ['misa', 'viettel', 'bkav'][i % 3]!;

      await client.query(
        `INSERT INTO invoices (
           id, company_id, source_provider, external_id, invoice_number, serial_number,
           invoice_date, direction, status, gdt_validated,
           seller_name, seller_tax_code, buyer_name, buyer_tax_code,
           total_amount, vat_amount, vat_rate, currency, payment_method
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (company_id, source_provider, external_id) DO NOTHING`,
        [
          uuidv4(), company1Id, provider, `EXT-${i + 1000}`,
          `HD${String(i + 1).padStart(6, '0')}`, `AA/24E`,
          invoiceDate.toISOString().split('T')[0],
          isOutput ? 'output' : 'input',
          i % 10 === 0 ? 'cancelled' : 'valid',
          i % 5 !== 0, // 80% validated
          isOutput ? 'Công ty TNHH Demo ABC' : seller.name,
          isOutput ? '0123456789' : seller.tax_code,
          isOutput ? seller.name : 'Công ty TNHH Demo ABC',
          isOutput ? seller.tax_code : '0123456789',
          totalAmount, vatAmount, vatRate, 'VND',
          i % 3 === 0 ? 'cash' : 'bank_transfer',
        ]
      );
    }

    console.log('Seeding VAT reconciliation...');
    await client.query(
      `INSERT INTO vat_reconciliations
         (id, company_id, period_month, period_year, output_vat, input_vat, payable_vat, carry_forward, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING`,
      [uuidv4(), company1Id, now.getMonth() + 1, now.getFullYear(),
       500_000_000, 300_000_000, 200_000_000, 0, 'draft']
    );

    console.log('Seeding notifications...');
    await client.query(
      `INSERT INTO notifications (id, company_id, user_id, type, title, body)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [uuidv4(), company1Id, adminId1, 'tax_deadline',
       'Nhắc hạn nộp tờ khai',
       `Hạn nộp tờ khai thuế GTGT tháng ${now.getMonth() + 1}/${now.getFullYear()} là ngày 20/${now.getMonth() + 2}/${now.getFullYear()}`]
    );

    await client.query('COMMIT');
    console.log('\n✅ Seed completed successfully!');
    console.log('  Admin user 1: admin@demoabc.vn / Admin@123456');
    console.log('  Admin user 2: admin@xyz.com.vn / Admin@123456');
    console.log('  Accountant:   ketoan@demoabc.vn / Account@123456');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
