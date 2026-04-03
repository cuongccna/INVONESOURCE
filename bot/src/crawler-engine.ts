/**
 * CrawlerEngine — orchestrates a full GDT sync using a DB-loaded recipe.
 *
 * Usage:
 *   const engine = new CrawlerEngine('gdt_main');
 *   const result = await engine.run({ username, password, proxyUrl, socks5ProxyUrl, fromDate, toDate });
 *
 * The recipe is loaded from the crawler_recipes table (30-second TTL cache).
 * If the DB is unavailable, built-in defaults are used transparently.
 *
 * sync.worker.ts continues to instantiate GdtDirectApiService directly.
 * CrawlerEngine is available for future migration and for new integration code.
 */
import { loadRecipe } from './recipe.loader';
import { GdtDirectApiService } from './gdt-direct-api.service';
import type { RawInvoice } from './parsers/GdtXmlParser';
import type { CrawlerRecipe } from './types/recipe.types';

export interface CrawlerRunParams {
  username:       string;
  password:       string;
  proxyUrl?:      string | null;
  socks5ProxyUrl?: string | null;
  fromDate:       Date;
  toDate:         Date;
}

export interface CrawlerRunResult {
  outputInvoices: RawInvoice[];
  inputInvoices:  RawInvoice[];
  recipe:         CrawlerRecipe;
}

export class CrawlerEngine {
  constructor(private readonly recipeName: string = 'gdt_main') {}

  async run(params: CrawlerRunParams): Promise<CrawlerRunResult> {
    const { username, password, proxyUrl, socks5ProxyUrl, fromDate, toDate } = params;

    const recipe = await loadRecipe(this.recipeName);
    const svc    = new GdtDirectApiService(proxyUrl, socks5ProxyUrl, recipe);

    await svc.login(username, password);

    const [outputInvoices, inputInvoices] = await Promise.all([
      svc.fetchOutputInvoices(fromDate, toDate),
      svc.fetchInputInvoices(fromDate, toDate),
    ]);

    return { outputInvoices, inputInvoices, recipe };
  }

  /**
   * Create a pre-authenticated GdtDirectApiService with the current recipe.
   * Useful for callers that need direct access to exportInvoiceXml / exportExcel
   * while still benefiting from recipe-driven configuration.
   */
  async createApiService(
    proxyUrl?:       string | null,
    socks5ProxyUrl?: string | null,
  ): Promise<GdtDirectApiService> {
    const recipe = await loadRecipe(this.recipeName);
    return new GdtDirectApiService(proxyUrl, socks5ProxyUrl, recipe);
  }
}
