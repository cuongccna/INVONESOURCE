'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ViewMode } from 'shared';
import { setApiViewContext } from '../lib/apiClient';
import { useCompany } from './CompanyContext';

interface ViewContextValue {
  mode: ViewMode;
  orgId: string | null;
  companyId: string | null;
  setMode: (mode: ViewMode, options?: { orgId?: string | null; companyId?: string | null }) => void;
  setSingleCompany: (companyId: string) => void;
  setGroup: (orgId: string) => void;
  setPortfolio: () => void;
}

interface StoredViewContext {
  mode?: ViewMode;
  orgId?: string | null;
  companyId?: string | null;
}

const STORAGE_KEY = 'viewContext';

const ViewContext = createContext<ViewContextValue>({
  mode: 'single',
  orgId: null,
  companyId: null,
  setMode: () => undefined,
  setSingleCompany: () => undefined,
  setGroup: () => undefined,
  setPortfolio: () => undefined,
});

const readStoredContext = (): StoredViewContext | null => {
  if (typeof window === 'undefined') return null;

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as StoredViewContext;
  } catch {
    return null;
  }
};

export function ViewProvider({ children }: { children: ReactNode }) {
  const { companies, activeCompanyId } = useCompany();
  const [mode, setModeState] = useState<ViewMode>('single');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);

  useEffect(() => {
    const stored = readStoredContext();
    if (!stored?.mode) return;
    setModeState(stored.mode);
    setOrgId(stored.orgId ?? null);
    setCompanyId(stored.companyId ?? null);
  }, []);

  useEffect(() => {
    if (mode !== 'single') return;
    // In single mode, ViewContext.companyId MUST track CompanyContext.activeCompanyId.
    // Previous logic allowed a valid-but-stale localStorage company to block the sync,
    // causing every API request to send the wrong X-Company-Id header.
    if (!activeCompanyId || companyId === activeCompanyId) return;
    setCompanyId(activeCompanyId);
  }, [mode, companyId, activeCompanyId]);

  useEffect(() => {
    if (mode === 'group' && !orgId && companyId) {
      const fallbackOrgId = companies.find((c) => c.id === companyId)?.organization_id ?? null;
      if (fallbackOrgId) setOrgId(fallbackOrgId);
    }
  }, [mode, orgId, companyId, companies]);

  useEffect(() => {
    // localStorage stores the local companyId (used for UI restoration on next load).
    const payload: StoredViewContext = { mode, orgId, companyId };
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }

    // API routing MUST use the CONFIRMED activeCompanyId from CompanyContext in single mode.
    // NEVER fall back to the local `companyId` state here — it may be stale from localStorage
    // and belongs to a different company. When activeCompanyId is null (not yet resolved),
    // pass null so the interceptor falls back to _activeCompanyId (set synchronously by
    // CompanyContext._syncApiCompany before this effect ever fires with a non-null value).
    const apiCompanyId = mode === 'single' ? activeCompanyId : companyId;

    if (process.env.NODE_ENV !== 'production') {
      console.debug(
        `[ViewContext] persist mode=${mode}` +
        ` local=${companyId ?? 'null'}` +
        ` active=${activeCompanyId ?? 'null'}` +
        ` apiId=${apiCompanyId ?? 'null'}`
      );
    }

    setApiViewContext({ mode, orgId, companyId: apiCompanyId });
  }, [mode, orgId, companyId, activeCompanyId]);

  const setMode = useCallback(
    (nextMode: ViewMode, options?: { orgId?: string | null; companyId?: string | null }) => {
      setModeState(nextMode);
      if (nextMode === 'single') {
        setCompanyId(options?.companyId ?? activeCompanyId ?? null);
        setOrgId(null);
        return;
      }

      if (nextMode === 'group') {
        const fallbackOrgId = options?.orgId ?? companies.find((c) => c.id === (options?.companyId ?? companyId))?.organization_id ?? null;
        setOrgId(fallbackOrgId);
        return;
      }

      setOrgId(null);
    },
    [activeCompanyId, companies, companyId]
  );

  const setSingleCompany = useCallback((nextCompanyId: string) => {
    setModeState('single');
    setCompanyId(nextCompanyId);
    setOrgId(null);
  }, []);

  const setGroup = useCallback((nextOrgId: string) => {
    setModeState('group');
    setOrgId(nextOrgId);
  }, []);

  const setPortfolio = useCallback(() => {
    setModeState('portfolio');
    setOrgId(null);
  }, []);

  const value = useMemo(
    () => ({
      mode,
      orgId,
      companyId,
      setMode,
      setSingleCompany,
      setGroup,
      setPortfolio,
    }),
    [mode, orgId, companyId, setMode, setSingleCompany, setGroup, setPortfolio]
  );

  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

export const useView = (): ViewContextValue => useContext(ViewContext);
