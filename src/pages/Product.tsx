import { useEffect, useState } from "react";
import { call, newIdem } from "../api";
import { usePath, useQuery, Link, navigate } from "../router";
import { useSite } from "../site";
import { formatBase, pickLocalized } from "../const";
import { brandText, tagText } from "../tagL10n";
import { CartLoading } from "../components/CartLoading";
import { ProductCover } from "../components/ProductCard";
import { ReviewSection } from "../components/ReviewSection";
import { resolveAssetUrl } from "../components/BrandMark";
import { announceCartChange, shopErr } from "../trade";
import type { WishlistStatusResult } from "../trade";
import type { ProductDetailResult } from "../catalog";

function SkuRow({ sku, active, onSelect }: { sku: ProductDetailResult["skus"][number]; active: boolean; onSelect: () => void }) {
  const { lang, t, tf } = useSite();
  const oos = sku.available_stock <= 0;
  const spec = pickLocalized(sku.spec_name_i18n, sku.spec_name, lang);
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={oos}
      className={
        "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left text-sm transition " +
        (active ? "border-primary bg-accent shadow-sm" : "bg-card hover:border-primary/60") +
        (oos ? " cursor-not-allowed opacity-50" : "")
      }
    >
      <span className="font-medium">{spec}</span>
      <span className="text-xs text-muted-foreground">
        {formatBase(sku.price_base)}
        {sku.original_price_base ? <s className="ml-1 opacity-70">{formatBase(sku.original_price_base)}</s> : null}
        {" · "}
        {oos ? t("product.oos", "缺货") : tf("product.stock", { n: sku.available_stock }, "库存 {n}")}
      </span>
    </button>
  );
}

export function ProductPage() {
  const path = usePath();
  const query = useQuery();
  const id = query.id ?? "";
  const { user, config, lang, t, tf } = useSite();
  const [data, setData] = useState<ProductDetailResult | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");
  const [skuIdx, setSkuIdx] = useState(0);
  const [qty, setQty] = useState(1);
  const [galleryIdx, setGalleryIdx] = useState(0);
  const [cartMsg, setCartMsg] = useState("");
  const [cartErr, setCartErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [favBusy, setFavBusy] = useState(false);

  useEffect(() => {
    if (path !== "/product") return;
    setData(null);
    setStatus("loading");
    if (!id) {
      setStatus("error");
      setErrMsg(t("product.missing_id", "缺少商品编号"));
      return;
    }
    let alive = true;
    void call<ProductDetailResult>("catalog/product", { query: { id } })
      .then((r) => { if (alive) { setData(r); setSkuIdx(0); setQty(1); setGalleryIdx(0); setStatus("ok"); } })
      .catch((e: unknown) => {
        if (!alive) return;
        setErrMsg(e instanceof Error && e.message ? e.message : t("product.load_failed", "商品加载失败"));
        setStatus("error");
      });
    return () => { alive = false; };
  }, [path, id]);

  // A8 收藏初值：仅登录用户回读，未登录一律未收藏
  const favProductId = data?.product.id ?? "";
  useEffect(() => {
    if (status !== "ok" || !favProductId) return;
    if (!user) { setFavorited(false); return; }
    let alive = true;
    void call<WishlistStatusResult>("wishlist/status", { query: { product_id: favProductId }, token: "user" })
      .then((r) => { if (alive) setFavorited(r.favorited); })
      .catch(() => { if (alive) setFavorited(false); });
    return () => { alive = false; };
  }, [status, favProductId, user]);

  if (status === "loading") {
    return (
      <div className="grid place-items-center py-16">
        <CartLoading label={t("product.loading", "正在加载商品详情…")} />
      </div>
    );
  }
  if (status === "error" || !data) {
    return (
      <div className="mx-auto grid max-w-6xl place-items-center gap-3 px-4 py-16 text-center">
        <p className="text-sm text-muted-foreground">{errMsg}</p>
        <Link to="/category" className="rounded-md brand-gradient px-5 py-1.5 text-sm font-medium text-white shadow-md shadow-primary/40">{t("product.browse_other", "去逛逛其他商品")}</Link>
      </div>
    );
  }

  const { product, skus, category } = data;
  const title = pickLocalized(product.title_i18n, product.title, lang);
  const subtitle = pickLocalized(product.subtitle_i18n, product.subtitle ?? "", lang);
  const desc = pickLocalized(product.description_i18n, product.description, lang);
  const catName = category ? pickLocalized(category.name_i18n, category.name, lang) : null;
  const sku = skus[skuIdx] ?? null;
  const images = product.images.length ? product.images : [null];
  // 与商品卡同一口径：后台手填优先，已售留空时函数侧已回落到各规格销量合计
  const rating = typeof product.rating_avg === "number" && product.rating_avg > 0 ? product.rating_avg : null;
  const sold = Number(product.sold_total ?? 0);
  const inst = config?.switches?.installment === true && product.installment?.enabled ? product.installment : null;
  const orderOpen = config?.switches?.order_open !== false;
  const canBuy = !!sku && sku.available_stock >= qty && sku.available_stock > 0;

  async function addToCart(then: "cart" | "checkout") {
    if (!sku || !canBuy) return;
    if (!user) { navigate("/login"); return; }
    setAdding(true);
    setCartErr("");
    setCartMsg("");
    try {
      const r = await call<{ cart_id: string; merged?: boolean }>("cart/add", {
        method: "POST", token: "user", idem: newIdem(), body: { sku_id: sku.id, quantity: qty },
      });
      announceCartChange();
      if (then === "checkout") navigate(`/checkout?ids=${r.cart_id}`);
      else setCartMsg(r.merged ? t("product.added_merged", "购物车中同款商品数量已累加") : t("product.added", "已加入购物车"));
    } catch (e) {
      setCartErr(shopErr(e));
    } finally {
      setAdding(false);
    }
  }

  async function toggleFav() {
    if (!user) { navigate("/login"); return; }
    if (favBusy) return;
    setFavBusy(true);
    setCartErr("");
    try {
      const r = await call<WishlistStatusResult>("wishlist/toggle", {
        method: "POST", token: "user", idem: newIdem(), body: { product_id: product.id },
      });
      setFavorited(r.favorited);
    } catch (e) {
      setCartErr(shopErr(e));
    } finally {
      setFavBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">
      <nav className="text-sm text-muted-foreground">
        <Link to="/" className="hover:text-primary">{t("product.breadcrumb_home", "首页")}</Link>
        <span className="mx-1">/</span>
        {category ? (
          <>
            <Link to={`/category?category=${category.id}`} className="hover:text-primary">{catName}</Link>
            <span className="mx-1">/</span>
          </>
        ) : null}
        <span className="text-foreground">{title}</span>
      </nav>

      <div className="grid gap-6 rounded-2xl border bg-card p-4 md:grid-cols-2 sm:p-6">
        <div className="flex flex-col gap-3">
          <div className="grid aspect-square place-items-center overflow-hidden rounded-2xl border bg-muted">
            <ProductImage imageKey={images[galleryIdx] ?? null} alt={title} />
          </div>
          {images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {images.map((k, i) => (
                <Thumb key={k ?? i} imageKey={k} active={i === galleryIdx} onPick={() => setGalleryIdx(i)} />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div>
            {product.brand && (
              <Link to={`/category?brand=${encodeURIComponent(product.brand)}`} className="text-sm font-medium text-primary hover:underline">
                {brandText(product.brand, lang)}
              </Link>
            )}
            <h1 className="text-xl font-bold sm:text-2xl">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
            <div className="mt-2 flex flex-wrap gap-1">
              {product.tags.map((tag) => (
                <span key={tag} className="rounded-md bg-accent px-2 py-0.5 text-xs text-accent-foreground">{tagText(tag, lang)}</span>
              ))}
            </div>
            {(rating !== null || sold > 0) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                {rating !== null && (
                  <span className="flex items-center gap-0.5 text-primary">
                    <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden><path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.2l5.9-.8L12 3z" /></svg>
                    {rating.toFixed(1)}
                    {product.rating_count ? tf("card.rating_n", { n: product.rating_count }, "({n})") : ""}
                  </span>
                )}
                {sold > 0 && <span>{tf("card.sold_n", { n: sold }, "已售 {n}")}</span>}
              </div>
            )}
          </div>

          <div className="rounded-xl bg-muted px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-2xl font-bold text-primary">{sku ? formatBase(sku.price_base) : "—"}</span>
              {sku?.original_price_base && <s className="text-sm text-muted-foreground">{formatBase(sku.original_price_base)}</s>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {sku ? tf("product.available_n", { n: sku.available_stock }, "可售 {n} 件") : t("product.pick_spec", "请选择规格")}
              {user ? tf("product.current_account", { name: user.nickname }, " · 当前账户：{name}") : t("product.login_to_cart", " · 登录后可加入购物车")}
            </p>
            {inst && (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2 text-xs">
                <span className="font-medium text-primary">{t("installment.detail_title", "支持分期付款")}</span>
                {inst.periods.map((n) => (
                  <span key={n} className="border border-primary/40 px-1.5 py-0.5 text-primary">{tf("installment.period_n", { n }, "{n} 期")}</span>
                ))}
                <span className="text-muted-foreground">{t("installment.detail_pick_hint", "下单结算时选期，首付 30% 即发货")}</span>
              </div>
            )}
          </div>

          {skus.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{t("common.spec", "规格")}</p>
              <div className="flex flex-wrap gap-2">
                {skus.map((s, i) => (
                  <SkuRow key={s.id} sku={s} active={i === skuIdx} onSelect={() => { setSkuIdx(i); setQty(1); }} />
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium">{t("common.quantity", "数量")}</span>
            <div className="flex items-center rounded-md border">
              <button type="button" className="px-3 py-1 disabled:opacity-40" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1}>−</button>
              <span className="w-10 text-center">{qty}</span>
              <button type="button" className="px-3 py-1 disabled:opacity-40" onClick={() => setQty((q) => Math.min(999, q + 1))} disabled={!sku || qty >= sku.available_stock}>＋</button>
            </div>
            <span className="font-bold">{t("product.total", "合计")} {sku ? formatBase(sku.price_base * qty) : "—"}</span>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <button
                type="button"
                disabled={favBusy}
                onClick={() => void toggleFav()}
                className={
                  "flex items-center gap-1.5 rounded-xl border px-4 py-2 text-sm font-medium transition disabled:opacity-60 " +
                  (favorited ? "border-primary bg-primary/10 text-primary" : "bg-card text-muted-foreground hover:border-primary/60 hover:text-primary")
                }
              >
                <svg viewBox="0 0 24 24" className="size-4" fill={favorited ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <path d="M12 20s-7-4.35-9.5-8.5C1 8.5 2.5 5 6 5c2 0 3.2 1.2 4 2.3C10.8 6.2 12 5 14 5c3.5 0 5 3.5 3.5 6.5C19 15.65 12 20 12 20Z" strokeLinejoin="round" />
                </svg>
                {favBusy ? t("common.processing", "处理中…") : favorited ? t("product.faved", "已收藏") : t("product.fav", "收藏")}
              </button>
              {user ? (
                <button type="button" onClick={() => navigate("/me/wishlist")} className="text-xs text-primary underline">{t("product.my_fav", "我的收藏")}</button>
              ) : (
                <button type="button" onClick={() => navigate("/login")} className="text-xs text-muted-foreground underline">{t("product.login_to_fav", "登录后收藏")}</button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!canBuy || adding}
                onClick={() => void addToCart("cart")}
                className="flex-1 rounded-xl border bg-card px-4 py-2.5 text-sm font-medium text-primary shadow-sm transition hover:border-primary disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-60"
              >
                {adding ? t("common.processing", "处理中…") : t("product.add_to_cart", "加入购物车")}
              </button>
              <button
                type="button"
                disabled={!canBuy || adding || !orderOpen}
                onClick={() => void addToCart("checkout")}
                className="flex-1 rounded-xl brand-gradient px-4 py-2.5 text-sm font-medium text-white shadow-md shadow-primary/40 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("product.buy_now", "立即下单")}
              </button>
            </div>
            {!user && <p className="text-xs text-muted-foreground">{t("product.login_hint", "登录后即可加购与下单；")}<button type="button" className="text-primary underline" onClick={() => navigate("/login")}>{t("product.login_now", "现在登录")}</button></p>}
            {!orderOpen && <p className="text-xs text-destructive">{t("product.order_closed_hint", "下单功能暂未开放")}</p>}
            {cartMsg && <p className="text-xs text-primary">{cartMsg} · <button type="button" className="underline" onClick={() => navigate("/cart")}>{t("product.view_cart", "查看购物车")}</button></p>}
            {cartErr && <p className="text-xs text-destructive">{cartErr}</p>}
          </div>
        </div>
      </div>

      {(product.description || skus.length > 0) && (
        <section className="rounded-2xl border bg-card p-4 sm:p-6">
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <span className="h-4 w-1 rounded-md brand-gradient" />
            {t("product.detail_title", "商品详情")}
          </h2>
          {desc
            ? <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{desc}</p>
            : <p className="text-sm text-muted-foreground">{t("product.no_desc", "商家暂未填写图文详情")}</p>}
        </section>
      )}

      <ReviewSection productId={product.id} />
    </div>
  );
}

function ProductImage({ imageKey, alt }: { imageKey: string | null; alt: string }) {
  return <ProductCover imageKey={imageKey} alt={alt} className="size-full object-contain" />;
}

function Thumb({ imageKey, active, onPick }: { imageKey: string | null; active: boolean; onPick: () => void }) {
  const { t } = useSite();
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (imageKey) void resolveAssetUrl(imageKey).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [imageKey]);
  useEffect(() => setBroken(false), [url]);
  return (
    <button
      type="button"
      onClick={onPick}
      className={"size-16 shrink-0 overflow-hidden rounded-xl border bg-muted p-0.5 transition " + (active ? "border-primary shadow-sm" : "hover:border-primary/60")}
      aria-label={t("product.view_large", "查看大图")}
    >
      {url && !broken
        ? <img src={url} alt="" className="size-full rounded-lg object-cover" onError={() => setBroken(true)} />
        : <span className="block size-full rounded-lg bg-muted-foreground/20" />}
    </button>
  );
}
