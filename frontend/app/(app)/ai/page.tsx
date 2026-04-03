'use client';

import { useState, useRef, useEffect } from 'react';
import { getAccessToken, getApiCompanyId } from '../../../lib/apiClient';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Message {
  role: 'user' | 'model';
  content: string;
}

export default function AiChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', content: 'Xin chào! Tôi là trợ lý AI của HĐĐT. Tôi có thể giúp bạn về các câu hỏi liên quan đến thuế GTGT, hóa đơn điện tử và kê khai thuế. Bạn cần hỏi gì?' },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMessage: Message = { role: 'user', content: text };
    // Append user message and a placeholder assistant message for streaming
    setMessages((prev) => [...prev, userMessage, { role: 'model', content: '' }]);
    setInput('');
    setLoading(true);

    try {
      const history = messages.slice(-20);
      const token = getAccessToken();
      const companyId = getApiCompanyId();

      const response = await fetch(`${API_URL}/api/ai/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(companyId ? { 'X-Company-Id': companyId } : {}),
        },
        body: JSON.stringify({ message: text, history }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Stream request failed');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;

          try {
            const parsed = JSON.parse(payload) as { chunk?: string; error?: string };
            if (parsed.error) {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'model', content: `❌ ${parsed.error}` };
                return updated;
              });
              break;
            }
            if (parsed.chunk) {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: 'model',
                  content: updated[updated.length - 1].content + parsed.chunk,
                };
                return updated;
              });
            }
          } catch {
            // ignore JSON parse errors on partial chunks
          }
        }
      }
    } catch {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.role === 'model' && last.content === '') {
          updated[updated.length - 1] = { role: 'model', content: '❌ Lỗi kết nối. Vui lòng thử lại.' };
        }
        return updated;
      });
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const QUICK_QUESTIONS = [
    'Hóa đơn trên 20 triệu tiền mặt có được khấu trừ không?',
    'Hạn nộp tờ khai thuế GTGT tháng này là khi nào?',
    'Cách tính chỉ tiêu [41] trên tờ khai 01/GTGT?',
  ];

  return (
    <div className="flex flex-col h-[100dvh] max-h-[100dvh] bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <h1 className="text-lg font-bold text-gray-900">🤖 Trợ Lý AI Thuế</h1>
        <p className="text-xs text-gray-400">Gemini 1.5 Flash · Thuế GTGT & HĐĐT · Streaming</p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-primary-600 text-white rounded-br-sm'
                  : 'bg-white text-gray-900 shadow-sm rounded-bl-sm'
              }`}
            >
              {msg.content || (
                <div className="flex gap-1 items-center">
                  {[0, 1, 2].map((j) => (
                    <div key={j} className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: `${j * 0.15}s` }} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Quick Questions (only shown at start) */}
      {messages.length <= 1 && (
        <div className="px-4 pb-2">
          <p className="text-xs text-gray-400 mb-2">Câu hỏi gợi ý:</p>
          <div className="flex flex-col gap-2">
            {QUICK_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => { setInput(q); }}
                className="text-left text-xs bg-white border border-gray-200 rounded-xl px-3 py-2 text-gray-600"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="bg-white border-t border-gray-200 p-4 pb-safe">
        <div className="flex gap-2 items-end">
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Hỏi về thuế GTGT, hóa đơn..."
            className="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
            style={{ maxHeight: 120 }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || loading}
            className="w-10 h-10 bg-primary-600 text-white rounded-xl flex items-center justify-center disabled:opacity-50 shrink-0"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
