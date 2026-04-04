'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';

interface SyncContextType {
  syncJobIds: string[];
  syncCompanyId: string;
  isSyncing: boolean;
  startSync: (jobIds: string[], companyId: string) => void;
  clearSync: () => void;
}

const SyncContext = createContext<SyncContextType | null>(null);

const STORAGE_KEY = 'syncState';

export function SyncProvider({ children }: { children: ReactNode }) {
  const [syncJobIds, setSyncJobIds] = useState<string[]>([]);
  const [syncCompanyId, setSyncCompanyId] = useState<string>('');

  // Restore in-progress sync after hard refresh (client-only, inside useEffect to avoid SSR mismatch)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { jobIds: string[]; companyId: string; startedAt?: number };
        // Auto-clear state older than 35 minutes — sync must have finished already
        const age = Date.now() - (parsed.startedAt ?? 0);
        if (age > 35 * 60 * 1000) {
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        if (Array.isArray(parsed.jobIds) && parsed.jobIds.length > 0) {
          setSyncJobIds(parsed.jobIds);
          setSyncCompanyId(parsed.companyId ?? '');
        }
      }
    } catch { /* ignore */ }
  }, []);

  const startSync = useCallback((jobIds: string[], companyId: string) => {
    setSyncJobIds(jobIds);
    setSyncCompanyId(companyId);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobIds, companyId, startedAt: Date.now() }));
    } catch { /* ignore */ }
  }, []);

  const clearSync = useCallback(() => {
    setSyncJobIds([]);
    setSyncCompanyId('');
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  return (
    <SyncContext.Provider value={{
      syncJobIds,
      syncCompanyId,
      isSyncing: syncJobIds.length > 0,
      startSync,
      clearSync,
    }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSyncContext() {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSyncContext must be used within SyncProvider');
  return ctx;
}
