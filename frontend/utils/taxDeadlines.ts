/**
 * taxDeadlines.ts
 *
 * Utility functions for Vietnamese VAT/GTGT tax deadline calculation.
 *
 * Legal basis: Điều 44 – Luật Quản lý thuế số 38/2019/QH14
 *
 * ┌─────────────┬────────────────┬──────────────────────────────────────────┐
 * │ Filing type │ Tax period     │ Deadline                                 │
 * ├─────────────┼────────────────┼──────────────────────────────────────────┤
 * │ Monthly     │ Month M/Y      │ Day 20 of month M+1 (or Jan of Y+1)      │
 * │ Quarterly   │ Q1  (Jan–Mar)  │ 30/04 same year                          │
 * │             │ Q2  (Apr–Jun)  │ 31/07 same year                          │
 * │             │ Q3  (Jul–Sep)  │ 31/10 same year                          │
 * │             │ Q4  (Oct–Dec)  │ 31/01 next year                          │
 * └─────────────┴────────────────┴──────────────────────────────────────────┘
 *
 * Timezone: all calculations are anchored to Vietnam wall-clock time (UTC+7)
 * to prevent off-by-one day bugs when users are active late at night.
 *
 * Dependencies: none — pure native Date arithmetic (no moment.js / date-fns).
 */

// ─── Internal constants ───────────────────────────────────────────────────────

/** Vietnam Standard Time offset: UTC+7 in milliseconds. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1_000;

/** Milliseconds in one calendar day. */
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * Deadline lookup for each quarter.
 * Key   = tax-period quarter (1–4).
 * Value = {month, day} of the last calendar day of the first month of the NEXT quarter.
 *
 * Note: months here never include February, so leap-year has no practical impact,
 * but `getQuarterlyDeadline` still calls `lastDayOfMonth()` for defensive correctness.
 */
const QUARTER_DEADLINE_MAP: Record<number, { month: number; day: number }> = {
  1: { month: 4,  day: 30 }, // Q1 (Jan–Mar) → last day of April  = 30/04
  2: { month: 7,  day: 31 }, // Q2 (Apr–Jun) → last day of July   = 31/07
  3: { month: 10, day: 31 }, // Q3 (Jul–Sep) → last day of October = 31/10
  4: { month: 1,  day: 31 }, // Q4 (Oct–Dec) → last day of January = 31/01 (year + 1)
};

// ─── Types ────────────────────────────────────────────────────────────────────

/** Decomposed calendar date — avoids timezone ambiguity in intermediate steps. */
interface CalDate {
  year:  number;
  month: number; // 1-based (Jan = 1)
  day:   number;
}

/** Result returned by checkDeadlineStatus. */
export interface DeadlineStatus {
  /** The deadline date object (midnight VN time as UTC timestamp). */
  deadline: Date;
  /**
   * Integer days remaining until the deadline.
   *  > 0 : future — N days left.
   *  = 0 : due today.
   *  < 0 : overdue — N days past due.
   */
  daysLeft: number;
  /** True when `daysLeft < 0`. */
  isOverdue: boolean;
  /** True when `daysLeft === 0`. */
  isTodayDeadline: boolean;
  /**
   * True when `0 <= daysLeft <= warningDays`.
   * Indicates the deadline is imminent and user should be alerted.
   */
  isWarning: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Returns the current wall-clock date in Vietnam (UTC+7).
 *
 * Correctly handles the edge case where it is already the next calendar day
 * in Vietnam but still the previous day in UTC (e.g. 22:00 UTC = 05:00 VN +1).
 */
function getTodayVN(): CalDate {
  const vnMs  = Date.now() + VN_OFFSET_MS;
  const vnDate = new Date(vnMs);
  return {
    year:  vnDate.getUTCFullYear(),
    month: vnDate.getUTCMonth() + 1, // getUTCMonth() is 0-based
    day:   vnDate.getUTCDate(),
  };
}

/**
 * Constructs a Date object representing midnight of the given date in Vietnam time.
 *
 * Stored as a UTC timestamp so it serializes and transmits correctly.
 * VN midnight 00:00+07:00 = previous calendar day 17:00 UTC.
 *
 * @example toVNMidnight(2026, 4, 30) → Date("2026-04-29T17:00:00.000Z")
 */
function toVNMidnight(year: number, month: number, day: number): Date {
  // Date.UTC gives midnight UTC; subtracting 7 h shifts to VN midnight.
  return new Date(Date.UTC(year, month - 1, day) - VN_OFFSET_MS);
}

/**
 * Extracts the Vietnam local date components from a Date object.
 * The inverse of toVNMidnight.
 */
function fromVNDate(d: Date): CalDate {
  const shifted = new Date(d.getTime() + VN_OFFSET_MS);
  return {
    year:  shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day:   shifted.getUTCDate(),
  };
}

/**
 * Returns the last calendar day of the given month.
 *
 * Implementation: Date overflows gracefully — day 0 of month M+1 equals the last day of M.
 * Handles February in leap years automatically.
 *
 * @example lastDayOfMonth(2024, 2) → 29  (2024 is a leap year)
 * @example lastDayOfMonth(2026, 4) → 30
 */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Computes the signed integer number of calendar days between two CalDate objects.
 *
 * Uses UTC epoch arithmetic (day-serial numbers) which is immune to DST
 * and avoids floating-point precision issues from raw millisecond subtraction.
 *
 * @returns Positive if `to` is after `from`, negative if before, 0 if same day.
 */
function daysBetween(from: CalDate, to: CalDate): number {
  const fromMs = Date.UTC(from.year, from.month - 1, from.day);
  const toMs   = Date.UTC(to.year,   to.month   - 1, to.day);
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

// ─── Core exports ─────────────────────────────────────────────────────────────

/**
 * Returns the VAT monthly filing deadline for a given tax period.
 *
 * Rule: Hạn nộp tờ khai GTGT theo tháng = ngày 20 tháng dương lịch tiếp theo.
 *
 * @param month  Tax period month, 1–12.  (e.g. 4 = April tax period)
 * @param year   Tax period year.          (e.g. 2026)
 * @returns      Date representing 20/(month+1)/year at midnight VN time.
 *
 * @throws RangeError if `month` is outside 1–12.
 *
 * @example
 * getMonthlyDeadline(4, 2026)  // April 2026 period  → Date for 20/05/2026
 * getMonthlyDeadline(12, 2026) // December 2026 period → Date for 20/01/2027
 */
export function getMonthlyDeadline(month: number, year: number): Date {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(
      `[getMonthlyDeadline] month must be an integer 1–12, received: ${month}`,
    );
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new RangeError(
      `[getMonthlyDeadline] year must be an integer 2000–2100, received: ${year}`,
    );
  }

  const deadlineMonth = month === 12 ? 1        : month + 1;
  const deadlineYear  = month === 12 ? year + 1 : year;

  return toVNMidnight(deadlineYear, deadlineMonth, 20);
}

/**
 * Returns the VAT quarterly filing deadline for a given tax period.
 *
 * Rule: Hạn nộp tờ khai GTGT theo quý = ngày cuối cùng của tháng đầu tiên
 * của quý dương lịch tiếp theo.
 *
 * | Quarter | Tax period  | Deadline          |
 * |---------|-------------|-------------------|
 * | Q1      | Jan – Mar   | 30/04 (same year) |
 * | Q2      | Apr – Jun   | 31/07 (same year) |
 * | Q3      | Jul – Sep   | 31/10 (same year) |
 * | Q4      | Oct – Dec   | 31/01 (next year) |
 *
 * @param quarter  Tax period quarter, 1–4.
 * @param year     Tax period year.
 * @returns        Date representing the last day of the deadline month at midnight VN time.
 *
 * @throws RangeError if `quarter` is outside 1–4.
 *
 * @example
 * getQuarterlyDeadline(1, 2026) // Q1 2026 → Date for 30/04/2026
 * getQuarterlyDeadline(4, 2026) // Q4 2026 → Date for 31/01/2027
 */
export function getQuarterlyDeadline(quarter: number, year: number): Date {
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new RangeError(
      `[getQuarterlyDeadline] quarter must be an integer 1–4, received: ${quarter}`,
    );
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new RangeError(
      `[getQuarterlyDeadline] year must be an integer 2000–2100, received: ${year}`,
    );
  }

  const { month, day } = QUARTER_DEADLINE_MAP[quarter]!;
  const deadlineYear = quarter === 4 ? year + 1 : year;

  // Recalculate the actual last day of the deadline month for defensive correctness.
  // (Practically identical to `day` for months 1/4/7/10, but handles leap-year edge-cases.)
  const actualLastDay = Math.min(day, lastDayOfMonth(deadlineYear, month));

  return toVNMidnight(deadlineYear, month, actualLastDay);
}

/**
 * Evaluates the status of a deadline relative to a reference date.
 *
 * @param deadline     A Date produced by getMonthlyDeadline / getQuarterlyDeadline.
 * @param warningDays  How many days before the deadline to set `isWarning = true`.
 *                     Default: 7 days.  Pass 5 for a tighter alert window.
 * @param currentDate  Override "today" — useful in unit tests or server-side rendering.
 *                     When omitted, uses the current Vietnam wall-clock date.
 * @returns            {@link DeadlineStatus} with all computed flags and `daysLeft`.
 *
 * @example
 * const status = checkDeadlineStatus(getQuarterlyDeadline(1, 2026), 7);
 * // today = 2026-04-26 → Q1 deadline = 30/04/2026 → daysLeft = 4 → isWarning = true
 *
 * if (status.isOverdue)        alert('Đã quá hạn nộp tờ khai!');
 * else if (status.isWarning)   alert(`Còn ${status.daysLeft} ngày — hãy nộp sớm!`);
 */
export function checkDeadlineStatus(
  deadline: Date,
  warningDays = 7,
  currentDate?: Date,
): DeadlineStatus {
  if (warningDays < 0) {
    throw new RangeError(`[checkDeadlineStatus] warningDays must be >= 0, received: ${warningDays}`);
  }

  const today    = currentDate ? fromVNDate(currentDate) : getTodayVN();
  const deadlineCal = fromVNDate(deadline);
  const daysLeft = daysBetween(today, deadlineCal);

  return {
    deadline,
    daysLeft,
    isOverdue:       daysLeft < 0,
    isTodayDeadline: daysLeft === 0,
    isWarning:       daysLeft >= 0 && daysLeft <= warningDays,
  };
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

/**
 * Combines getMonthlyDeadline + checkDeadlineStatus into a single call.
 *
 * @example
 * const { daysLeft, isWarning } = getMonthlyDeadlineStatus(5, 2026, 5);
 */
export function getMonthlyDeadlineStatus(
  month: number,
  year: number,
  warningDays = 7,
): DeadlineStatus {
  return checkDeadlineStatus(getMonthlyDeadline(month, year), warningDays);
}

/**
 * Combines getQuarterlyDeadline + checkDeadlineStatus into a single call.
 *
 * @example
 * const { isOverdue } = getQuarterlyDeadlineStatus(4, 2025); // Q4 2025 → 31/01/2026
 */
export function getQuarterlyDeadlineStatus(
  quarter: number,
  year: number,
  warningDays = 7,
): DeadlineStatus {
  return checkDeadlineStatus(getQuarterlyDeadline(quarter, year), warningDays);
}

/**
 * Returns which quarter (1–4) a given month belongs to.
 *
 * @example monthToQuarter(1)  // → 1 (Q1)
 * @example monthToQuarter(7)  // → 3 (Q3)
 * @example monthToQuarter(12) // → 4 (Q4)
 */
export function monthToQuarter(month: number): 1 | 2 | 3 | 4 {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`[monthToQuarter] month must be 1–12, received: ${month}`);
  }
  return Math.ceil(month / 3) as 1 | 2 | 3 | 4;
}

// Named re-exports of internal helpers — useful for server-side deadline generation
// and for components that need to format dates in VN timezone.
export { toVNMidnight, fromVNDate, lastDayOfMonth };
