import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, type User, ensureCsrf } from "@/lib/api";

type AuthCtx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      await ensureCsrf();
      const me = await api<User>("/api/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      loading,
      refresh,
      login: async (email, password) => {
        await ensureCsrf();
        const u = await api<User>("/api/auth/login", {
          method: "POST",
          json: { email, password },
        });
        setUser(u);
      },
      logout: async () => {
        await api("/api/auth/logout", { method: "POST", json: {} });
        setUser(null);
      },
    }),
    [user, loading]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
