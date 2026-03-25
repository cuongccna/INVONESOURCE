import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { pool } from '../db/pool';

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

/**
 * GeminiChatService — AI assistant for Vietnamese tax questions.
 * Provides context about the company's invoice data for each query.
 */
export class GeminiChatService {
  private model = genAI.getGenerativeModel({ model: env.GEMINI_MODEL });

  async chat(
    companyId: string,
    userMessage: string,
    history: ChatMessage[] = []
  ): Promise<string> {
    const chat = await this.buildChat(companyId, history);
    const result = await chat.sendMessage(userMessage);
    return result.response.text();
  }

  async *streamChat(
    companyId: string,
    userMessage: string,
    history: ChatMessage[] = []
  ): AsyncGenerator<string> {
    const chat = await this.buildChat(companyId, history);
    const result = await chat.sendMessageStream(userMessage);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
  }

  private async buildChat(companyId: string, history: ChatMessage[]) {
    const context = await this.buildContext(companyId);

    const systemPrompt = `Bạn là trợ lý kế toán thuế hóa đơn điện tử (HĐĐT) AI cho doanh nghiệp Việt Nam.
Bạn có kiến thức về Luật Thuế GTGT, TT80/2021, TT68/2019 và quy trình hóa đơn điện tử.
Chỉ trả lời các câu hỏi liên quan đến thuế, kế toán, hóa đơn. 
Từ chối lịch sự các câu hỏi không liên quan.
Trả lời bằng tiếng Việt, ngắn gọn và chính xác.

DỮ LIỆU DOANH NGHIỆP HIỆN TẠI:
${context}`;

    const chatHistory = history.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.content }],
    }));

    return this.model.startChat({
      history: [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: 'Tôi hiểu. Tôi sẽ hỗ trợ bạn về các vấn đề thuế GTGT và hóa đơn điện tử.' }] },
        ...chatHistory,
      ],
    });
  }

  private async buildContext(companyId: string): Promise<string> {
    try {
      // Get current period (current month)
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();

      const [companyResult, reconciliationResult] = await Promise.all([
        pool.query<{ name: string; tax_code: string }>(
          'SELECT name, tax_code FROM companies WHERE id = $1',
          [companyId]
        ),
        pool.query<{
          output_vat: string; input_vat: string; payable_vat: string;
        }>(
          `SELECT output_vat, input_vat, payable_vat FROM vat_reconciliations
           WHERE company_id = $1 AND period_month = $2 AND period_year = $3`,
          [companyId, month, year]
        ),
      ]);

      const company = companyResult.rows[0];
      const vat = reconciliationResult.rows[0];

      if (!company) return 'Không tìm thấy thông tin doanh nghiệp.';

      let ctx = `Doanh nghiệp: ${company.name} (MST: ${company.tax_code})\n`;
      ctx += `Kỳ kê khai hiện tại: Tháng ${month}/${year}\n`;

      if (vat) {
        ctx += `Thuế GTGT đầu ra: ${Number(vat.output_vat).toLocaleString('vi-VN')}đ\n`;
        ctx += `Thuế GTGT đầu vào được khấu trừ: ${Number(vat.input_vat).toLocaleString('vi-VN')}đ\n`;
        ctx += `Thuế GTGT phải nộp: ${Number(vat.payable_vat).toLocaleString('vi-VN')}đ\n`;
      }

      return ctx;
    } catch {
      return 'Dữ liệu doanh nghiệp không khả dụng.';
    }
  }
}

export const geminiChatService = new GeminiChatService();
