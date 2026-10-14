import { type FormEvent } from "react";
import { useSite } from "../site";
import { navigate, usePath, useQuery, Link } from "../router";
import { useUnreadCount } from "../notify";
import { BrandMark } from "./BrandMark";
import { HeroBand } from "./HeroBand";

/** 内置导航目标 → 语言包键：后台导航条目未配 label_i18n 时按目标回落本地化，自定义目标保留原 label */
const NAV_TAB_KEY: Record<string, string> = {
  "/": "tab.home", "/category": "tab.category", "/cart": "tab.cart", "/me": "tab.me",
};

export function SiteHeader() {
  const { config, user, lang, t } = useSite();
  const path = usePath();
  const applied = useQuery().q ?? "";
  const nav = (config?.nav ?? []).filter((n) => n.visible);
  const unreadMsg = useUnreadCount(user, path);

  function submitSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = new FormData(e.currentTarget).get("q");
    const kw = typeof raw === "string" ? raw.trim() : "";
    navigate(kw ? `/search?q=${encodeURIComponent(kw)}` : "/search");
  }

  /* 窄屏：品牌+账户一行、搜索一行（导航交给底部 Tab 栏）；md 起恢复单行（品牌·导航·搜索·账户） */
  /* 首页顶栏即动态带：Logo/搜索这一栏铺品牌底色 + 商品图标向外扩散，其他页面保持白底 */
  const onHome = path === "/";
  return (
    <header className={"sticky top-0 z-30 border-b overflow-hidden " + (onHome ? "hero-band" : "bg-background/85 backdrop-blur")}>
      {onHome && <HeroBand />}
      <div className="relative mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link to="/" className="flex shrink-0 items-center gap-2 text-lg font-bold text-foreground">
          <BrandMark size="sm" logoKey={config?.brand?.logo_key} siteName={config?.brand?.site_name ?? "ChicCart"} />
          {config?.brand?.site_name ?? "ChicCart"}
        </Link>
        {/* 窄屏不渲染顶栏导航：底部 Tab 栏（md 以下）已经是同一组入口，避免搜索框下面多出一排 */}
        <nav className="hidden min-w-0 basis-full flex-nowrap items-center gap-1 overflow-x-auto pb-1 md:order-none md:flex md:basis-auto md:flex-1 md:flex-wrap md:overflow-visible md:pb-0">
          {nav.map((item) => (
            <Link
              key={item.target}
              to={item.target}
              className={
                "shrink-0 rounded-md px-3 py-1.5 text-sm transition " +
                (path === item.target
                  ? "bg-primary font-medium text-primary-foreground shadow-sm shadow-primary/40"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")
              }
            >
              {item.label_i18n?.[lang] ?? (NAV_TAB_KEY[item.target] ? t(NAV_TAB_KEY[item.target], item.label) : item.label)}
            </Link>
          ))}
        </nav>
        {/* key 只在跳转后 URL 关键词变化时重挂载，输入中途不会被覆写；/search 页自带输入框，顶栏不再重复渲染 */}
        {path !== "/search" && (
          <form key={`${path}|${applied}`} role="search" onSubmit={submitSearch} className="order-2 flex min-w-0 basis-full items-center gap-1.5 md:order-none md:basis-48 md:max-w-xs md:flex-1">
            <input
              name="q"
              defaultValue={applied}
              placeholder={t("site.search", "搜索商品")}
              aria-label={t("site.search", "搜索商品")}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            />
            <button
              type="submit"
              className="h-8 shrink-0 rounded-md brand-gradient px-3 text-sm font-medium text-white shadow-sm shadow-primary/40 transition hover:brightness-105"
            >
              {t("site.search_btn", "搜索")}
            </button>
          </form>
        )}
        {user ? (
          <span className="flex shrink-0 items-center gap-2">
            <Link
              to="/me/messages"
              aria-label={unreadMsg > 0 ? `${t("nav.messages", "消息")} (${unreadMsg})` : t("nav.messages", "消息")}
              className={"relative rounded-md px-3 py-1.5 text-sm transition " + (path.startsWith("/me/messages") ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")}
            >
              {t("nav.messages", "消息")}
              {unreadMsg > 0 && (
                <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-white">
                  {unreadMsg > 99 ? "99+" : unreadMsg}
                </span>
              )}
            </Link>
            <Link to="/orders" className={"rounded-md px-3 py-1.5 text-sm transition " + (path.startsWith("/orders") || path === "/order" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")}>{t("nav.orders", "订单")}</Link>
            <Link to="/me" className="rounded-md border bg-card px-3 py-1.5 text-sm shadow-sm transition hover:bg-accent">{user.nickname}</Link>
          </span>
        ) : (
          <button
            type="button"
            className="shrink-0 rounded-md brand-gradient px-4 py-1.5 text-sm font-medium text-white shadow-md shadow-primary/40 transition hover:brightness-105"
            onClick={() => navigate("/login")}
          >
            {t("site.login", "登录")}
          </button>
        )}
      </div>
    </header>
  );
}

export function SiteFooter() {
  const { config, lang, t } = useSite();
  const pages = config?.pages ?? {};
  const links = Object.entries(pages);
  return (
    <footer className="mt-12 border-t bg-sidebar py-6 text-xs text-muted-foreground">
      {links.length > 0 && (
        <nav className="mb-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
          {links.map(([slug, p]) => (
            <Link key={slug} to={`/page?slug=${encodeURIComponent(slug)}`} className="hover:text-foreground hover:underline">
              {p.title_i18n?.[lang] || p.title_i18n?.zh || p.title || slug}
            </Link>
          ))}
        </nav>
      )}
      <p className="text-center">{config?.brand?.site_name ?? "ChicCart"} · {t("site.footnote", "Powered by Qoder Sites")}</p>
    </footer>
  );
}
