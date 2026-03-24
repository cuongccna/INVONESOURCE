import ClientLayout from '../../components/ClientLayout';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ClientLayout>{children}</ClientLayout>;
}
