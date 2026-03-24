'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from '../lib/apiClient';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

const TYPE_ICONS: Record<string, string> = {
  SYNC_COMPLETE: '✅',
  INVALID_INVOICE: '⚠️',
  TAX_DEADLINE: '📅',
  CONNECTOR_ERROR: '🔴',
  VAT_ANOMALY: '🔍',
};

const TYPE_URLS: Record<string, string> = {
  SYNC_COMPLETE: '/invoices',
  INVALID_INVOICE: '/invoices',
  TAX_DEADLINE: '/declarations',
  CONNECTOR_ERROR: '/settings/connectors',
  VAT_ANOMALY: '/dashboard',
};

function timeAgo(dateStr: string): string {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'Vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return `${Math.floor(diff / 86400)} ngày trước`;
}

interface Props {
  onClose: () => void;
  onMarkAllRead: () => void;
}

export default function NotificationPanel({ onClose, onMarkAllRead }: Props) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{
        data: Notification[];
        meta: { total: number };
      }>('/notifications?pageSize=20');
      setNotifications(res.data.data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const markAllRead = async () => {
    try {
      await apiClient.patch('/notifications/read-all');
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      onMarkAllRead();
    } catch {
      // silent
    }
  };

  const handleClick = async (notif: Notification) => {
    if (!notif.is_read) {
      try {
        await apiClient.patch(`/notifications/${notif.id}/read`);
        setNotifications((prev) =>
          prev.map((n) => (n.id === notif.id ? { ...n, is_read: true } : n))
        );
      } catch {
        // silent
      }
    }
    const url = (notif.data?.url as string) ?? TYPE_URLS[notif.type] ?? '/dashboard';
    router.push(url);
    onClose();
  };

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div className="absolute top-full right-0 mt-2 w-80 bg-white rounded-xl shadow-lg border border-gray-100 overflow-hidden z-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <span className="text-sm font-semibold text-gray-900">
          Thông báo
          {unreadCount > 0 && (
            <span className="ml-1.5 bg-red-100 text-red-600 text-xs px-1.5 py-0.5 rounded-full">
              {unreadCount}
            </span>
          )}
        </span>
        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            className="text-xs text-primary-600 hover:underline"
          >
            Đọc tất cả
          </button>
        )}
      </div>

      {/* List */}
      <div className="max-h-[360px] overflow-y-auto divide-y divide-gray-50">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600" />
          </div>
        ) : notifications.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">
            Không có thông báo
          </div>
        ) : (
          notifications.map((n) => (
            <button
              key={n.id}
              onClick={() => void handleClick(n)}
              className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 ${
                !n.is_read ? 'bg-blue-50/40' : ''
              }`}
            >
              <span className="text-xl mt-0.5 flex-shrink-0">
                {TYPE_ICONS[n.type] ?? '🔔'}
              </span>
              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm leading-snug ${
                    !n.is_read ? 'font-semibold text-gray-900' : 'text-gray-700'
                  }`}
                >
                  {n.title}
                </p>
                <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{n.body}</p>
                <p className="text-xs text-gray-400 mt-1">{timeAgo(n.created_at)}</p>
              </div>
              {!n.is_read && (
                <span className="w-2 h-2 rounded-full bg-primary-500 flex-shrink-0 mt-1" />
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
