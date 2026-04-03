const NAV_HISTORY_KEY = 'invone_nav_history_v1';
const MAX_HISTORY_ITEMS = 80;

const canUseSessionStorage = (): boolean => {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
};

const normalizeRoute = (route: string): string => {
  if (!route) return '/';
  return route.startsWith('/') ? route : `/${route}`;
};

export const buildRouteKey = (pathname: string, searchParams?: URLSearchParams | null): string => {
  const path = normalizeRoute(pathname);
  const query = searchParams?.toString()?.trim();
  return query ? `${path}?${query}` : path;
};

export const readNavigationHistory = (): string[] => {
  if (!canUseSessionStorage()) return [];

  try {
    const raw = window.sessionStorage.getItem(NAV_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string').map(normalizeRoute);
  } catch {
    return [];
  }
};

const writeNavigationHistory = (stack: string[]): void => {
  if (!canUseSessionStorage()) return;

  try {
    window.sessionStorage.setItem(NAV_HISTORY_KEY, JSON.stringify(stack.slice(-MAX_HISTORY_ITEMS)));
  } catch {
    // ignore write failures
  }
};

export const pushNavigationEntry = (route: string): void => {
  if (!canUseSessionStorage()) return;

  const normalized = normalizeRoute(route);
  const stack = readNavigationHistory();
  if (stack[stack.length - 1] === normalized) return;

  stack.push(normalized);
  writeNavigationHistory(stack);
};

export const getPreviousRoute = (currentRoute: string): string | null => {
  if (!canUseSessionStorage()) return null;

  const normalizedCurrent = normalizeRoute(currentRoute);
  const stack = readNavigationHistory();
  if (stack.length === 0) return null;

  while (stack.length > 0 && stack[stack.length - 1] === normalizedCurrent) {
    stack.pop();
  }

  const previous = stack[stack.length - 1] ?? null;
  writeNavigationHistory(stack);
  return previous;
};
