// 移动端底部四 Tab（整体逻辑 §二：顶栏 + 移动端底部四Tab）
// 标签/顺序跟随后台「站点装修 → 导航」，桌面端隐藏
import { useEffect, useState } from "react";
import { useSite } from "../site";
import { Link, usePath } from "../router";
import { call } from "../api";
import { useUnreadCount } from "../notify";
import { useCartTick, type CartResult } from "../trade";
import type { NavItem } from "../site";

const FALLBACK_NAV: NavItem[] = [ /* i18n-fallback */
  { label: "首页", target: "/", visible: true },
  { label: "分类", target: "/category", visible: true },
  { label: "购物车", target: "/cart", visible: true },
  { label: "我的", target: "/me", visible: true },
];

/** 通用图标：按 target 归类，未知导航统一用通用标记 */
const ICONS = {
  home: "M4 11 12 4l8 7 M7 10v10h10V10",
  bag: "M6 8h12l1 12H5L6 8Z M9 8a3 3 0 0 1 6 0",
  grid: "M4 4h7v7H4Z M13 4h7v7h-7Z M4 13h7v7H4Z M13 13h7v7h-7Z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21a8 8 0 0 1 16 0",
  tag: "M4 4h7l9 9-7 7-9-9V4Z M8.5 8.5h.01",
};

/** 子页面归属哪个 Tab（详情页/结算页/钱包等都归到对应主 Tab 上） */
const GROUPS: Record<string, string[]> = {
  "/": ["/"],
  "/category": ["/category", "/product"],
  "/cart": ["/cart", "/checkout"],
  "/me": ["/me", "/orders", "/order", "/wallet", "/coupons"],
};

function iconFor(target: string): string {
  if (target === "/") return ICONS.home;
  if (target === "/cart") return ICONS.bag;
  if (target === "/me") return ICONS.user;
  if (target === "/category") return ICONS.grid;
  return ICONS.tag;
}

function isActive(target: string, path: string): boolean {
  return (GROUPS[target] ?? [target]).some((g) => (g === "/" ? path === "/" : path === g || path.startsWith(`${g}/`)));
}

/** 内置兜底 Tab 的目标 → 语言包键（跟随后台导航时改用 label_i18n/label） */
const TARGET_TAB_KEY: Record<string, string> = {
  "/": "tab.home", "/category": "tab.category", "/cart": "tab.cart", "/me": "tab.me",
};

export function TabBar() {
  const { config, user, lang, t } = useSite();
  const path = usePath();
  const [count, setCount] = useState(0);
  const unread = useUnreadCount(user, path);
  const cartTick = useCartTick();

  const tabs = (config?.nav ?? []).filter((n) => n.visible).slice(0, 4);
  const usingFallback = !tabs.length;
  const items = usingFallback ? FALLBACK_NAV : tabs;

  useEffect(() => {
    if (!user) {
      setCount(0);
      return undefined;
    }
    let alive = true;
    call<CartResult>("cart/list", { token: "user" })
      .then((r) => { if (alive) setCount(r.summary?.count ?? 0); })
      .catch(() => { if (alive) setCount(0); });
    return () => { alive = false; };
  }, [user, path, cartTick]);

  return (
    <nav aria-label={t("site.main_nav", "主导航")} className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <div className="mx-auto flex max-w-md items-stretch justify-around">
        {items.map((item) => {
          const active = isActive(item.target, path);
          return (
            <Link
              key={item.target}
              to={item.target}
              ariaCurrent={active ? "page" : undefined}
              className={"relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition " + (active ? "font-medium text-primary" : "text-muted-foreground")}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={iconFor(item.target)} />
              </svg>
              {item.label_i18n?.[lang] ?? (TARGET_TAB_KEY[item.target] ? t(TARGET_TAB_KEY[item.target], item.label) : item.label)}
              {item.target === "/cart" && count > 0 && (
                <span className="absolute right-[18%] top-1 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-white">
                  {count > 99 ? "99+" : count}
                </span>
              )}
              {/* 消息未读：只点一个红点，具体条数在「我的 → 消息中心」里看 */}
              {item.target === "/me" && unread > 0 && (
                <span aria-label={`${t("nav.messages", "消息")} (${unread})`} className="absolute right-[26%] top-1.5 size-2 rounded-full bg-destructive" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
