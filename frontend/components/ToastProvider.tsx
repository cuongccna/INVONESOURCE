'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

type ToastTone = 'success' | 'error' | 'warning' | 'info';

type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
  title?: string;
  duration: number;
};

type ToastInput = {
  message: string;
  title?: string;
  duration?: number;
};

type ToastApi = {
  show: (input: ToastInput & { tone?: ToastTone }) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const TONE_STYLE: Record<ToastTone, { ring: string; bg: string; title: string; icon: string }> = {
  success: {
    ring: 'ring-emerald-200',
    bg: 'from-emerald-50 to-white',
    title: 'text-emerald-800',
    icon: '✓',
  },
  error: {
    ring: 'ring-red-200',
    bg: 'from-red-50 to-white',
    title: 'text-red-800',
    icon: '!',
  },
  warning: {
    ring: 'ring-amber-200',
    bg: 'from-amber-50 to-white',
    title: 'text-amber-800',
    icon: '!',
  },
  info: {
    ring: 'ring-sky-200',
    bg: 'from-sky-50 to-white',
    title: 'text-sky-800',
    icon: 'i',
  },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((input: ToastInput & { tone?: ToastTone }) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const tone = input.tone ?? 'info';
    const duration = input.duration ?? 3200;

    setToasts((prev) => [...prev, {
      id,
      tone,
      title: input.title,
      message: input.message,
      duration,
    }]);

    window.setTimeout(() => remove(id), duration);
  }, [remove]);

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (message: string, title?: string) => show({ tone: 'success', message, title }),
    error: (message: string, title?: string) => show({ tone: 'error', message, title }),
    warning: (message: string, title?: string) => show({ tone: 'warning', message, title }),
    info: (message: string, title?: string) => show({ tone: 'info', message, title }),
  }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] px-4 sm:inset-x-auto sm:right-4 sm:top-auto sm:bottom-4 sm:w-[360px]">
        <div className="space-y-2">
          {toasts.map((toast) => {
            const style = TONE_STYLE[toast.tone];
            return (
              <div
                key={toast.id}
                className={`pointer-events-auto overflow-hidden rounded-2xl bg-gradient-to-br ${style.bg} shadow-lg ring-1 ${style.ring}`}
              >
                <div className="flex items-start gap-3 p-3.5">
                  <div className={`mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${style.title} bg-white`}>
                    {style.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    {toast.title && <p className={`text-sm font-semibold ${style.title}`}>{toast.title}</p>}
                    <p className="text-sm text-gray-700 break-words">{toast.message}</p>
                  </div>
                  <button
                    onClick={() => remove(toast.id)}
                    className="text-xs text-gray-400 hover:text-gray-700"
                    aria-label="Close notification"
                  >
                    x
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
