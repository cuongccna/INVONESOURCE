-- Migration: 001_init.sql
-- HĐĐT Unified Platform - Core Tables
-- Created: 2026-03-23

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS (idempotent — safe to re-run)
-- ============================================================

DO $$ BEGIN CREATE TYPE user_role AS ENUM ('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE invoice_provider AS ENUM ('misa', 'viettel', 'bkav', 'gdt_intermediary', 'manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE invoice_direction AS ENUM ('output', 'input'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE invoice_status AS ENUM ('valid', 'cancelled', 'replaced', 'adjusted', 'invalid'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE circuit_state AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE filing_frequency AS ENUM ('monthly', 'quarterly'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE declaration_method AS ENUM ('deduction', 'direct'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE submission_method AS ENUM ('manual', 'tvan', 'gdt_api'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE submission_status AS ENUM ('draft', 'ready', 'submitted', 'accepted', 'rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE attachment_type AS ENUM ('PL01-1', 'PL01-2', 'PL01-3', 'PL01-4a', 'PL01-4b', 'OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- COMPANIES
-- ============================================================

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  tax_code VARCHAR(20) NOT NULL UNIQUE,
  address TEXT,
  phone VARCHAR(20),
  email VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_tax_code ON companies(tax_code);

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================
-- USER_COMPANIES (many-to-many with role)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_companies (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role user_role NOT NULL DEFAULT 'ACCOUNTANT',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_user_companies_company ON user_companies(company_id);
CREATE INDEX IF NOT EXISTS idx_user_companies_user ON user_companies(user_id);

-- ============================================================
-- COMPANY_CONNECTORS
-- ============================================================

CREATE TABLE IF NOT EXISTS company_connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider invoice_provider NOT NULL,
  credentials_encrypted TEXT NOT NULL,        -- AES-256-GCM encrypted JSON
  enabled BOOLEAN DEFAULT true,
  circuit_state circuit_state DEFAULT 'CLOSED',
  consecutive_failures INT DEFAULT 0,
  circuit_opened_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_connectors_company ON company_connectors(company_id);
CREATE INDEX IF NOT EXISTS idx_connectors_provider ON company_connectors(provider);

-- ============================================================
-- INVOICES
-- ============================================================

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider invoice_provider NOT NULL,
  direction invoice_direction NOT NULL,
  invoice_number VARCHAR(50) NOT NULL,
  serial_number VARCHAR(20),
  invoice_date DATE NOT NULL,
  seller_tax_code VARCHAR(20),
  seller_name VARCHAR(255),
  buyer_tax_code VARCHAR(20),
  buyer_name VARCHAR(255),
  subtotal NUMERIC(18,2) DEFAULT 0,
  vat_rate NUMERIC(5,2) DEFAULT 0,           -- 0, 5, 8, 10
  vat_amount NUMERIC(18,2) DEFAULT 0,
  total_amount NUMERIC(18,2) DEFAULT 0,
  currency CHAR(3) DEFAULT 'VND',
  payment_method VARCHAR(50),                 -- 'cash' | 'transfer' | 'other'
  status invoice_status DEFAULT 'valid',
  gdt_validated BOOLEAN DEFAULT false,
  gdt_validated_at TIMESTAMPTZ,
  raw_xml TEXT,
  pdf_path VARCHAR(500),
  external_id VARCHAR(100),
  sync_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,                     -- soft delete
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, provider, invoice_number, seller_tax_code, invoice_date)
);

CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_direction_status ON invoices(direction, status);
CREATE INDEX IF NOT EXISTS idx_invoices_seller_tax ON invoices(seller_tax_code);
CREATE INDEX IF NOT EXISTS idx_invoices_buyer_tax ON invoices(buyer_tax_code);
CREATE INDEX IF NOT EXISTS idx_invoices_provider ON invoices(provider);
CREATE INDEX IF NOT EXISTS idx_invoices_gdt_validated ON invoices(gdt_validated);
CREATE INDEX IF NOT EXISTS idx_invoices_deleted ON invoices(deleted_at) WHERE deleted_at IS NULL;

-- ============================================================
-- VAT_RECONCILIATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS vat_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_month SMALLINT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year SMALLINT NOT NULL CHECK (period_year >= 2020),
  output_vat NUMERIC(18,2) DEFAULT 0,
  input_vat NUMERIC(18,2) DEFAULT 0,
  payable_vat NUMERIC(18,2) DEFAULT 0,
  breakdown JSONB DEFAULT '{}',              -- {by_rate: {0: {...}, 5: {...}, ...}}
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_month, period_year)
);

CREATE INDEX IF NOT EXISTS idx_vat_reconciliations_company ON vat_reconciliations(company_id);
CREATE INDEX IF NOT EXISTS idx_vat_reconciliations_period ON vat_reconciliations(period_year, period_month);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT false,
  push_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = false;

-- ============================================================
-- SYNC_LOGS
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  records_fetched INT DEFAULT 0,
  records_created INT DEFAULT 0,
  records_updated INT DEFAULT 0,
  errors_count INT DEFAULT 0,
  error_detail TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_company ON sync_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_provider ON sync_logs(company_id, provider);
CREATE INDEX IF NOT EXISTS idx_sync_logs_started ON sync_logs(started_at DESC);

-- ============================================================
-- PUSH_SUBSCRIPTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- ============================================================
-- REFRESH_TOKENS (for JWT refresh)
-- ============================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- ============================================================
-- AUDIT_LOGS
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id VARCHAR(100),
  details JSONB DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_company ON audit_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
