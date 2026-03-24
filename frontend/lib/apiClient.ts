import axios, { AxiosInstance, AxiosResponse } from 'axios';
import type { ViewMode } from 'shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Store access token in memory only — never localStorage (XSS risk)
let _accessToken: string | null = null;
export const setAccessToken = (t: string | null): void => { _accessToken = t; };
export const getAccessToken = (): string | null => _accessToken;

// Active company ID — sent as X-Company-Id header for multi-company support
let _activeCompanyId: string | null = null;
export const setApiCompanyId = (id: string | null): void => { _activeCompanyId = id; };
export const getApiCompanyId = (): string | null => _activeCompanyId;

interface ApiViewContext {
  mode: ViewMode;
  orgId?: string | null;
  companyId?: string | null;
}

let _viewContext: ApiViewContext = { mode: 'single', orgId: null, companyId: null };

export const setApiViewContext = (ctx: ApiViewContext): void => {
  _viewContext = {
    mode: ctx.mode,
    orgId: ctx.orgId ?? null,
    companyId: ctx.companyId ?? null,
  };

  // Backward compatibility for endpoints that still rely on X-Company-Id.
  if (_viewContext.mode === 'single') {
    _activeCompanyId = _viewContext.companyId ?? _activeCompanyId;
  }
};

export const getApiViewContext = (): ApiViewContext => _viewContext;

export const apiClient: AxiosInstance = axios.create({
  baseURL: `${API_URL}/api`,
  withCredentials: true, // send HTTP-only refresh token cookie
  headers: { 'Content-Type': 'application/json' },
});

// Attach in-memory access token and active company on each request
apiClient.interceptors.request.use((config) => {
  if (_accessToken) {
    config.headers.Authorization = `Bearer ${_accessToken}`;
  }

  config.headers['X-View-Mode'] = _viewContext.mode;

  if (_viewContext.orgId) {
    config.headers['X-Organization-Id'] = _viewContext.orgId;
  }

  const singleCompanyId = _viewContext.mode === 'single'
    ? (_viewContext.companyId ?? _activeCompanyId)
    : _activeCompanyId;

  if (singleCompanyId) {
    config.headers['X-Company-Id'] = singleCompanyId;
  }
  return config;
});

// On 401 → try to refresh, then retry once
let refreshing = false;
apiClient.interceptors.response.use(
  (res: AxiosResponse) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry && !refreshing) {
      original._retry = true;
      refreshing = true;
      try {
        const res = await axios.post<{ data: { accessToken: string } }>(
          `${API_URL}/api/auth/refresh`,
          {},
          { withCredentials: true }
        );
        const token = res.data.data.accessToken;
        setAccessToken(token);
        original.headers.Authorization = `Bearer ${token}`;
        return apiClient(original);
      } catch {
        setAccessToken(null);
        window.location.href = '/login';
      } finally {
        refreshing = false;
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
