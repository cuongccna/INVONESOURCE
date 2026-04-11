'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import apiClient, { setApiCompanyId, setApiViewContext, getApiViewContext } from '../lib/apiClient';

/**
 * Synchronously update BOTH _activeCompanyId and _viewContext.companyId in the
 * apiClient module so every subsequent request gets the correct X-Company-Id
 * header without waiting for React's ViewContext sync effect (which requires
 * 2+ render cycles and causes company data cross-contamination).
 */
function _syncApiCompany(id: string): void {
  setApiCompanyId(id);
  const ctx = getApiViewContext();
  if (ctx.mode === 'single') {
    setApiViewContext({ ...ctx, companyId: id });
  }
}

export interface CompanyInfo {
  id: string;
  name: string;
  tax_code: string;
  address: string;
  organization_id?: string | null;
  parent_id?: string | null;
  level?: number;
  entity_type?: 'company' | 'subsidiary' | 'branch';
  is_consolidated?: boolean;
  company_type: string;
  fiscal_year_start: number;
  onboarded: boolean;
  role: string;
  created_at: string;
}

interface CompanyContextValue {
  companies: CompanyInfo[];
  activeCompany: CompanyInfo | null;
  activeCompanyId: string | null;
  setActiveCompanyId: (id: string) => void;
  refreshCompanies: (overridePreferredId?: string) => Promise<void>;
  loading: boolean;
}

const CompanyContext = createContext<CompanyContextValue>({
  companies: [],
  activeCompany: null,
  activeCompanyId: null,
  setActiveCompanyId: () => undefined,
  refreshCompanies: async (_overridePreferredId?: string) => undefined,
  loading: true,
});

const STORAGE_KEY = 'activeCompanyId';

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [companies, setCompanies] = useState<CompanyInfo[]>([]);
  const [activeCompanyId, setActiveCompanyIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshCompanies = useCallback(async (overridePreferredId?: string) => {
    try {
      const res = await apiClient.get<{ data: CompanyInfo[] }>('/companies');
      const list = res.data.data;
      setCompanies(list);

      if (list.length > 0) {
        const stored = overridePreferredId ??
          (typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null);
        const preferred = list.find((c) => c.id === stored) ?? list[0];
        setActiveCompanyIdState(preferred.id);
        _syncApiCompany(preferred.id);
        if (typeof window !== 'undefined') {
          localStorage.setItem(STORAGE_KEY, preferred.id);
        }
      }
    } catch (e) {
      console.error('[CompanyContext] Failed to load companies', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCompanies();
  }, [refreshCompanies]);

  const setActiveCompanyId = useCallback(
    (id: string) => {
      const company = companies.find((c) => c.id === id);
      if (!company) return;
      setActiveCompanyIdState(id);
      _syncApiCompany(id);
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, id);
      }
    },
    [companies]
  );

  const activeCompany = companies.find((c) => c.id === activeCompanyId) ?? null;

  return (
    <CompanyContext.Provider
      value={{ companies, activeCompany, activeCompanyId, setActiveCompanyId, refreshCompanies, loading }}
    >
      {children}
    </CompanyContext.Provider>
  );
}

export const useCompany = (): CompanyContextValue => useContext(CompanyContext);
