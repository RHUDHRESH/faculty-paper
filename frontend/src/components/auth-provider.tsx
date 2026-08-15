import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, type User, ensureCsrf } from "@/lib/api";
import { clearNotifications } from "@/lib/use-notifications";

type AuthCtx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
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

  useEffect(() => {
    // api() fires this on any 401: the session expired mid-use. Clearing the
    // user makes RequireAuth redirect to /login instead of leaving the person
    // stranded on a portal where every button errors.
    const onUnauthorized = () => {
      setUser(null);
      clearNotifications();
    };
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", onUnauthorized);
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
        return u;
      },
      logout: async () => {
        await api("/api/auth/logout", { method: "POST", json: {} });
        setUser(null);
        // Module-level cache; the next sign-in on this tab must not inherit it.
        clearNotifications();
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
