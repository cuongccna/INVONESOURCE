/**
 * Type definitions for the CrawlerRecipe JSONB stored in crawler_recipes table.
 *
 * These interfaces mirror the seed JSONB in 022_crawler_recipes.sql.
 * All hardcoded constants in gdt-direct-api.service.ts are represented here
 * so the recipe can fully override them at runtime.
 */

export interface RecipeApiEndpoints {
  captcha:             string; // GET — returns { key, content: SVG }
  auth:                string; // POST — returns { token }
  sold:                string; // GET — paginated output invoice list
  purchase:            string; // GET — paginated input invoice list
  detail?:             string; // GET — single invoice detail JSON (hdhhdvu = line items)
  exportXml:           string; // GET — per-invoice signed XML ZIP (fallback only)
  exportExcel:         string; // GET — output bulk XLSX
  exportExcelPurchase: string; // GET — input bulk XLSX (?type=purchase)
}

export interface RecipeApiPagination {
  pageSize:    number;  // rows per page (default: 50)
  zeroBased:   boolean; // page index is 0-based
  totalHeader: string;  // response header carrying total row count (X-Total-Count)
}

export interface RecipeApiQuery {
  purchaseFilters:   string[]; // FIQL ttxly filters for purchase tabs
  xmlAvailableTtxly: number[]; // ttxly values that have a downloadable XML
}

export interface RecipeApi {
  baseUrl:     string;            // https:// — used for direct connections
  baseUrlHttp: string;            // http://  — used when axios tunnels via httpAgent
  endpoints:   RecipeApiEndpoints;
  pagination:  RecipeApiPagination;
  query:       RecipeApiQuery;
}

export interface RecipeFields {
  status:            string[];  // keys for tthdon / ttxly / tthai ...
  sellerTax:         string[];
  sellerName:        string[];
  buyerTax:          string[];
  buyerName:         string[];
  invoiceNum:        string[];
  serial:            string[];
  date:              string[];
  subtotal:          string[];
  vatAmount:         string[];
  total:             string[];
  vatRate:           string[];
  vatRateNestedPath: string;    // path to nested VAT rate array (thttltsuat)
  invoiceType:       string[];
}

export interface RecipeTiming {
  maxRetries:       number; // retry attempts for transient errors
  retryDelayMs:     number; // base delay between retries
  requestTimeoutMs: number; // axios timeout for JSON requests
  binaryTimeoutMs:  number; // axios timeout for binary (XML/XLSX) downloads
}

/** Full recipe structure stored in crawler_recipes.recipe JSONB */
export interface CrawlerRecipe {
  api:       RecipeApi;
  fields:    RecipeFields;
  statusMap: Record<string, string>; // GDT status code → our status string
  timing:    RecipeTiming;
}

/** Row shape returned from SELECT * FROM crawler_recipes */
export interface CrawlerRecipeRow {
  id:         string;
  name:       string;
  version:    number;
  is_active:  boolean;
  recipe:     CrawlerRecipe;
  notes:      string | null;
  updated_at: string;
  updated_by: string | null;
}
