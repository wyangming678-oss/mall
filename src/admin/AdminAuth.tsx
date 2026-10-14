// 后台会话上下文：登录态、权限点、菜单过滤（服务端逐端点复验，这里仅隐藏入口）
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, call, tokenStore } from "../api";
import type { AdminMe } from "./types";

interface AdminContextValue {
  me: AdminMe | null;
  ready: boolean;
  has: (perm: string) => boolean;
  login: (username: string, password: string, extra?: Record<string, unknown>) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin outside provider");
  return ctx;
}

export function hasPerm(me: AdminMe | null, perm: string): boolean {
  if (!me) return false;
  return me.permissions.includes("*") || me.permissions.includes(perm);
}

export function AdminProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!tokenStore.admin.get()) {
      setMe(null);
      setReady(true);
      return;
    }
    try {
      setMe(await call<AdminMe>("admin/auth/me", { token: "admin" }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "unauthenticated") tokenStore.admin.set(null);
      setMe(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string, extra?: Record<string, unknown>) => {
    const r = await call<{ token: string } & AdminMe>("admin/auth/login", { method: "POST", body: { username, password, ...extra } });
    tokenStore.admin.set(r.token);
    setMe({ admin: r.admin, roleKeys: r.roleKeys, permissions: r.permissions });
  }, []);

  const logout = useCallback(async () => {
    try {
      await call("admin/auth/logout", { method: "POST", token: "admin", body: {} });
    } catch {
      /* 本地清理照常 */
    }
    tokenStore.admin.set(null);
    setMe(null);
  }, []);

  const value = useMemo<AdminContextValue>(() => ({
    me, ready,
    has: (perm: string) => hasPerm(me, perm),
    login, logout, refresh,
  }), [me, ready, login, logout, refresh]);

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}
