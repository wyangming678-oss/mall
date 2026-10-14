// 极简 path 路由（base-path 感知：首屏始终解析为首页，深链/子路径预览都能命中）
import { createContext, useCallback, useContext, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";

const ROUTE_ROOTS = ["login", "register", "me", "category", "search", "page", "product", "cart", "checkout", "orders", "order", "coupons", "wallet", "coins", "installment", "activity", "admin"];

function stripFile(pathname: string): string {
  return pathname.replace(/\/index\.html$/, "/");
}

// 首屏：把当前文档路径解析成 (挂载基址 BASE, 应用内路由)。
// 若末尾命中已知路由段则视为深链，否则整段目录当作基址、路由回落到首页。
function detectInitial(pathname: string): { base: string; route: string } {
  const p = stripFile(pathname);
  const segs = p.split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i += 1) {
    if (ROUTE_ROOTS.includes(segs[i])) {
      const base = `/${segs.slice(0, i).join("/")}${i ? "/" : ""}`;
      const route = `/${segs.slice(i).join("/")}`;
      return { base, route: route === "/" ? "/" : route };
    }
  }
  const base = p.endsWith("/") ? p : p.slice(0, p.lastIndexOf("/") + 1);
  return { base, route: "/" };
}

const initial = detectInitial(window.location.pathname);
export const BASE = initial.base;

function toAbs(to: string): string {
  if (to === "/" || to === "") return BASE;
  return BASE.replace(/\/$/, "") + (to.startsWith("/") ? to : `/${to}`);
}

function routeFrom(pathname: string): string {
  const p = stripFile(pathname);
  const rest = p.startsWith(BASE) ? p.slice(BASE.length) : p;
  return `/${rest.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

const PathContext = createContext<string>(initial.route);
const QueryContext = createContext<Record<string, string>>({});
const listeners = new Set<() => void>();

function currentQuery(): Record<string, string> {
  return Object.fromEntries(new URL(window.location.href).searchParams);
}

export function navigate(to: string, replace = false) {
  const target = toAbs(to);
  if (window.location.pathname === target) return;
  if (replace) window.history.replaceState({}, "", target);
  else {
    window.history.pushState({}, "", target);
    // 目标页高度不同会让浏览器回卷滚动位置，表现为整块界面抖一下
    window.scrollTo(0, 0);
  }
  for (const fn of listeners) fn();
}

export function usePath() {
  return useContext(PathContext);
}

export function useQuery() {
  return useContext(QueryContext);
}

/** 由应用内路由生成绝对路径（用于分享链接，会自动带上 base 前缀） */
export function hrefFor(to: string): string {
  return toAbs(to);
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(initial.route);
  const [query, setQuery] = useState(currentQuery);
  useEffect(() => {
    const fn = () => {
      setPath(routeFrom(window.location.pathname));
      setQuery(currentQuery());
    };
    listeners.add(fn);
    window.addEventListener("popstate", fn);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("popstate", fn);
    };
  }, []);
  return (
    <PathContext.Provider value={path}>
      <QueryContext.Provider value={query}>{children}</QueryContext.Provider>
    </PathContext.Provider>
  );
}

// aria-* 等连字符属性不触发 TS 多余属性检查，不透传就会静默丢失（箭头按钮读屏无名称）
type LinkProps = { to: string; className?: string; children: ReactNode; onClick?: () => void; ariaCurrent?: "page" }
  & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick" | "aria-current">;

export function Link({ to, className, children, onClick, ariaCurrent, ...rest }: LinkProps) {
  const handle = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      onClick?.();
      navigate(to);
    },
    [to, onClick],
  );
  return (
    <a href={toAbs(to)} className={className} onClick={handle} aria-current={ariaCurrent} {...rest}>
      {children}
    </a>
  );
}

export function RedirectTo({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, true);
  }, [to]);
  return null;
}
