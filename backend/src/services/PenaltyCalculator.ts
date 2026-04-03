/**
 * PenaltyCalculator — P50.3
 *
 * Calculates late filing interest and administrative penalties for supplemental
 * tax declarations.  Implements Vietnamese tax law:
 *   - Lãi chậm nộp:  0.03%/ngày × số ngày × số thuế  (Điều 59 Luật QLT)
 *   - Phạt hành chính: 2–5 triệu theo số ngày nộp trễ (Điều 13 NĐ125/2020)
 *   - Miễn phạt HC khi tự phát hiện trước thanh tra    (Khoản 4 Điều 125 Luật QLT)
 */

export const DAILY_RATE   = 0.0003;  // 0.03% per day

export interface PenaltyInput {
  taxAmount:          number;   // số thuế chênh lệch phải nộp thêm (VND)
  originalDeadline:   Date;     // ngày 20 của tháng sau kỳ khai
  paymentDate:        Date;     // ngày dự kiến nộp bổ sung
  hasPriorVoluntary:  boolean;  // true = tự phát hiện trước khi CQT kiểm tra
}

export interface PenaltyResult {
  taxAmount:       number;
  daysLate:        number;
  lateInterest:    number;
  adminPenalty:    number;       // 0 if hasPriorVoluntary
  totalPayable:    number;
  dailyAccrual:    number;       // interest added each additional day
  breakdown: {
    dailyRate: string;
    formula:   string;
  };
  recommendation: string;
}

export interface CostBenefitInput {
  taxDifference:      number;   // negative = taxpayer overpaid (will receive refund)
  originalDeadline:   Date;
  estimatedAuditRisk: 'low' | 'medium' | 'high';
}

export interface CostBenefitResult {
  shouldFile:              boolean;
  costIfFileNow:           number;
  expectedCostIfCaught:    number;  // 20% penalty if CQT finds it first
  savingsByFilingNow:      number;
  recommendation:          string;
}

export class PenaltyCalculator {

  calculate(input: PenaltyInput): PenaltyResult {
    const { taxAmount, originalDeadline, paymentDate, hasPriorVoluntary } = input;

    const daysLate = Math.max(
      0,
      Math.floor((paymentDate.getTime() - originalDeadline.getTime()) / (1000 * 60 * 60 * 24)),
    );

    const lateInterest = Math.round(taxAmount * DAILY_RATE * daysLate);
    const dailyAccrual = Math.round(taxAmount * DAILY_RATE);

    // Administrative penalty tiers (Điều 13 NĐ125/2020)
    // — only applies when NOT voluntarily self-disclosed
    let filingPenalty = 0;
    if (daysLate > 0) {
      if      (daysLate <= 30)  filingPenalty = 2_000_000;
      else if (daysLate <= 60)  filingPenalty = 3_000_000;
      else if (daysLate <= 90)  filingPenalty = 4_000_000;
      else                       filingPenalty = 5_000_000;
    }

    const adminPenalty  = hasPriorVoluntary ? 0 : filingPenalty;
    const totalPayable  = Math.round(taxAmount + lateInterest + adminPenalty);

    const fmtVND = (n: number): string =>
      new Intl.NumberFormat('vi-VN').format(n) + 'đ';

    return {
      taxAmount,
      daysLate,
      lateInterest,
      adminPenalty,
      totalPayable,
      dailyAccrual,
      breakdown: {
        dailyRate: `${(DAILY_RATE * 100).toFixed(2)}%/ngày`,
        formula:   `${fmtVND(taxAmount)} × 0.03%/ngày × ${daysLate} ngày = ${fmtVND(lateInterest)}`,
      },
      recommendation: this.buildRecommendation(
        daysLate, taxAmount, lateInterest, hasPriorVoluntary, adminPenalty,
      ),
    };
  }

  costBenefitAnalysis(input: CostBenefitInput): CostBenefitResult {
    const { taxDifference, originalDeadline, estimatedAuditRisk } = input;
    const today = new Date();
    const daysLate = Math.max(
      0,
      Math.floor((today.getTime() - originalDeadline.getTime()) / (1000 * 60 * 60 * 24)),
    );

    const currentInterest = Math.round(Math.abs(taxDifference) * DAILY_RATE * daysLate);
    const riskMultiplier  = { low: 1, medium: 3, high: 10 }[estimatedAuditRisk];
    // 20% penalty if CQT discovers the discrepancy first
    const auditPenalty    = Math.round(Math.abs(taxDifference) * 0.20 * riskMultiplier);

    if (taxDifference < 0) {
      // Taxpayer overpaid — always worth filing to get refund
      return {
        shouldFile:           true,
        costIfFileNow:        0,
        expectedCostIfCaught: 0,
        savingsByFilingNow:   Math.abs(taxDifference),
        recommendation:       `Nộp bổ sung ngay để nhận lại ${new Intl.NumberFormat('vi-VN').format(Math.abs(taxDifference))}đ thuế đã nộp thừa`,
      };
    }

    return {
      shouldFile:           true,
      costIfFileNow:        currentInterest,
      expectedCostIfCaught: taxDifference + auditPenalty,
      savingsByFilingNow:   Math.max(0, auditPenalty - currentInterest),
      recommendation:
        currentInterest < auditPenalty
          ? `Nên nộp bổ sung ngay: tiết kiệm ~${new Intl.NumberFormat('vi-VN').format(auditPenalty - currentInterest)}đ so với rủi ro bị thanh tra phát hiện`
          : `Cân nhắc nộp bổ sung để đảm bảo tuân thủ pháp luật`,
    };
  }

  /**
   * Auto-calculate the filing deadline for a given declaration period.
   * Returns the 20th of the month following the period.
   */
  static deadlineForPeriod(month: number, year: number): Date {
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear  = month === 12 ? year + 1 : year;
    return new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-20`);
  }

  private buildRecommendation(
    days: number,
    tax: number,
    interest: number,
    voluntary: boolean,
    adminPenalty: number,
  ): string {
    const fmtVND = (n: number) => new Intl.NumberFormat('vi-VN').format(n) + 'đ';

    if (days === 0) {
      return `✅ Chưa quá hạn — nộp bổ sung ngay để tránh phát sinh lãi`;
    }
    if (voluntary && days <= 30) {
      return `⚡ Nộp ngay: lãi chỉ ${fmtVND(interest)}, miễn phạt hành chính do tự phát hiện`;
    }
    if (!voluntary && adminPenalty > 0) {
      return `⚠️ Lãi ${fmtVND(interest)} + phạt hành chính ${fmtVND(adminPenalty)}.  Nộp sớm để dừng tính lãi.`;
    }
    if (days > 90) {
      return `🔴 Đã quá 90 ngày — lãi phạt đã tối đa.  Nộp bổ sung ngay để dừng tính lãi.`;
    }
    return `Nộp bổ sung sớm nhất có thể để giảm thiểu lãi phạt`;
  }
}

export const penaltyCalculator = new PenaltyCalculator();
