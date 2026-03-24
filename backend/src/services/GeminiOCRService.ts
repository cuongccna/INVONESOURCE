import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { NormalizedInvoice } from 'shared';

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

/**
 * GeminiOCRService — extracts invoice data from scanned images using Gemini 1.5 Flash
 */
export class GeminiOCRService {
  private model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  async extractInvoiceFromImage(
    imageBuffer: Buffer,
    mimeType: string
  ): Promise<Partial<NormalizedInvoice> | null> {
    const base64 = imageBuffer.toString('base64');

    const prompt = `Extract all fields from this Vietnamese VAT invoice (hóa đơn GTGT).
Return JSON only (no markdown, no explanation):
{
  "invoiceNumber": "string",
  "serialNumber": "string",
  "issuedDate": "ISO date string",
  "sellerTaxCode": "string",
  "sellerName": "string",
  "buyerTaxCode": "string",
  "buyerName": "string",
  "subtotal": number,
  "vatRate": number,
  "vatAmount": number,
  "total": number,
  "currency": "VND"
}
If a field is not visible, use null. Return ONLY the JSON object.`;

    try {
      const result = await this.model.generateContent([
        {
          inlineData: {
            mimeType,
            data: base64,
          },
        },
        prompt,
      ]);

      const text = result.response.text().trim();
      // Strip markdown code fences if present
      const jsonText = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;

      return {
        invoiceNumber: String(parsed['invoiceNumber'] ?? ''),
        serialNumber: String(parsed['serialNumber'] ?? ''),
        issuedDate: parsed['issuedDate'] ? new Date(String(parsed['issuedDate'])) : new Date(),
        sellerTaxCode: String(parsed['sellerTaxCode'] ?? ''),
        sellerName: String(parsed['sellerName'] ?? ''),
        buyerTaxCode: String(parsed['buyerTaxCode'] ?? ''),
        buyerName: String(parsed['buyerName'] ?? ''),
        subtotal: Number(parsed['subtotal'] ?? 0),
        vatRate: Number(parsed['vatRate'] ?? 0),
        vatAmount: Number(parsed['vatAmount'] ?? 0),
        total: Number(parsed['total'] ?? 0),
        currency: 'VND',
      };
    } catch (err) {
      console.warn('[GeminiOCR] Failed to parse response:', err);
      return null;
    }
  }
}

export const geminiOCRService = new GeminiOCRService();
