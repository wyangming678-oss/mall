// 购物车页 C1/C3/C4 + 去结算入口（文档C §三）
import { useState } from "react";
import { call, newIdem } from "../api";
import { Link, navigate, RedirectTo } from "../router";
import { useSite } from "../site";
import { formatBase, pickLocalized } from "../const";
import { CartLoading } from "../components/CartLoading";
import { ProductCover } from "../components/ProductCard";
import { announceCartChange, CART_REASON_TEXT, shopErr, useLoader, type CartItem, type CartResult } from "../trade";

function ItemRow({ item, onChanged, busy, setBusy }: {
  item: CartItem;
  onChanged: () => void;
  busy: boolean;
  setBusy: (v: boolean) => void;
}) {
  const { lang, t, tf } = useSite();
  const [error, setError] = useState("");
  const price = item.sku?.price_base ?? 0;
  const dead = !item.purchasable;
  const title = item.product ? pickLocalized(item.product.title_i18n, item.product.title, lang) : null;
  const spec = item.sku ? pickLocalized(item.sku.spec_name_i18n, item.sku.spec_name, lang) : null;

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await call("cart/update", { method: "POST", token: "user", idem: newIdem(), body: { cart_id: item.id, ...body } });
      onChanged();
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={"flex gap-3 border bg-card p-3 " + (dead ? "opacity-70" : "")}>
      <label className="flex items-center pt-1">
        <input
          type="checkbox"
          className="size-4 accent-[var(--primary)]"
          checked={item.selected}
          disabled={dead || busy}
          onChange={(e) => void patch({ selected: e.target.checked })}
          aria-label={tf("cart.check_aria", { name: title ?? t("home.nav_product", "商品") }, "勾选 {name}")}
        />
      </label>
      <Link to={`/product?id=${item.product?.id ?? ""}`} className="size-20 shrink-0 overflow-hidden rounded-xl border bg-muted">
        <ProductCover imageKey={item.product?.images?.[0]} alt={title ?? ""} />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link to={`/product?id=${item.product?.id ?? ""}`} className="line-clamp-2 text-sm font-medium hover:text-primary">
          {title ?? t("cart.gone", "商品已下架或删除")}
        </Link>
        <p className="text-xs text-muted-foreground">
          {item.sku ? `${spec} · ${item.sku.sku_code}` : t("cart.spec_changed", "规格信息已变更")}
          {item.available_stock > 0 ? tf("cart.available_n", { n: item.available_stock }, " · 可售 {n}") : ""}
        </p>
        {dead && (
          <p className="text-xs text-destructive">
            {t("status.cart." + (item.reason ?? "off"), CART_REASON_TEXT[item.reason ?? "off"] ?? t("cart.unavailable", "不可购买"))}
            {item.reason === "stock" ? tf("cart.remaining_n", { n: item.available_stock }, "（仅剩 {n} 件）") : ""}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <span className="text-sm font-bold text-primary">{formatBase(price)}</span>
          <span className={"flex items-center rounded-md border " + (dead ? "opacity-50" : "")}>
            <button
              type="button"
              className="px-2.5 py-1 text-sm disabled:opacity-40"
              disabled={dead || busy || item.quantity <= 1}
              onClick={() => void patch({ quantity: item.quantity - 1 })}
            >−</button>
            <span className="w-9 text-center text-sm">{item.quantity}</span>
            <button
              type="button"
              className="px-2.5 py-1 text-sm disabled:opacity-40"
              disabled={dead || busy || item.quantity >= 999}
              onClick={() => void patch({ quantity: item.quantity + 1 })}
            >＋</button>
          </span>
          <span className="text-xs text-muted-foreground">{t("cart.subtotal", "小计")} {formatBase(price * item.quantity)}</span>
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground underline hover:text-destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await call("cart/remove", { method: "POST", token: "user", idem: newIdem(), body: { cart_id: item.id } });
                announceCartChange();
                onChanged();
              } catch (e) {
                setError(shopErr(e));
              } finally {
                setBusy(false);
              }
            }}
          >{t("cart.remove", "移除")}</button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </li>
  );
}

export function CartPage() {
  const { user, ready, config, t, tf } = useSite();
  const { data, loading, error, refresh } = useLoader<CartResult>(
    () => call<CartResult>("cart/list", { token: "user" }),
    [user?.id],
  );
  const [busy, setBusy] = useState(false);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("cart.loading", "正在加载购物车…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  const items = data?.items ?? [];
  const summary = data?.summary;
  const buyableSelected = items.filter((it) => it.selected && it.purchasable);
  const orderOpen = config?.switches?.order_open !== false;

  async function toggleAll() {
    const candidates = items.filter((it) => it.purchasable);
    if (!candidates.length) return;
    const target = !candidates.every((it) => it.selected);
    setBusy(true);
    try {
      await Promise.all(candidates.filter((it) => it.selected !== target)
        .map((it) => call("cart/update", { method: "POST", token: "user", idem: newIdem(), body: { cart_id: it.id, selected: target } })));
      refresh();
    } catch (e) {
      window.alert(shopErr(e));
    } finally {
      setBusy(false);
    }
  }

  const allSelected = items.some((it) => it.purchasable) && items.filter((it) => it.purchasable).every((it) => it.selected);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{t("cart.title", "购物车")}<span className="ml-2 text-sm font-normal text-muted-foreground">{summary ? tf("cart.count_kinds", { n: summary.count }, "{n} 种商品") : ""}</span></h1>
        <button type="button" className="text-sm text-primary underline" onClick={refresh} disabled={busy}>{t("cart.refresh", "刷新")}</button>
      </div>

      {loading && !data && <div className="grid place-items-center py-16"><CartLoading label={t("cart.loading", "正在加载购物车…")} /></div>}
      {error && <p className="rounded-xl border bg-card px-4 py-3 text-sm text-destructive">{error}</p>}

      {data && !items.length && (
        <div className="grid place-items-center gap-3 rounded-2xl border bg-card py-14 text-center">
          <CartLoading label={t("cart.empty", "购物车还是空的")} />
          <Link to="/category" className="rounded-md brand-gradient px-5 py-1.5 text-sm font-medium text-white shadow-md shadow-primary/40">{t("cart.pick_something", "去挑选商品")}</Link>
        </div>
      )}

      {!!items.length && (
        <>
          <div className="flex items-center gap-3 px-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={allSelected} disabled={busy} onChange={() => void toggleAll()} />
              {t("cart.select_all", "全选可购商品")}
            </label>
            <span className="text-muted-foreground">{tf("cart.selected_kinds", { n: buyableSelected.length }, "已选 {n} 种")}</span>
          </div>
          <ul className="flex flex-col gap-3">
            {items.map((it) => (
              <ItemRow key={it.id} item={it} onChanged={refresh} busy={busy} setBusy={setBusy} />
            ))}
          </ul>
        </>
      )}

      <div className="sticky bottom-0 -mx-4 mt-2 flex flex-wrap items-center gap-3 border-t bg-card/95 px-4 py-3 backdrop-blur">
        <span className="text-sm">{t("cart.total", "合计")}</span>
        <span className="text-xl font-bold text-primary">{formatBase(summary?.selected_amount_base ?? 0)}</span>
        {!orderOpen && <span className="text-xs text-destructive">{t("cart.order_closed", "下单功能暂未开放")}</span>}
        <button
          type="button"
          disabled={!orderOpen || busy || buyableSelected.length === 0}
          onClick={() => navigate(`/checkout?ids=${buyableSelected.map((it) => it.id).join(",")}`)}
          className="ml-auto rounded-md brand-gradient px-6 py-2 text-sm font-medium text-white shadow-md shadow-primary/40 transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("cart.checkout", "去结算")}
        </button>
      </div>
    </div>
  );
}
