'use client';

import Link from 'next/link';

export default function PortfolioPage() {
  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <section className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-100 rounded-2xl p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Portfolio View</p>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">Tong quan toan bo doanh nghiep</h1>
        <p className="text-sm text-gray-600 mt-2">
          Day la che do tong hop danh muc. Cac API va dashboard hop nhat se duoc bo sung theo lo trinh Group 17.
        </p>
      </section>

      <section className="bg-white rounded-xl border border-gray-100 p-4">
        <h2 className="text-sm font-semibold text-gray-800">Truy cap nhanh</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/dashboard" className="px-3 py-1.5 rounded-lg bg-gray-100 text-sm text-gray-700 hover:bg-gray-200">
            Ve dashboard don vi
          </Link>
          <Link href="/reports" className="px-3 py-1.5 rounded-lg bg-primary-50 text-sm text-primary-700 hover:bg-primary-100">
            Mo bao cao
          </Link>
          <Link href="/settings/companies" className="px-3 py-1.5 rounded-lg bg-emerald-50 text-sm text-emerald-700 hover:bg-emerald-100">
            Quan ly cong ty
          </Link>
        </div>
      </section>
    </div>
  );
}
