'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../../lib/apiClient';

type TelegramEvent = 'debt_due' | 'vat_deadline' | 'price_increase' | 'sync_error' | 'new_declaration';

interface TelegramChatConfig {
  id: string;
  chat_id: string;
  chat_type: 'private' | 'group';
  subscribed_events: TelegramEvent[];
  is_active: boolean;
  created_at: string;
}

const EVENT_LABELS: Record<TelegramEvent, string> = {
  debt_due: '💰 Nợ đến hạn',
  vat_deadline: '📅 Hạn thuế GTGT',
  price_increase: '⚠️ Giá NCC tăng',
  sync_error: '❌ Đồng bộ lỗi',
  new_declaration: '📊 Tờ khai mới',
};
const ALL_EVENTS = Object.keys(EVENT_LABELS) as TelegramEvent[];

export default function TelegramSettingsPage() {
  const [configs, setConfigs] = useState<TelegramChatConfig[]>([]);
  const [botEnabled, setBotEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  // Add form
  const [newChatId, setNewChatId] = useState('');
  const [newChatType, setNewChatType] = useState<'private' | 'group'>('private');
  const [newEvents, setNewEvents] = useState<TelegramEvent[]>(ALL_EVENTS);
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const r = await apiClient.get<{ data: { configs: TelegramChatConfig[]; bot_enabled: boolean } }>('/telegram/configs');
      setConfigs(r.data.data.configs);
      setBotEnabled(r.data.data.bot_enabled);
    } catch { /* silent */ } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const toggleEvent = (ev: TelegramEvent) => {
    setNewEvents((prev) => prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]);
  };

  const addConfig = async () => {
    setError('');
    if (!newChatId.trim()) { setError('Nhập Chat ID'); return; }
    setAdding(true);
    try {
      await apiClient.post('/telegram/configs', {
        chat_id: newChatId.trim(),
        chat_type: newChatType,
        subscribed_events: newEvents,
      });
      setNewChatId('');
      await load();
    } catch { setError('Không thể thêm, kiểm tra Chat ID'); }
    finally { setAdding(false); }
  };

  const sendTest = async (chatId: string) => {
    setTestingId(chatId);
    try {
      await apiClient.post('/telegram/test', { chat_id: chatId });
      alert('✅ Đã gửi tin thử thành công!');
    } catch { alert('❌ Gửi thất bại — kiểm tra BOT_TOKEN hoặc Chat ID'); }
    finally { setTestingId(null); }
  };

  const toggleActive = async (chatId: string, current: boolean) => {
    await apiClient.patch(`/telegram/configs/${chatId}/toggle`, { is_active: !current });
    await load();
  };

  const deleteConfig = async (chatId: string) => {
    if (!confirm('Xóa kết nối Telegram này?')) return;
    await apiClient.delete(`/telegram/configs/${chatId}`);
    setConfigs((prev) => prev.filter((c) => c.chat_id !== chatId));
  };

  return (
    <div className="p-4 max-w-lg mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Thông Báo Telegram</h1>
        <p className="text-sm text-gray-500 mt-0.5">Nhận cảnh báo tức thì qua Telegram</p>
      </div>

      {!botEnabled && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          <p className="font-semibold mb-1">⚙️ Bot chưa được cấu hình</p>
          <p>Thêm <code className="font-mono bg-amber-100 px-1 rounded">TELEGRAM_BOT_TOKEN</code> vào file <code className="font-mono bg-amber-100 px-1 rounded">.env</code> để bật tính năng này.</p>
          <p className="mt-1">Tạo bot: chat với <span className="font-semibold">@BotFather</span> trên Telegram → <code>/newbot</code></p>
        </div>
      )}

      {/* How to find chat ID */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800 space-y-1">
        <p className="font-semibold">📋 Cách lấy Chat ID</p>
        <ol className="list-decimal ml-4 space-y-0.5 text-xs text-blue-700">
          <li>Mở Telegram, tìm và chat với bot <span className="font-semibold">@userinfobot</span></li>
          <li>Gõ bất kỳ tin nhắn nào — bot sẽ trả về Chat ID của bạn</li>
          <li>Với nhóm: thêm bot vào nhóm, sau đó gửi tin nhắn trong nhóm và dùng bot @userinfobot để lấy ID của nhóm</li>
        </ol>
      </div>

      {/* Add new config */}
      <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Thêm Chat/Nhóm Mới</h2>

        <div className="flex gap-2">
          <input
            value={newChatId}
            onChange={(e) => setNewChatId(e.target.value)}
            placeholder="Chat ID (ví dụ: 123456789)"
            className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <select value={newChatType} onChange={(e) => setNewChatType(e.target.value as 'private' | 'group')}
            className="text-sm border border-gray-200 rounded-lg px-2 py-2">
            <option value="private">Cá nhân</option>
            <option value="group">Nhóm</option>
          </select>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-gray-500">Sự kiện nhận thông báo:</p>
          <div className="flex flex-wrap gap-2">
            {ALL_EVENTS.map((ev) => (
              <button key={ev} onClick={() => toggleEvent(ev)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  newEvents.includes(ev)
                    ? 'bg-primary-600 text-white border-primary-600'
                    : 'border-gray-200 text-gray-500 hover:border-gray-400'
                }`}>
                {EVENT_LABELS[ev]}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <button onClick={addConfig} disabled={adding || !botEnabled}
          className="w-full py-2 text-sm font-semibold rounded-lg bg-primary-600 text-white disabled:opacity-50 hover:bg-primary-700">
          {adding ? 'Đang thêm…' : '+ Thêm kết nối'}
        </button>
      </div>

      {/* Config list */}
      {loading ? (
        <div className="flex justify-center py-6">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-500" />
        </div>
      ) : configs.length === 0 ? (
        <p className="text-center text-sm text-gray-400 py-4">Chưa có kết nối Telegram nào</p>
      ) : (
        <div className="space-y-3">
          {configs.map((c) => (
            <div key={c.id} className={`bg-white rounded-xl shadow-sm p-4 border-l-4 ${c.is_active ? 'border-green-400' : 'border-gray-200'}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {c.chat_type === 'group' ? '👥' : '👤'} ID: {c.chat_id}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{c.chat_type === 'group' ? 'Nhóm' : 'Cá nhân'}</p>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {c.subscribed_events.map((ev) => (
                      <span key={ev} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {EVENT_LABELS[ev]}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1 items-end shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${c.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {c.is_active ? 'Đang bật' : 'Tắt'}
                  </span>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={() => sendTest(c.chat_id)} disabled={testingId === c.chat_id || !botEnabled}
                  className="text-xs px-3 py-1.5 rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50 disabled:opacity-50">
                  {testingId === c.chat_id ? 'Đang gửi…' : '📤 Gửi thử'}
                </button>
                <button onClick={() => toggleActive(c.chat_id, c.is_active)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                  {c.is_active ? 'Tắt' : 'Bật'}
                </button>
                <button onClick={() => deleteConfig(c.chat_id)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50">
                  Xóa
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
