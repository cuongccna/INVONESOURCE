-- 032_gdt_configs.sql
-- Config-driven GDT crawl configuration.
-- When GDT changes endpoints or field names, update config in this table — zero code deploy.

CREATE TABLE IF NOT EXISTS gdt_configs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version    INT NOT NULL DEFAULT 1,
  config     JSONB NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT false,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only ONE active config at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_gdt_configs_active
  ON gdt_configs (is_active) WHERE is_active = true;

-- Seed default config (matches DEFAULT_GDT_CONFIG in gdt-config.ts)
INSERT INTO gdt_configs (version, is_active, note, config)
VALUES (
  1,
  true,
  'Default config v1 — production GDT endpoints as of 2025-07',
  '{
    "api": {
      "baseUrl": "https://hoadondientu.gdt.gov.vn:30000",
      "endpoints": {
        "auth":        "/security-taxpayer/authenticate",
        "sold":        "/query/invoices/sold",
        "soldSco":     "/sco-query/invoices/sold",
        "purchase":    "/query/invoices/purchase",
        "purchaseSco": "/sco-query/invoices/purchase",
        "detail":      "/query/invoices/detail",
        "detailSco":   "/sco-query/invoices/detail",
        "captcha":     "/captcha"
      },
      "endpointTimeouts": {
        "/query/invoices/sold":            30000,
        "/query/invoices/purchase":        30000,
        "/query/invoices/detail":          45000,
        "/sco-query/invoices/sold":        60000,
        "/sco-query/invoices/purchase":    60000,
        "/sco-query/invoices/detail":      60000,
        "/captcha":                        15000,
        "/security-taxpayer/authenticate": 20000
      },
      "pagination": {
        "pageSize": 50,
        "zeroBased": true,
        "totalHeader": "X-Total-Count"
      },
      "query": {
        "purchaseFilters": ["ttxly==5", "ttxly==6", "ttxly==8"],
        "xmlAvailableTtxly": [5]
      }
    },
    "fields": {
      "date":        ["tdlap", "ngayLap", "ngay_lap"],
      "total":       ["tgtttbso", "tongThanhToan", "tongTien"],
      "serial":      ["khhdon", "kyHieuHoaDon"],
      "status":      ["tthai", "tthdon", "trangThai"],
      "ttxly":       ["ttxly"],
      "vatRate":     ["tsuat", "thueSuat"],
      "buyerTax":    ["nmmst", "mnmst", "mstNguoiMua"],
      "subtotal":    ["tgtcthue", "tienHangChuaThue"],
      "buyerName":   ["nmten", "tenNguoiMua"],
      "sellerTax":   ["nbmst", "mstNguoiBan"],
      "vatAmount":   ["tgtthue", "tienThue"],
      "invoiceNum":  ["shdon", "soHoaDon"],
      "sellerName":  ["nbten", "tenNguoiBan"],
      "invoiceType": ["loaiHoaDon", "lhdon"],
      "vatRateNestedPath": "ttkhac"
    },
    "statusMap": {
      "1": "VALID",
      "2": "REPLACED",
      "3": "ADJUSTED",
      "4": "CANCELLED",
      "5": "REPLACED_ORIGINAL",
      "6": "ADJUSTED_ORIGINAL"
    },
    "ttxlyMap": {
      "5": "CQT_ACCEPTED",
      "6": "CQT_NOT_ACCEPTED",
      "7": "CQT_PENDING",
      "8": "CQT_NO_RESULT",
      "9": "CANCELLED"
    },
    "timing": {
      "requestTimeoutMs": 30000,
      "binaryTimeoutMs":  60000,
      "retryDelayMs":     5000,
      "maxRetries":       3
    }
  }'::jsonb
)
ON CONFLICT DO NOTHING;
