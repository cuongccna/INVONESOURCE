/**
 * formatCurrency.ts — Single source of truth for all VND formatting.
 * Use these functions everywhere in the app instead of ad-hoc toLocaleString / toFixed.
 */

/**
 * Format VND with smart scaling:
 *   >= 1 nghìn tỷ (1e12)  → "1.5 nghìn tỷ"
 *   >= 1 tỷ (1e9)         → "1.5 tỷ"
 *   >= 1 triệu (1e6)      → "1.5 Tr"
 *   < 1 triệu             → "999.999đ"  (dot-separated, vi-VN locale)
 */
export function formatVND(amount: number | string | null | undefined): string {
  const n = Number(amount);
  if (!isFinite(n) || isNaN(n)) return '0đ';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  if (abs >= 1_000_000_000_000) {
    const val = abs / 1_000_000_000_000;
    return `${sign}${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)} nghìn tỷ`;
  }
  if (abs >= 1_000_000_000) {
    const val = abs / 1_000_000_000;
    return `${sign}${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)} tỷ`;
  }
  if (abs >= 1_000_000) {
    const val = abs / 1_000_000;
    return `${sign}${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)} Tr`;
  }
  return `${sign}${Math.round(abs).toLocaleString('vi-VN')}đ`;
}

/**
 * Short label for chart Y-axis ticks (no spaces, concise):
 *   >= 1e12 → "1nghìntỷ"
 *   >= 1e9  → "1Tỷ"
 *   >= 1e6  → "1Tr"
 *   >= 1e3  → "1K"
 *   else    → raw number
 */
export function formatVNDShort(amount: number | string | null | undefined): string {
  const n = Number(amount);
  if (!isFinite(n) || isNaN(n)) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  if (abs >= 1_000_000_000_000) return `${sign}${(abs / 1_000_000_000_000).toFixed(0)}nghìntỷ`;
  if (abs >= 1_000_000_000)     return `${sign}${(abs / 1_000_000_000).toFixed(0)}Tỷ`;
  if (abs >= 1_000_000)         return `${sign}${(abs / 1_000_000).toFixed(0)}Tr`;
  if (abs >= 1_000)             return `${sign}${(abs / 1_000).toFixed(0)}K`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * Full unscaled display in tables (dot-separated, no abbreviation):
 *   1000000 → "1.000.000đ"
 */
export function formatVNDFull(amount: number | string | null | undefined): string {
  const n = Number(amount);
  if (!isFinite(n) || isNaN(n)) return '0đ';
  return `${Math.round(n).toLocaleString('vi-VN')}đ`;
}

/**
 * Compact format for small UI badges — same as formatVND but with "₫" sign.
 */
export function formatVNDCompact(amount: number | string | null | undefined): string {
  const n = Number(amount);
  if (!isFinite(n) || isNaN(n)) return '0₫';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  if (abs >= 1_000_000_000_000) return `${sign}${(abs / 1_000_000_000_000).toFixed(1).replace(/\.0$/, '')} nghìn tỷ₫`;
  if (abs >= 1_000_000_000)     return `${sign}${(abs / 1_000_000_000).toFixed(1).replace(/\.0$/, '')} tỷ₫`;
  if (abs >= 1_000_000)         return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, '')} Tr₫`;
  return `${sign}${Math.round(abs).toLocaleString('vi-VN')}₫`;
}
