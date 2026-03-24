-- Migration: 005_hierarchy.sql
-- HĐĐT Unified Platform - Company hierarchy and organization grouping
-- Created: 2026-03-24

-- ============================================================
-- ORGANIZATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  short_name VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- COMPANY ENTITY TYPE ENUM
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_entity_type') THEN
    CREATE TYPE company_entity_type AS ENUM ('company', 'branch', 'representative_office', 'project');
  END IF;
END$$;

-- ============================================================
-- COMPANIES HIERARCHY COLUMNS
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS level SMALLINT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS entity_type company_entity_type DEFAULT 'company',
  ADD COLUMN IF NOT EXISTS is_consolidated BOOLEAN DEFAULT false;

-- Ensure level has safe range
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_companies_level_range'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT chk_companies_level_range CHECK (level BETWEEN 1 AND 20);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_companies_org ON companies(organization_id);
CREATE INDEX IF NOT EXISTS idx_companies_parent ON companies(parent_id);

-- ============================================================
-- HELPER FUNCTION: RECURSIVE COMPANY TREE
-- ============================================================

CREATE OR REPLACE FUNCTION get_company_tree(root_id UUID)
RETURNS TABLE(
  id UUID,
  name VARCHAR,
  tax_code VARCHAR,
  level SMALLINT,
  parent_id UUID,
  entity_type company_entity_type,
  path TEXT
) AS $$
  WITH RECURSIVE tree AS (
    SELECT
      c.id,
      c.name,
      c.tax_code,
      c.level,
      c.parent_id,
      c.entity_type,
      c.name::TEXT AS path
    FROM companies c
    WHERE c.id = root_id AND c.deleted_at IS NULL

    UNION ALL

    SELECT
      c.id,
      c.name,
      c.tax_code,
      c.level,
      c.parent_id,
      c.entity_type,
      tree.path || ' > ' || c.name
    FROM companies c
    JOIN tree ON c.parent_id = tree.id
    WHERE c.deleted_at IS NULL
  )
  SELECT tree.id, tree.name, tree.tax_code, tree.level, tree.parent_id, tree.entity_type, tree.path
  FROM tree;
$$ LANGUAGE sql STABLE;
