import type { Pool } from 'pg';
import type { InvoiceRow, InvoiceValidationContext, InvoiceValidationResult } from './types';

/**
 * plugin.interface.ts — Contract every validation plugin must implement.
 *
 * Adding a new plugin: create a new file + add to plugins/index.ts.
 * No changes to core pipeline required.
 */

export interface IInvoiceValidationPlugin {
  /** Unique identifier — stored in invoice_validation_log.plugin_name */
  readonly name: string;

  /** Display name in Vietnamese — shown in UI */
  readonly displayName: string;

  /**
   * Execution order — lower runs first.
   * Hard exclusions (automated rules): < 100.
   * User-input-dependent checks: >= 200.
   */
  readonly priority: number;

  /** Which declaration direction this plugin applies to */
  readonly appliesTo: 'input' | 'output' | 'both';

  /** Legal basis reference for audit trail */
  readonly legalBasis: string;

  /** Whether this plugin can be disabled via validation_plugin_configs */
  readonly canDisable: boolean;

  /**
   * Validate a BATCH of invoices in one call to allow DB-level batch queries.
   *
   * Return a Map<invoice_id, InvoiceValidationResult> for every invoice that
   * should be EXCLUDED or WARNED. Invoices NOT in the returned map are considered
   * to have passed this plugin (valid for this check).
   *
   * The pipeline will short-circuit further plugin execution for already-excluded invoices.
   *
   * @param pluginConfig - Runtime config loaded from validation_plugin_configs table.
   *                       Pass this to plugins that have configurable thresholds/keywords.
   */
  validateBatch(
    invoices: InvoiceRow[],
    context: InvoiceValidationContext,
    db: Pool,
    pluginConfig?: PluginConfig
  ): Promise<Map<string, InvoiceValidationResult>>;
}

export interface PluginConfig {
  name: string;
  enabled: boolean;
  priority_override?: number | null;
  config: Record<string, unknown>;
}
