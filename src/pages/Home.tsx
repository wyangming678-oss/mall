// 首页排版（参考图结构）：Banner 轮播 → 圆形功能入口 → 公告 → 四联精选 → 双列商品网格
// 内容来源固定为后台「站点装修 → 首页模块」的六类模块 + 目录端点真实商品，不造假数据
// 版式为扁平直角：楼层不套卡片，只靠留白与细分隔线区分（圆角由装修 theme.radius 统一控制，默认 0）
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { useSite } from "../site";
import { Link, navigate } from "../router";
import { call, tokenStore } from "../api";
import { CartLoading } from "../components/CartLoading";
import { ProductCard, ProductCover } from "../components/ProductCard";
import { useCatalogProducts } from "../catalog";
import { formatBase, pickLocalized } from "../const";
import { useAssetUrl } from "../components/BrandMark";
import { SPLASH_SHOWN_KEY } from "./Splash";
import { Button } from "@/components/ui/button";
import type { AnnouncementItem, HomeModule, Poster } from "../site";
import type { ProductItem } from "../catalog";

/** 未配置装修时的默认楼层顺序，与后台 DEFAULT_CONFIG 一致；标题随语言取词 */
function fallbackModules(t: (key: string, fallback?: string) => string): HomeModule[] {
  return [
    { module: "banner", enabled: true, sort: 0, title: null, items: [] },
    { module: "image_nav", enabled: true, sort: 1, title: t("home.section_image_nav", "快捷入口"), items: [] },
    { module: "announce", enabled: true, sort: 2, title: t("home.section_announce", "公告"), items: [] },
    { module: "recommend", enabled: true, sort: 3, title: t("home.section_recommend", "精选推荐"), items: [] },
    { module: "hot", enabled: true, sort: 4, title: t("home.section_hot", "热销榜单"), items: [] },
  ];
}

/** 楼层标题的函数侧默认中文（与 config.mjs 的 DEFAULT_CONFIG.home_modules 同源） */
const FLOOR_DEFAULTS: Record<string, { zh: string; key: string }> = { /* i18n-fallback */
  image_nav: { zh: "快速直达", key: "home.section_image_nav" },
  announce: { zh: "公告", key: "home.section_announce" },
  recommend: { zh: "为你推荐", key: "home.section_recommend" },
  hot: { zh: "热销榜单", key: "home.section_hot" },
  activity: { zh: "活动楼层", key: "home.section_activity" },
  brand_story: { zh: "品牌故事", key: "home.section_brand_story" },
};

/**
 * 楼层标题取词：装修译名 > 自定义标题 > 内置译名。
 * 配置里的标题若仍是函数侧默认中文，说明管理员没改过文案，非中文界面直接取内置译名，
 * 否则切语言会被这份中文配置压死（现网 home_modules 就全是默认中文）。
 */
export function moduleTitle(
  m: HomeModule | undefined,
  t: (key: string, fallback?: string) => string,
  lang: string,
): string {
  if (!m) return "";
  const typed = m.title_i18n?.[lang];
  if (typed) return typed;
  const def = FLOOR_DEFAULTS[m.module];
  if (!m.title) return def ? t(def.key, def.zh) : m.module;
  if (def && lang !== "zh" && m.title === def.zh) return t(def.key, def.zh);
  return m.title;
}

/** 内置功能入口：只挂在真实存在的页面上；label_key 取词，label 保留原中文作兜底 */const BUILTIN_NAV = [ /* i18n-fallback */
  { label: "全部分类", label_key: "home.nav_all_category", target: "/category", icon: "grid" },
  { label: "领券中心", label_key: "home.nav_coupon_center", target: "/coupons", icon: "ticket" },
  { label: "我的订单", label_key: "home.nav_my_orders", target: "/orders", icon: "receipt" },
  { label: "账户余额", label_key: "home.nav_wallet", target: "/wallet", icon: "wallet" },
  { label: "个人中心", label_key: "home.nav_me", target: "/me", icon: "user" },
];

const NAV_ICONS: Record<string, string> = {
  grid: "M4 4h7v7H4Z M13 4h7v7h-7Z M4 13h7v7H4Z M13 13h7v7h-7Z",
  ticket: "M3 8h18v3a2 2 0 0 0 0 4v2H3v-2a2 2 0 0 0 0-4V8Z M12 8v11",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2Z M9 8h6 M9 12h6",
  wallet: "M3 7h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3V7Z M3 7V5h13 M16 13h2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21a8 8 0 0 1 16 0",
  bag: "M6 8h12l1 12H5L6 8Z M9 8a3 3 0 0 1 6 0",
  tag: "M4 4h7l9 9-7 7-9-9V4Z M8.5 8.5h.01",
};

function navIconOf(target: string): string {
  const hit = BUILTIN_NAV.find((n) => target === n.target || (n.target !== "/category" && target.startsWith(n.target)));
  if (hit) return hit.icon;
  if (target.startsWith("/cart")) return "bag";
  return "tag";
}

function NavIcon({ target }: { target: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={NAV_ICONS[navIconOf(target)]} />
    </svg>
  );
}

export function SectionTitle({ title, more }: { title: string; more?: string }) {
  const { t } = useSite();
  return (
    <h2 className="mb-3 flex items-center justify-between gap-2 text-base font-semibold">
      <span className="flex items-center gap-2">
        <span className="h-4 w-1 brand-gradient" />
        {title}
      </span>
      {more && <Link to={more} className="text-sm font-normal text-muted-foreground hover:text-primary">{t("common.more", "更多")} ›</Link>}
    </h2>
  );
}

type BannerItem = HomeModule["items"][number];

/** 没上传图片的条目：用品牌渐变底 + 标题当作文字广告，同样可配跳转 */
function GradientSlide({ title }: { title: string }) {
  return (
    <div className="relative grid size-full place-items-center overflow-hidden border-l-4 border-white/70 brand-gradient px-5 text-center text-white">
      <span className="pointer-events-none absolute -right-6 -top-8 size-28 rounded-full bg-white/15 animate-float-slow" />
      <span className="pointer-events-none absolute -bottom-6 right-24 size-16 rounded-full bg-white/10 animate-float-slow [animation-delay:1s]" />
      <span className="relative line-clamp-2 text-lg font-bold sm:text-xl">{title}</span>
    </div>
  );
}

function BannerSlide({ item, fallbackTitle }: { item: BannerItem; fallbackTitle: string }) {
  const url = useAssetUrl(item.image_key);
  const title = item.title ?? fallbackTitle;
  const body = url ? (
    <div className="relative size-full">
      <img src={url} alt={title} className="size-full object-cover" />
      {item.title && <span className="absolute bottom-2 left-3 bg-black/45 px-2.5 py-1 text-xs text-white">{title}</span>}
    </div>
  ) : (
    <GradientSlide title={title} />
  );
  return item.link ? <Link to={item.link} className="block size-full">{body}</Link> : body;
}

export function BannerCarousel({ module, siteName }: { module: HomeModule | undefined; siteName: string }) {
  const { t, tf } = useSite();
  const slides = (module?.items ?? []).filter((i) => i.image_key || i.title);
  const count = slides.length;
  const [idx, setIdx] = useState(0);
  // 手动拖动：dragging 期间关掉过渡与自动轮播，drag 是当前跟手的位移（px）
  const [dragging, setDragging] = useState(false);
  const [drag, setDrag] = useState(0);
  const startX = useRef<number | null>(null);
  const slideW = useRef(1);
  const moved = useRef(false);

  const step = (n: number) => setIdx((i) => (count ? ((i + n) % count + count) % count : 0));

  useEffect(() => {
    if (count < 2 || dragging) return undefined;
    const timer = window.setInterval(() => setIdx((i) => (i + 1) % count), 5000);
    return () => window.clearInterval(timer);
  }, [count, dragging]);

  function onDown(e: RPointerEvent<HTMLDivElement>) {
    if (count < 2 || e.button === 2) return;
    startX.current = e.clientX;
    slideW.current = e.currentTarget.clientWidth || 1;
    moved.current = false;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onMove(e: RPointerEvent<HTMLDivElement>) {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    if (Math.abs(dx) > 6) moved.current = true;
    setDrag(dx);
  }
  function onUp(e: RPointerEvent<HTMLDivElement>) {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    setDragging(false);
    setDrag(0);
    // 阈值取「1/6 屏宽，夹在 24–80px」：手机轻轻一划就走，桌面不会误触
    const th = Math.min(80, Math.max(24, slideW.current / 6));
    if (dx <= -th) step(1);
    else if (dx >= th) step(-1);
  }

  const current = idx < slides.length ? idx : 0;

  // 一条都没配时保留品牌占位，避免首页顶部空掉
  if (slides.length === 0) {
    return (
      <div className="relative overflow-hidden border-l-4 border-white/70 brand-gradient px-5 py-6 text-white">
        <span className="pointer-events-none absolute -right-6 -top-8 size-28 rounded-full bg-white/15 animate-float-slow" />
        <span className="pointer-events-none absolute -bottom-6 right-24 size-16 rounded-full bg-white/10 animate-float-slow [animation-delay:1s]" />
        <h1 className="text-lg font-bold sm:text-xl">{siteName}</h1>
        <p className="mt-1 text-xs text-white/85 sm:text-sm">{t("home.banner_tagline", "好物精选 · 分类浏览、领券下单、余额支付一站完成")}</p>
        <Link to="/category" className="mt-3 inline-block bg-white/95 px-4 py-1.5 text-sm font-medium text-primary">
          {t("home.banner_cta", "去逛逛")}
        </Link>
      </div>
    );
  }

  return (
    <section aria-label={t("home.banner_aria", "首页 Banner")} className="relative overflow-hidden">
      <div
        tabIndex={0}
        role="group"
        aria-label={tf("home.slide_of", { n: current + 1, total: count }, `第 ${current + 1} / ${count} 张`)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
          else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        // 拖动结束落点仍会派发 click：只要真的划过，就吞掉这次跳转，避免误进商品页
        onClickCapture={(e) => {
          if (!moved.current) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        className="flex touch-pan-y select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        style={{
          transform: `translate3d(calc(${-current * 100}% + ${drag}px), 0, 0)`,
          transition: dragging ? "none" : "transform .35s ease-out",
        }}
      >
        {slides.map((s, i) => (
          <div key={`slide-${i}`} className={"aspect-[16/7] w-full shrink-0 sm:aspect-[24/7] " + (count > 1 ? "cursor-grab active:cursor-grabbing" : "")}>
            <BannerSlide item={s} fallbackTitle={siteName} />
          </div>
        ))}
      </div>
      {slides.length > 1 && (
        <div className="absolute inset-x-0 bottom-2 flex justify-center gap-1.5">
          {slides.map((_, i) => (
            <button
              key={`dot-${i}`}
              type="button"
              aria-label={tf("home.slide_index", { n: i + 1 }, "第 {n} 张")}
              onClick={() => setIdx(i)}
              className={"h-1.5 rounded-full transition-all " + (i === current ? "w-5 bg-white" : "w-1.5 bg-white/60 hover:bg-white")}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** 圆形功能入口：装修 image_nav 有内容时用配置项，否则用内置真实页面 */
export function IconNav({ module }: { module: HomeModule | undefined }) {
  const { t, lang } = useSite();
  const configured = (module?.items ?? []).filter((i) => i.title || i.image_key);
  const items = configured.length
    ? configured.map((i) => ({ label: i.title ?? t("home.entry", "入口"), target: i.link ?? "/category", imageKey: i.image_key }))
    : BUILTIN_NAV.map((n) => ({ label: t(n.label_key, n.label), target: n.target, imageKey: null as string | null }));

  return (
    <section aria-label={moduleTitle(module, t, lang) || t("home.quick_entry", "快捷入口")} className="pt-1">
      <div className={"scrollbar-none flex gap-2 overflow-x-auto " + (items.length <= 5 ? "justify-between" : "")}>
        {items.map((it) => (
          <IconEntry key={it.target + it.label} label={it.label} target={it.target} imageKey={it.imageKey} narrow={items.length > 5} />
        ))}
      </div>
    </section>
  );
}

function NavTileImage({ imageKey, alt }: { imageKey: string; alt: string }) {
  const url = useAssetUrl(imageKey);
  if (!url) return null;
  return <img src={url} alt={alt} className="size-full rounded-full object-cover" />;
}

function IconEntry({ label, target, imageKey, narrow }: { label: string; target: string; imageKey: string | null; narrow: boolean }) {
  return (
    <Link to={target} className={"group flex shrink-0 flex-col items-center gap-1.5 text-xs text-foreground/80 transition hover:text-primary " + (narrow ? "min-w-16" : "flex-1")}>
      <span className="grid size-12 place-items-center overflow-hidden rounded-full border bg-background text-primary transition group-hover:border-primary group-hover:bg-accent">
        {imageKey ? <NavTileImage imageKey={imageKey} alt={label} /> : <NavIcon target={target} />}
      </span>
      <span className="line-clamp-1">{label}</span>
    </Link>
  );
}

/** 公告栏：公告表的 banner 优先，其后接装修 announce 静态文案，单行自动横向轮播 */
export function AnnounceBar({ module, live }: { module: HomeModule | undefined; live: AnnouncementItem[] }) {
  const { t, lang } = useSite();
  const notices = [
    ...live.map((a) => ({ title: a.title, link: null as string | null })),
    ...(module?.items ?? []).filter((i) => i.title).map((i) => ({ title: i.title as string, link: i.link })),
  ];
  const boxRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // dur=0 ⇒ 不轮播（访客要求降低动效）；reps=轨道内复制份数，须为偶数，位移 -50% 才正好接上
  const [marquee, setMarquee] = useState({ dur: 0, reps: 1 });

  useEffect(() => {
    const box = boxRef.current;
    const track = trackRef.current;
    const first = track?.firstElementChild as HTMLElement | null;
    if (!box || !track || !first) return;
    const measure = () => {
      // 量第一份的真实条宽（其余是无缝衔接用的副本，不参与测量）
      const content = first.scrollWidth;
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      if (still || !content) {
        setMarquee((p) => (p.dur === 0 && p.reps === 1 ? p : { dur: 0, reps: 1 }));
        return;
      }
      // 只要有内容就轮播：条宽不足视口两倍时补份数，否则 -50% 位移会在尾部露出空白
      let reps = Math.max(2, Math.ceil((box.clientWidth * 2) / content));
      if (reps % 2) reps += 1;
      const dur = Math.min(150, Math.max(12, Math.round((content * reps) / 2 / 45)));
      setMarquee((p) => (p.dur === dur && p.reps === reps ? p : { dur, reps }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(track);
    return () => ro.disconnect();
    // 译文长度随语言变化，切语言要重新量宽
  }, [notices.length, lang]);

  if (!notices.length) return null;
  const running = marquee.dur > 0;
  const copy = (dup: boolean) => (
    <div className="flex shrink-0 items-center gap-8 pr-8" aria-hidden={dup || undefined}>
      {notices.map((n, i) =>
        n.link ? (
          <Link key={i} to={n.link} className="shrink-0 text-foreground/80 hover:text-primary hover:underline">{n.title}</Link>
        ) : (
          <span key={i} className="shrink-0 text-foreground/80">{n.title}</span>
        ),
      )}
    </div>
  );
  return (
    <div className="flex items-center gap-2 border-y border-border/70 bg-accent/60 py-2 text-sm">
      <span className="flex shrink-0 items-center gap-1 brand-gradient px-2 py-0.5 text-xs font-medium text-white">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Z M10 20a2 2 0 0 0 4 0" />
        </svg>
        {t("home.announce", "公告")}
      </span>
      {/* 轮播时裁掉溢出（-50% 位移靠两份内容无缝衔接）；不轮播时保留手动横向滑动 */}
      <div ref={boxRef} className={"min-w-0 flex-1 " + (running ? "overflow-hidden" : "scrollbar-none overflow-x-auto")}>
        <div
          ref={trackRef}
          className={"announce-track flex" + (running ? " is-running" : "")}
          style={running ? ({ "--announce-dur": `${marquee.dur}s` } as CSSProperties) : undefined}
        >
          {Array.from({ length: running ? marquee.reps : 1 }, (_, i) => copy(i > 0))}
        </div>
      </div>
    </div>
  );
}

const POPUP_SHOWN_KEY = "mall.popup.";
const POSTER_POPUP_KEY = "mall.poster.daily";

/** 本地日期串，用作「同一公告每人每天≤1 次」的记账粒度（文档B §9：应用层，不落主状态机） */
function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 开屏退场判定：同一次会话里开屏只播一次，播过/不能读 sessionStorage 都视为已退场 */
function splashGone(): boolean {
  try { return sessionStorage.getItem(SPLASH_SHOWN_KEY) === "1"; } catch { return true; }
}

/**
 * 首页两个全屏弹窗（弹窗公告 / 每日活动海报）共用一条队列，同屏只挂一个。
 * 两者都是 fixed inset-0 z-50，同时挂载时后挂载的那层遮罩会盖住前一层「知道了/关闭」，
 * 点击落在上层背景上 ⇒ 表现为「关闭按钮失效」；公告优先，公告关掉后海报才轮到展示。
 * 开屏（同样是 z-50，且它的「跳过」与本组件的「×」同在右上角）在场时也先不抢占。
 */
function HomePopups({ items, poster }: { items: AnnouncementItem[]; poster?: Poster | null }) {
  const { t } = useSite();
  const [announce, setAnnounce] = useState<AnnouncementItem | null>(null);
  const [posterOpen, setPosterOpen] = useState(false);
  const [pastSplash, setPastSplash] = useState(splashGone);
  const posterUrl = useAssetUrl(poster?.enabled ? poster.image_key : null);
  const annRef = useRef<AnnouncementItem | null>(null);

  // 开屏最长 3.6s + 0.38s 淡出；轮询到它退场为止，超时则不再等待（开屏可能根本没渲染）
  useEffect(() => {
    if (pastSplash) return;
    let tries = 0;
    const id = window.setInterval(() => {
      if (++tries > 16 || splashGone()) {
        window.clearInterval(id);
        setPastSplash(true);
      }
    }, 400);
    return () => window.clearInterval(id);
  }, [pastSplash]);

  // 公告：展示即写日期，同一天轮询/刷新不再弹第二条
  useEffect(() => {
    if (announce || !pastSplash) return;
    const today = localDate();
    const next = items.find((a) => localStorage.getItem(POPUP_SHOWN_KEY + a.announcement_id) !== today);
    if (!next) return;
    localStorage.setItem(POPUP_SHOWN_KEY + next.announcement_id, today);
    annRef.current = next;
    setAnnounce(next);
  }, [items, announce, pastSplash]);

  // 海报：公告在场（含本轮刚认领）时不抢占；once_per_day 命中当天只弹一次
  useEffect(() => {
    if (!pastSplash || annRef.current || posterOpen || !poster?.enabled || !poster.image_key) return;
    const today = localDate();
    if (poster.once_per_day !== false && localStorage.getItem(POSTER_POPUP_KEY) === today) return;
    localStorage.setItem(POSTER_POPUP_KEY, today);
    setPosterOpen(true);
  }, [announce, posterOpen, poster, pastSplash]);

  if (announce) {
    return (
      <div role="dialog" aria-modal="true" aria-label={t("home.announce", "公告")} className="fixed inset-0 z-50 grid place-items-center bg-black/55 px-4">
        <div className="w-full max-w-md border-2 border-primary bg-background">
          <p className="flex items-center justify-between gap-3 border-b border-primary bg-primary px-4 py-2 text-sm font-semibold text-white">
            <span>{announce.title}</span>
            <button type="button" onClick={() => { annRef.current = null; setAnnounce(null); }}
              aria-label={t("common.close", "关闭")} className="shrink-0 border border-white/70 px-2 leading-5">×</button>
          </p>
          <p className="max-h-60 overflow-y-auto px-4 py-3 text-sm leading-6 whitespace-pre-wrap">{announce.content}</p>
          <div className="flex justify-end border-t border-border px-3 py-2">
            <Button variant="outline" size="sm" onClick={() => { annRef.current = null; setAnnounce(null); }}>{t("home.got_it", "知道了")}</Button>
          </div>
        </div>
      </div>
    );
  }

  if (!posterOpen || !poster?.enabled || !posterUrl) return null;
  const inner = <img src={posterUrl} alt={t("home.poster", "活动海报")} className="max-h-[70vh] w-auto max-w-full object-contain" />;
  return (
    <div role="dialog" aria-modal="true" aria-label={t("home.poster", "活动海报")} className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4" onClick={() => setPosterOpen(false)}>
      <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {poster.link ? <Link to={poster.link} onClick={() => setPosterOpen(false)}>{inner}</Link> : inner}
        <Button variant="outline" size="sm" onClick={() => setPosterOpen(false)}>{t("common.close", "关闭")}</Button>
      </div>
      {/* 托管站在右下角注入了水印（z-index 2147483647），矮视口下会压住图下方的「关闭」；右上角另给一个可达的关闭 */}
      <button type="button" onClick={(e) => { e.stopPropagation(); setPosterOpen(false); }}
        aria-label={t("common.close", "关闭")} className="absolute right-4 top-4 border border-white/70 bg-black/50 px-3 py-1 text-xs text-white">×</button>
    </div>
  );
}

export function MiniProductCard({ item }: { item: ProductItem }) {
  const { lang } = useSite();
  const title = pickLocalized(item.title_i18n, item.title, lang);
  return (
    <Link to={`/product?id=${item.id}`} className="group flex min-w-0 flex-col">
      <div className="aspect-square overflow-hidden bg-muted">
        <ProductCover imageKey={item.images[0]} alt={title} className="size-full object-cover transition group-hover:scale-[1.03]" />
      </div>
      <p className="mt-1.5 line-clamp-1 text-xs leading-4 text-foreground/80">{title}</p>
      <span className="mt-0.5 text-xs font-bold text-primary">{item.min_price === null ? "—" : formatBase(item.min_price)}</span>
    </Link>
  );
}

/** 图文楼层（activity / brand_story 等）：配置了图片才占位，不编造内容 */
export function ImageFloor({ module }: { module: HomeModule }) {
  const { t, lang } = useSite();
  const tiles = module.items.filter((i) => i.image_key || i.title);
  if (!tiles.length) return null;
  return (
    <section className="border-t border-border/70 pt-3">
      <SectionTitle title={moduleTitle(module, t, lang)} more="/category" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((tile, i) => (
          <Link key={i} to={tile.link ?? "/category"} className="group relative aspect-[4/3] overflow-hidden bg-muted">
            {tile.image_key ? <FloorImage imageKey={tile.image_key} alt={tile.title ?? ""} /> : (
              <span className="grid size-full place-items-center brand-gradient text-sm font-medium text-white">{tile.title}</span>
            )}
            {tile.title && tile.image_key && (
              <span className="absolute bottom-1.5 left-2 bg-black/45 px-2 py-0.5 text-xs text-white">{tile.title}</span>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}

function FloorImage({ imageKey, alt }: { imageKey: string; alt: string }) {
  const url = useAssetUrl(imageKey);
  if (!url) return <span className="grid size-full place-items-center brand-gradient text-sm text-white">{alt}</span>;
  return <img src={url} alt={alt} className="size-full object-cover transition group-hover:scale-[1.03]" />;
}

export function MaintenanceNotice() {
  const { config, t } = useSite();
  if (!config?.switches?.maintenance) return null;
  return (
    <div className="border-b bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">
      {t("home.maintain", "站点维护中：下单功能暂停，浏览不受影响。")}
    </div>
  );
}

/** 下拉进入二楼的触发阈值与最大阻尼位移（px） */
const PULL_THRESHOLD = 120;
const PULL_MAX = 160;

/** 二楼会场入口条（E-3）：present=true 时始终给出显式入口，降低动效偏好下也有可达路径 */
function SecondFloorEntry({ title, hint }: { title: string; hint: string }) {
  const { t } = useSite();
  return (
    <Link
      to="/activity"
      className="flex items-center justify-between gap-2 border-y border-primary/40 bg-primary/10 px-3 py-2 text-sm transition hover:bg-primary/15"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-4 w-1 shrink-0 brand-gradient" />
        <span className="min-w-0 truncate font-medium">{title || t("home.activity", "活动会场")}</span>
        <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">{hint}</span>
      </span>
      <span className="shrink-0 text-primary">{t("home.enter", "进入 ›")}</span>
    </Link>
  );
}

/** 分期专区入口条：随 switches.installment 开关联动显隐，不依赖装修配置，关开关即消失 */
function InstallmentEntry() {
  const { t } = useSite();
  return (
    <Link
      to="/installment"
      className="flex items-center justify-between gap-2 border-y border-primary/40 bg-primary/10 px-3 py-2 text-sm transition hover:bg-primary/15"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-4 w-1 shrink-0 brand-gradient" />
        <span className="min-w-0 truncate font-medium">{t("installment.zone_title", "分期专区")}</span>
        <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
          {t("installment.entry_hint", "2/3/6/9/12 期 · 0 利息")}
        </span>
      </span>
      <span className="shrink-0 text-primary">{t("home.enter", "进入 ›")}</span>
    </Link>
  );
}

/** 下拉提示层（E-1/E-2）：仅手势开启时跟手浮现，越阈提示变「松开进入」 */
function PullPeek({ pull, hint }: { pull: number; hint: string }) {
  const { t } = useSite();
  if (pull <= 0) return null;
  const ready = pull >= PULL_THRESHOLD;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center"
      style={{ transform: `translateY(${Math.min(pull, PULL_MAX) - 44}px)`, opacity: Math.min(1, pull / 40) }}
    >
      <span className="flex items-center gap-2 bg-primary px-4 py-1.5 text-xs font-medium text-white">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ready ? "rotate-180 transition-transform" : "transition-transform"} aria-hidden>
          <path d="M12 5v14 M6 13l6 6 6-6" />
        </svg>
        {ready ? t("home.pull_release", "松开进入会场") : hint}
      </span>
    </div>
  );
}

export function HomePage() {
  const { config, campaign, ready, failed, refresh, announcements, secondFloor, lang, t } = useSite();
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const catalog = useCatalogProducts({});

  // 二楼下拉手势（E-1/E-2）：仅在生效视图 present=true 且未降低动效时挂载监听
  const sfPresent = secondFloor?.present === true;
  const sfTitle = sfPresent ? pickLocalized(secondFloor.title_i18n, secondFloor.title, lang) : "";
  const sfHint = sfPresent ? secondFloor.trigger_hint.text || t("home.pull_hint", "下拉进入活动会场") : "";
  const [reducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
  const gestureOn = sfPresent && !reducedMotion;
  const [pull, setPull] = useState(0);
  const pullRef = useRef(0);
  useEffect(() => {
    if (!gestureOn) {
      pullRef.current = 0;
      setPull(0);
      return undefined;
    }
    let startY = 0;
    let tracking = false;
    const onStart = (e: TouchEvent) => {
      if (window.scrollY > 0) {
        tracking = false;
        return;
      }
      startY = e.touches[0]?.clientY ?? 0;
      tracking = true;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dy = (e.touches[0]?.clientY ?? startY) - startY;
      if (dy <= 0) {
        pullRef.current = 0;
        setPull(0);
        return;
      }
      if (e.cancelable) e.preventDefault();
      const p = Math.min(dy, PULL_MAX);
      pullRef.current = p;
      setPull(p);
    };
    const onEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (pullRef.current >= PULL_THRESHOLD) navigate("/activity");
      pullRef.current = 0;
      setPull(0);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [gestureOn]);

  useEffect(() => {
    // 心跳：登录后为到期任务提供触发（M1 阶段仅同步 config_version）
    if (ready && tokenStore.user.get()) void call("tasks/tick", { method: "POST", token: "user", body: {} }).catch(() => undefined);
  }, [ready]);

  useEffect(() => {
    if (ready) {
      setTimedOut(false);
      return;
    }
    setTimedOut(false);
    const timer = window.setTimeout(() => setTimedOut(true), 10000);
    return () => window.clearTimeout(timer);
  }, [ready, attempt]);

  // 楼层来源：优先生效皮肤视图 campaign.home_modules（后端已按模块+条目 enabled 双层过滤、海报关闭即不出现）；
  // 未加载到 campaign 时回落默认 config，仍在前端过滤模块级 enabled
  const rawModules = campaign
    ? campaign.home_modules
    : (config?.home_modules ?? []).filter((m) => m.enabled);
  // campaign 已加载时即使为空也尊重其结果（管理员关掉了全部楼层）；仅未加载时用内置默认楼层
  const modules = (campaign || rawModules.length ? rawModules : fallbackModules(t))
    .slice()
    .sort((a, b) => a.sort - b.sort);
  const moduleOf = (type: string) => modules.find((m) => m.module === type);

  const retry = () => {
    setTimedOut(false);
    setAttempt((a) => a + 1);
    void refresh();
  };

  // 商品楼层按模块顺序切片，避免同一商品在两个楼层重复出现
  let cursor = 0;
  const take = (n: number) => {
    const slice = catalog.items.slice(cursor, cursor + n);
    cursor += slice.length;
    return slice;
  };
  // banner / image_nav / announce 有专属形态，其余模块按楼层渲染（商品楼层取真实目录数据）
  const standalone = ["banner", "image_nav", "announce"];
  const floors = modules.filter((m) => !standalone.includes(m.module)).map((m) => {
    if (m.module === "recommend") return { m, products: take(4) };
    if (m.module === "hot") return { m, products: take(8) };
    return { m, products: [] as ProductItem[] };
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:gap-6 md:py-6">
      {!ready && (
        <div className="grid place-items-center py-14">
          {timedOut ? (
            <div className="flex flex-col items-center gap-3 text-center animate-fade-up">
              <svg viewBox="0 0 24 24" className="size-10 text-amber-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" />
                <path d="M12 19.5h.01" />
                <path d="m3 3 18 18" />
              </svg>
              <p className="text-sm font-medium text-foreground">{t("home.timeout", "加载超时，请检查网络连接是否正常")}</p>
              <button type="button" onClick={retry} className="brand-gradient px-5 py-1.5 text-sm font-medium text-white transition hover:brightness-105">
                {t("common.retry", "重新加载")}
              </button>
            </div>
          ) : (
            <CartLoading label={failed ? t("home.loading_retry", "正在重试加载…") : t("home.loading", "正在加载商品…")} />
          )}
        </div>
      )}

      {ready && (
        <>
          <PullPeek pull={pull} hint={sfHint} />
          {sfPresent && <SecondFloorEntry title={sfTitle} hint={sfHint} />}
          <BannerCarousel module={moduleOf("banner")} siteName={config?.brand?.site_name ?? "ChicCart"} />
          <IconNav module={moduleOf("image_nav")} />
          <AnnounceBar module={moduleOf("announce")} live={announcements.banner} />
          {config?.switches?.installment === true && <InstallmentEntry />}
          <HomePopups items={announcements.popup} poster={campaign?.posters?.daily_popup} />

          {floors.map(({ m, products }) => {
            if (m.module === "recommend") {
              if (!products.length) return catalog.loaded && !catalog.error ? <EmptyProducts key={m.module} /> : null;
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
          })}

          {catalog.error && <p className="border-t border-border/70 bg-muted/60 px-3 py-6 text-center text-sm text-muted-foreground">{catalog.error}</p>}
        </>
      )}
    </div>
  );
}

function EmptyProducts() {
  const { t } = useSite();
  return (
    <section className="border-t border-border/70 pt-3">
      <SectionTitle title={t("home.section_recommend", "精选推荐")} more="/category" />
      <p className="bg-muted/60 px-3 py-6 text-center text-sm text-muted-foreground">
        {t("home.recommend_empty", "暂时没有可推荐的商品")}
      </p>
    </section>
  );
}
