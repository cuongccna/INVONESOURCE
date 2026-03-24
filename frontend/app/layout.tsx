import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastProvider } from '../components/ToastProvider';

export const metadata: Metadata = {
  title: 'HĐĐT - Hóa Đơn Điện Tử',
  description: 'Nền tảng quản lý hóa đơn điện tử và kê khai thuế GTGT',
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
    apple: '/icons/icon-192x192.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'HĐĐT',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#2563eb',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
