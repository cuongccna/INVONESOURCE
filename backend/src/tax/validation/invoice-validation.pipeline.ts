import { pool } from '../../db/pool';
import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import type { IInvoiceValidationPlugin, PluginConfig } from './plugin.interface';
import type {
  InvoiceRow,
  InvoiceValidationContext,
  InvoiceValidationResult,
  PipelineValidationOutput,
} from './types';
import { ExclusionReasonCode } from './types';
import {
  CancelledFilterPlugin,
  ReplacedFilterPlugin,
  CqtSignatureFilterPlugin,
  CashPaymentFilterPlugin,
  NonBusinessFilterPlugin,
  VendorRiskFilterPlugin,
} from './plugins';

// ─── Built-in plugin registry ─────────────────────────────────────────────────
// All 6 plugins are instantiated once at module load time.
const ALL_PLUGINS: IInvoiceValidationPlugin[] = [
  new CancelledFilterPlugin(),
  new ReplacedFilterPlugin(),
  new CqtSignatureFilterPlugin(),
  new CashPaymentFilterPlugin(),
  new NonBusinessFilterPlugin(),
  new VendorRiskFilterPlugin(),
];

// ─── DB config row shape ──────────────────────────────────────────────────────
interface PluginConfigRow {
  plugin_name: string;
  enabled: boolean;
  priority_override: number | null;
  config: Record<string, unknown>;
}

/**
 * InvoiceValidationPipeline
 *
 * The ONLY entry point from TaxDeclarationEngine into the validation layer.
 * Knows nothing about specific rules — it just orchestrates plugins.
 *
 * Usage:
 *   const pipeline = new InvoiceValidationPipeline();
 *   const output = await pipeline.validate(invoices, context);
 */
export class InvoiceValidationPipeline {
  private readonly db: Pool;

  constructor(db: Pool = pool) {
    this.db = db;
  }

  // ─── Load plugin configs from DB ───────────────────────────────────────────
  /**
   * Load configs for this MST. Merges global defaults ('*') with company-specific
   * overrides — company-specific takes precedence.
   */
  private async loadPluginConfigs(mst: string): Promise<Map<string, PluginConfig>> {
    const { rows } = await this.db.query<PluginConfigRow>(
      `SELECT plugin_name, enabled, priority_override, config
       FROM validation_plugin_configs
       WHERE mst = '*' OR mst = $1
       ORDER BY
         CASE WHEN mst = '*' THEN 0 ELSE 1 END ASC`,
      [mst]
    );

    // Build map: company-specific overrides global
    const configMap = new Map<string, PluginConfig>();
    for (const row of rows) {
      configMap.set(row.plugin_name, {
        name: row.plugin_name,
        enabled: row.enabled,
        priority_override: row.priority_override,
        config: row.config ?? {},
      });
    }

    return configMap;
  }

  // ─── Persist audit log ─────────────────────────────────────────────────────
  private async persistAuditLog(
    results: InvoiceValidationResult[],
    context: InvoiceValidationContext,
    pipelineRunId: string
  ): Promise<void> {
    if (results.length === 0) return;

    // Build batch INSERT values
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const r of results) {
      placeholders.push(
        `($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`
      );
      values.push(
        uuidv4(),
        r.invoice_id,
        context.mst,
        context.declaration_period,
        context.direction,
        r.status,
        r.reason_codes,
        r.reason_detail ?? null,
        r.plugin_name,
      );
    }

    // Add pipeline_run_id as final param
    values.push(pipelineRunId);
    const runIdParam = `$${idx}`;

    await this.db.query(
      `INSERT INTO invoice_validation_log
         (id, invoice_id, mst, declaration_period, direction, status,
          reason_codes, reason_detail, plugin_name, validated_at, pipeline_run_id)
       VALUES ${placeholders.map(p => p.replace(/\)\s*$/, `, NOW(), ${runIdParam})`)).join(',')}`,
      values
    );
  }

  // ─── Main validate method ──────────────────────────────────────────────────
  async validate(
    invoices: InvoiceRow[],
    context: InvoiceValidationContext
  ): Promise<PipelineValidationOutput> {
    const pipelineRunId = uuidv4();

    if (invoices.length === 0) {
      return this.emptyOutput(pipelineRunId);
    }

    // Load DB config — fail gracefully (use defaults if DB unavailable)
    let configMap: Map<string, PluginConfig>;
    try {
      configMap = await this.loadPluginConfigs(context.mst);
    } catch {
      configMap = new Map();
    }

    // Filter plugins by direction and enabled status, then sort by priority
    const activePlugins = ALL_PLUGINS
      .filter(plugin => {
        if (plugin.appliesTo !== 'both' && plugin.appliesTo !== context.direction && context.direction !== 'both') {
          return false;
        }
        const cfg = configMap.get(plugin.name);
        // If no config found, use plugin default (assume enabled)
        if (cfg && !cfg.enabled) return false;
        return true;
      })
      .sort((a, b) => {
        const aPriority = configMap.get(a.name)?.priority_override ?? a.priority;
        const bPriority = configMap.get(b.name)?.priority_override ?? b.priority;
        return aPriority - bPriority;
      });

    // Track final status per invoice
    const excludedMap = new Map<string, InvoiceValidationResult>();
    // Warnings: can accumulate even for valid invoices (multiple plugins can warn)
    const warningMap = new Map<string, InvoiceValidationResult[]>();

    // Run each plugin sequentially in priority order
    for (const plugin of activePlugins) {
      // Only pass invoices not already excluded to this plugin
      const invoicesToCheck = invoices.filter(inv => !excludedMap.has(inv.id));
      if (invoicesToCheck.length === 0) break;

      const pluginConfig = configMap.get(plugin.name);

      let pluginResults: Map<string, InvoiceValidationResult>;
      try {
        pluginResults = await plugin.validateBatch(
          invoicesToCheck,
          context,
          this.db,
          pluginConfig
        );
      } catch (err) {
        // Plugin crash must not affect other plugins or the pipeline
        console.error(`[ValidationPipeline] Plugin "${plugin.name}" threw an error:`, err);
        continue;
      }

      for (const [invoiceId, result] of pluginResults) {
        if (result.status === 'excluded') {
          excludedMap.set(invoiceId, result);
          // Remove from warningMap if it was previously warned — now excluded
          warningMap.delete(invoiceId);
        } else if (result.status === 'warning' && !excludedMap.has(invoiceId)) {
          const existing = warningMap.get(invoiceId) ?? [];
          existing.push(result);
          warningMap.set(invoiceId, existing);
        }
      }
    }

    // Classify all invoices
    const validIds: string[] = [];
    const excludedResults: InvoiceValidationResult[] = [];
    const warningResults: InvoiceValidationResult[] = [];

    for (const inv of invoices) {
      if (excludedMap.has(inv.id)) {
        excludedResults.push(excludedMap.get(inv.id)!);
      } else {
        validIds.push(inv.id);
        // Collect warnings for valid invoices too
        const warns = warningMap.get(inv.id);
        if (warns) warningResults.push(...warns);
      }
    }

    // Build excluded_by_reason stats
    const excludedByReason: Partial<Record<ExclusionReasonCode, number>> = {};
    for (const r of excludedResults) {
      for (const code of r.reason_codes) {
        excludedByReason[code] = (excludedByReason[code] ?? 0) + 1;
      }
    }

    // Persist audit log (non-blocking — failure must not break declaration)
    const allResults = [...excludedResults, ...warningResults];
    this.persistAuditLog(allResults, context, pipelineRunId).catch(err => {
      console.error('[ValidationPipeline] Failed to persist audit log:', err);
    });

    return {
      valid_invoices: validIds,
      excluded_invoices: excludedResults,
      warning_invoices: warningResults,
      stats: {
        total: invoices.length,
        valid: validIds.length,
        excluded: excludedResults.length,
        warnings: warningResults.length,
        excluded_by_reason: excludedByReason,
      },
      pipeline_run_id: pipelineRunId,
    };
  }

  private emptyOutput(pipelineRunId: string): PipelineValidationOutput {
    return {
      valid_invoices: [],
      excluded_invoices: [],
      warning_invoices: [],
      stats: { total: 0, valid: 0, excluded: 0, warnings: 0, excluded_by_reason: {} },
      pipeline_run_id: pipelineRunId,
    };
  }
}
