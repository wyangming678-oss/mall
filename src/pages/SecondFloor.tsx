// 商城二楼会场页（文档G）：纯展示层，数据源为 bootstrap 的 second_floor 生效视图。
// present=false 时不可达（首页不挂手势/入口），直接深链回落首页。
// 局部换肤：sf.theme 注入容器 CSS 变量，只影响本子树，不动全局 documentElement。
import { useEffect, type CSSProperties } from "react";
import { useSite, themeVars } from "../site";
import type { AnnouncementItem } from "../site";
import { Link, RedirectTo, navigate, usePath } from "../router";
import { useAssetUrl } from "../components/BrandMark";
import { useCatalogProducts } from "../catalog";
import { pickLocalized } from "../const";
import type { ProductItem } from "../catalog";
import { AnnounceBar, BannerCarousel, IconNav, ImageFloor, MiniProductCard, SectionTitle, moduleTitle } from "./Home";
import { ProductCard } from "../components/ProductCard";

export function SecondFloorPage() {
  const { secondFloor, config, ready, lang, t } = useSite();
  const path = usePath();

  // 上滑关闭：触摸起始 Y → 结束 Y 明显上移则返回首页（与首页下拉进入对称）
  useEffect(() => {
    if (!secondFloor?.present) return undefined;
    let startY: number | null = null;
    const onStart = (e: TouchEvent) => {
      startY = e.touches[0]?.clientY ?? null;
    };
    const onEnd = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = (e.changedTouches[0]?.clientY ?? startY) - startY;
      startY = null;
      if (dy < -80 && window.scrollY <= 0) navigate("/");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate("/");
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("keydown", onKey);
    };
  }, [secondFloor?.present]);

  const catalog = useCatalogProducts({});
  const bg = useAssetUrl(secondFloor?.present ? secondFloor.background_key : null);

  if (!secondFloor || !secondFloor.present) {
    // 未生效或未加载：回落首页，避免空会场（ready 前不跳，等 bootstrap）
    if (ready || path !== "/activity") return <RedirectTo to="/" />;
    return null;
  }

  const modules = secondFloor.modules.slice().sort((a, b) => a.sort - b.sort);
  const moduleOf = (type: string) => modules.find((m) => m.module === type);
  const standalone = ["banner", "image_nav", "announce"];

  let cursor = 0;
  const take = (n: number) => {
    const slice = catalog.items.slice(cursor, cursor + n);
    cursor += slice.length;
    return slice;
  };
  const floors = modules
    .filter((m) => !standalone.includes(m.module))
    .map((m) => {
      if (m.module === "recommend") return { m, products: take(4) };
      if (m.module === "hot") return { m, products: take(8) };
      return { m, products: [] as ProductItem[] };
    });

  const announceModule = moduleOf("announce");
  const empty = !modules.length;
  const sfLabel = pickLocalized(secondFloor.title_i18n, secondFloor.title, lang);

  return (
    <div
      className="flex min-h-dvh flex-col animate-fade-up"
      style={themeVars(secondFloor.theme) as CSSProperties}
    >
      {/* 会场顶栏：返回 + 标题，直角高对比，活动色由容器 theme 决定 */}
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/70 bg-background/95 px-4 py-2.5 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate("/")}
          aria-label={t("common.back_home", "返回首页")}
          className="flex shrink-0 items-center gap-1 py-1 text-sm text-muted-foreground transition hover:text-primary"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t("common.back", "返回")}
        </button>
        <h1 className="min-w-0 flex-1 truncate text-center text-base font-semibold text-foreground">{sfLabel || t("home.activity", "活动会场")}</h1>
        <span className="w-12 shrink-0" aria-hidden />
      </header>

      {/* 会场背景：background_key 生效时铺在内容之上顶区，无图则品牌渐变占位 */}
      <div
        className="relative bg-cover bg-center"
        style={bg ? { backgroundImage: `url(${bg})` } : undefined}
      >
        <div className={bg ? "bg-black/25" : "brand-gradient"}>
          <BannerCarousel module={moduleOf("banner")} siteName={sfLabel || config?.brand?.site_name || t("home.activity", "活动会场")} />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6">
        {moduleOf("image_nav")?.items.length ? <IconNav module={moduleOf("image_nav")} /> : null}
        {announceModule && <AnnounceBar module={announceModule} live={[] as AnnouncementItem[]} />}

        {empty ? (
          <p className="border-t border-border/70 bg-muted/60 px-3 py-10 text-center text-sm text-muted-foreground">
            {t("sf.empty", "会场尚未配置内容，敬请期待。")}
          </p>
        ) : (
          floors.map(({ m, products }) => {
            if (m.module === "recommend") {
              if (!products.length) return null;
              return (
                <section key={m.module} className="border-t border-border/70 pt-3">
                  <SectionTitle title={moduleTitle(m, t, lang)} more="/category" />
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {products.map((p) => <MiniProductCard key={p.id} item={p} />)}
                  </div>
                </section>
              );
            }
            if (m.module === "hot") {
              if (!products.length) return null;
              return (
                <section key={m.module} className="border-t border-border/70 pt-3">
                  <SectionTitle title={moduleTitle(m, t, lang)} more="/category" />
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {products.map((p) => <ProductCard key={p.id} item={p} />)}
                  </div>
                </section>
              );
            }
            return <ImageFloor key={m.module} module={m} />;
          })
        )}

        {secondFloor.cta.label && (
          <div className="mt-2 flex justify-center border-t border-border/70 pt-5 pb-2">
            <Link
              to={secondFloor.cta.link || "/category"}
              className="brand-gradient px-8 py-2.5 text-sm font-medium text-white shadow-sm transition hover:brightness-105"
            >
              {secondFloor.cta.label}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
