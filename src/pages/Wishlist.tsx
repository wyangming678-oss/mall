// 我的收藏 WL1（A8）：浏览收藏商品，可跳转详情或取消收藏
import { useCallback, useEffect, useState } from "react";
import { call, newIdem } from "../api";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { formatBase, pickLocalized } from "../const";
import { CartLoading } from "../components/CartLoading";
import { ProductCover } from "../components/ProductCard";
import { fmtDate, shopErr, type WishlistItem, type WishlistListResult } from "../trade";

export function WishlistPage() {
  const { user, ready, lang, t, tf } = useSite();
  const [items, setItems] = useState<WishlistItem[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (nextOffset: number, append: boolean) => {
    setLoading(true);
    setError("");
    try {
      const r = await call<WishlistListResult>("wishlist/list", { query: { offset: nextOffset }, token: "user" });
      setItems((prev) => (append ? [...(prev ?? []), ...r.items] : r.items));
      setOffset(r.next_offset ?? nextOffset + r.items.length);
      setHasMore(r.has_more);
    } catch (e: unknown) {
      setError(shopErr(e));
      if (!append) setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void load(0, false);
  }, [user, load]);

  async function remove(item: WishlistItem) {
    if (busy) return;
    setBusy(item.product_id);
    setError("");
    try {
      await call("wishlist/toggle", {
        method: "POST", token: "user", idem: newIdem(), body: { product_id: item.product_id },
      });
      setItems((prev) => (prev ?? []).filter((x) => x.product_id !== item.product_id));
    } catch (e: unknown) {
      setError(shopErr(e));
    } finally {
      setBusy(null);
    }
  }

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("wish.loading", "正在加载收藏…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  return (
    <div className="mx-auto flex max-w-4xl flex-col px-4 py-6">
      <div className="flex items-center justify-between border-b border-border/70 pb-3">
        <h1 className="text-lg font-bold">{t("me.link_wishlist", "我的收藏")}</h1>
        <div className="flex gap-3 text-sm">
          <Link to="/category" className="text-primary underline">{t("home.banner_cta", "去逛逛")}</Link>
          <Link to="/me" className="text-muted-foreground underline">{t("common.account_center", "账户中心")}</Link>
        </div>
      </div>

      {error && <p className="mt-3 py-6 text-center text-sm text-destructive">{error}</p>}
      {!error && items === null && (
        <div className="grid place-items-center py-16"><CartLoading label={t("wish.loading", "正在加载收藏…")} /></div>
      )}
      {!error && items && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 border-b border-border/70 py-16 text-center">
          <p className="text-sm text-muted-foreground">{t("wish.empty", "还没有收藏任何商品")}</p>
          <p className="max-w-md text-xs text-muted-foreground">{t("wish.empty_hint", "在商品详情页点心形按钮即可收藏，方便之后回来比价。")}<Link to="/category" className="text-primary underline">{t("orders.browse", "去逛逛商品")}</Link></p>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="divide-y divide-border/70">
          {items.map((it) => {
            const itTitle = pickLocalized(it.title_i18n, it.title, lang);
            const itSub = pickLocalized(it.subtitle_i18n, it.subtitle ?? "", lang);
            return (
            <li key={it.product_id} className="flex items-center gap-3 py-4">
              <Link to={`/product?id=${it.product_id}`} className="size-20 shrink-0 overflow-hidden border bg-muted">
                <ProductCover imageKey={it.images[0]} alt={itTitle} />
              </Link>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link to={`/product?id=${it.product_id}`} className="truncate text-sm font-medium hover:text-primary">
                  {itTitle}
                  {!it.available && <span className="ml-2 border border-muted-foreground/40 px-1 text-[11px] text-muted-foreground">{t("status.cart.off", "已下架")}</span>}
                </Link>
                {itSub && <p className="truncate text-xs text-muted-foreground">{itSub}</p>}
                <p className="text-sm font-bold text-primary">{it.min_price === null ? "—" : formatBase(it.min_price)}</p>
                <p className="text-xs text-muted-foreground">{tf("wish.added_on", { date: fmtDate(it.added_at) }, "收藏于 {date}")}</p>
              </div>
              <button
                type="button"
                disabled={busy === it.product_id}
                onClick={() => void remove(it)}
                className="shrink-0 border bg-card px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-60"
              >
                {busy === it.product_id ? t("common.processing", "处理中…") : t("wish.unfav", "取消收藏")}
              </button>
            </li>
            );
          })}
        </ul>
      )}

      {items && items.length > 0 && hasMore && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(offset, true)}
          className="mt-2 w-full border-t border-border/70 py-3 text-sm text-primary disabled:opacity-60"
        >{loading ? t("common.loading", "加载中…") : t("common.loading_more", "加载更多")}</button>
      )}
    </div>
  );
}
