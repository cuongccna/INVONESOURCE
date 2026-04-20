'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import apiClient from '../lib/apiClient';

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  role: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  setUser: (u: AuthUser | null) => void;
}

const AuthContext = createContext<AuthContextValue>({ user: null, setUser: () => {} });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    apiClient
      .get<{ data: AuthUser }>('/auth/me')
      .then((res) => setUser(res.data.data))
      .catch(() => { /* silent — will retry on next render if needed */ });
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
