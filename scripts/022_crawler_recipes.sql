-- 022_crawler_recipes.sql
-- Stores GDT crawler configuration as JSONB.
-- Admins can update recipe fields via the /admin/crawler-recipes UI
-- and the bot picks up the new config within 30 seconds (TTL cache).
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS crawler_recipes (
  id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT        NOT NULL UNIQUE,
  version    INT         NOT NULL DEFAULT 1,
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  recipe     JSONB       NOT NULL,
  notes      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawler_recipes_active
  ON crawler_recipes(name)
  WHERE is_active = true;

-- Seed the default recipe for the GDT portal.
-- All values mirror the hardcoded constants in gdt-direct-api.service.ts.
-- ON CONFLICT DO NOTHING ensures re-runs are safe.
INSERT INTO crawler_recipes (name, recipe, notes)
VALUES (
  'gdt_main',
  '{
    "api": {
      "baseUrl":     "https://hoadondientu.gdt.gov.vn:30000",
      "baseUrlHttp": "http://hoadondientu.gdt.gov.vn:30000",
      "endpoints": {
        "captcha":             "/captcha",
        "auth":                "/security-taxpayer/authenticate",
        "sold":                "/query/invoices/sold",
        "purchase":            "/query/invoices/purchase",
        "detail":              "/query/invoices/detail",
        "exportXml":           "/query/invoices/export-xml",
        "exportExcel":         "/query/invoices/export-excel",
        "exportExcelPurchase": "/query/invoices/export-excel-sold"
      },
      "pagination": {
        "pageSize":    50,
        "zeroBased":   true,
        "totalHeader": "X-Total-Count"
      },
      "query": {
        "purchaseFilters":   ["ttxly==5", "ttxly==6", "ttxly==8"],
        "xmlAvailableTtxly": [5]
      }
    },
    "fields": {
      "status":             ["tthai", "ttxly", "tthdon", "trangThai", "status"],
      "sellerTax":          ["nbmst", "msttcgpbh", "mst_ban", "msttcgp_ban", "mstNguoiBan"],
      "sellerName":         ["nbten", "tenbh", "ten_ban", "tenNguoiBan", "nguoiBanHang"],
      "buyerTax":           ["nmmst", "mnmst", "mst_mua", "mstnmua", "mstNguoiMua"],
      "buyerName":          ["nmten", "tenn", "ten_mua", "tenNguoiMua", "nguoiMuaHang"],
      "invoiceNum":         ["shdon", "soHoaDon", "so_hd", "ma_hd"],
      "serial":             ["khhdon", "kyHieuHoaDon", "ky_hieu_hd"],
      "date":               ["tdlap", "ngayLap", "ngay_lap"],
      "subtotal":           ["tgtcthue", "tien_chua_thue", "tienHangChuaThue"],
      "vatAmount":          ["tgtthue", "tien_thue", "tienThue"],
      "total":              ["tgtttbso", "thanh_toan", "tongThanhToan", "tongTien"],
      "vatRate":            ["tsuat", "thueSuat", "thue_suat"],
      "vatRateNestedPath":  "thttltsuat",
      "invoiceType":        ["thdon", "loaiHD", "loai_hd", "la"]
    },
    "statusMap": {
      "1": "valid",
      "3": "cancelled",
      "5": "replaced",
      "6": "adjusted"
    },
    "timing": {
      "maxRetries":        3,
      "retryDelayMs":      3000,
      "requestTimeoutMs":  30000,
      "binaryTimeoutMs":   60000
    }
  }'::jsonb,
  'Default GDT portal recipe. Edit field arrays if GDT renames response keys. Edit endpoint paths if GDT moves routes.'
)
ON CONFLICT (name) DO NOTHING;
