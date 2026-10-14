import { navigate, useQuery } from "../router";
import { useSite } from "../site";
import { pickLocalized } from "../const";
import { brandText } from "../tagL10n";
import { useCatalogBrands, useCatalogCategories, useCatalogProducts } from "../catalog";
import { CartLoading } from "../components/CartLoading";
import { ProductCard } from "../components/ProductCard";

export function CategoryPage() {
  const { t, tf, lang } = useSite();
  const query = useQuery();
  const active = query.category ?? "";
  const keyword = query.q ?? "";
  const brand = query.brand ?? "";
  const categories = useCatalogCategories();
  const brands = useCatalogBrands(active || null);
  const { items, loading, loaded, error, hasMore, loadMore } = useCatalogProducts({
    category_id: active || null,
    keyword,
    brand,
  });

  const pick = (id: string) => navigate(id ? `/category?category=${id}` : "/category");
  const pickBrand = (b: string) => {
    const params = new URLSearchParams();
    if (active) params.set("category", active);
    if (keyword) params.set("q", keyword);
    if (b) params.set("brand", b);
    const qs = params.toString();
    navigate(qs ? `/category?${qs}` : "/category");
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">
          {keyword ? tf("cat.search_title", { kw: keyword }, "搜索：{kw}")
            : brand ? tf("cat.brand_title", { brand }, "品牌：{brand}")
              : t("cat.all_products", "全部商品")}
        </h1>
        {keyword && (
          <button type="button" onClick={() => navigate("/category")} className="rounded-md border bg-card px-3 py-1 text-sm text-muted-foreground hover:border-primary">{t("cat.clear_keyword", "清除关键词")}</button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => pick("")}
          className={"rounded-md border px-3 py-1 text-sm transition " + (active === "" ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}
        >
          {t("common.all", "全部")}
        </button>
        {categories.map((c) => (
          <span key={c.id} className="contents">
            <button
              type="button"
              onClick={() => pick(c.id)}
              className={"rounded-md border px-3 py-1 text-sm transition " + (active === c.id ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}
            >
              {pickLocalized(c.name_i18n, c.name, lang)}
            </button>
            {(c.children ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => pick(s.id)}
                className={"rounded-md border px-3 py-1 text-sm transition " + (active === s.id ? "border-primary bg-primary text-primary-foreground" : "bg-card/60 text-muted-foreground hover:border-primary hover:text-foreground")}
              >
                {pickLocalized(c.name_i18n, c.name, lang)} · {pickLocalized(s.name_i18n, s.name, lang)}
              </button>
            ))}
          </span>
        ))}
      </div>

      {brands.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">{t("cat.brand", "品牌")}</span>
          <button
            type="button"
            onClick={() => pickBrand("")}
            className={"rounded-md border px-3 py-1 text-sm transition " + (brand === "" ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}
          >
            {t("cat.all_brands", "全部品牌")}
          </button>
          {brands.map((b) => (
            <button
              key={b.brand}
              type="button"
              onClick={() => pickBrand(b.brand)}
              className={"rounded-md border px-3 py-1 text-sm transition " + (brand === b.brand ? "border-primary bg-primary text-primary-foreground" : "bg-card/60 text-muted-foreground hover:border-primary hover:text-foreground")}
            >
              {brandText(b.brand, lang)}
              <span className="ml-1 text-xs opacity-70">{b.products}</span>
            </button>
          ))}
        </div>
      )}

      {!loaded && !error && (
        <div className="grid place-items-center py-14">
          <CartLoading label={t("home.loading", "正在加载商品…")} />
        </div>
      )}
      {error && <p className="py-10 text-center text-sm text-muted-foreground">{error}</p>}
      {loaded && !error && items.length === 0 && (
        <p className="rounded-2xl border bg-card px-4 py-14 text-center text-sm text-muted-foreground">
          {t("cat.empty", "该分类下还没有上架商品，稍后再来看看")}
        </p>
      )}
      {items.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((p) => <ProductCard key={p.id} item={p} />)}
        </div>
      )}
      {hasMore && !loading && (
        <div className="grid place-items-center">
          <button type="button" onClick={loadMore} className="rounded-md border bg-card px-6 py-1.5 text-sm hover:border-primary">{t("common.loading_more", "加载更多")}</button>
        </div>
      )}
      {loading && loaded && <p className="text-center text-sm text-muted-foreground">{t("common.loading", "加载中…")}</p>}
    </div>
  );
}
