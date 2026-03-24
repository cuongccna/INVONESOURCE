'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function GroupDashboardPage() {
  const params = useParams<{ orgId: string }>();
  const orgId = params.orgId;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <section className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-100 rounded-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Group View</p>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">Bao cao hop nhat theo nhom</h1>
        <p className="text-sm text-gray-600 mt-2">Organization ID: <span className="font-mono">{orgId}</span></p>
      </section>

      <section className="bg-white rounded-xl border border-gray-100 p-4">
        <p className="text-sm text-gray-600">
          Trang nay la diem vao cho dashboard hop nhat cap nhom. Cac KPI loai bo giao dich noi bo se duoc trien khai trong cac buoc tiep theo.
        </p>
        <div className="mt-3 flex gap-2">
          <Link href="/dashboard" className="px-3 py-1.5 rounded-lg bg-gray-100 text-sm text-gray-700 hover:bg-gray-200">
            Ve dashboard don vi
          </Link>
          <Link href="/reports" className="px-3 py-1.5 rounded-lg bg-primary-50 text-sm text-primary-700 hover:bg-primary-100">
            Xem bao cao
          </Link>
        </div>
      </section>
    </div>
  );
}
