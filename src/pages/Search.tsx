// 搜索结果页 /search：顶栏搜索落到这里，页面自带输入框可原地改写关键词
import { useEffect, useState, type FormEvent } from "react";
import { Link, navigate, useQuery } from "../router";
import { useCatalogProducts } from "../catalog";
import { useSite } from "../site";
import { CartLoading } from "../components/CartLoading";
import { ProductCard } from "../components/ProductCard";
import { Input } from "@/components/ui/input";

export function SearchPage() {
  const { t, tf } = useSite();
  const query = useQuery();
  const keyword = query.q ?? "";
  const [text, setText] = useState(keyword);
  useEffect(() => { setText(keyword); }, [keyword]);

  const { items, loading, loaded, error, hasMore, loadMore } = useCatalogProducts({ keyword });

  function submit(e: FormEvent) {
    e.preventDefault();
    const kw = text.trim();
    navigate(kw ? `/search?q=${encodeURIComponent(kw)}` : "/search");
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">
      <form onSubmit={submit} className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("search.placeholder", "搜索商品名称 / 关键词")}
          aria-label={t("site.search", "搜索商品")}
          maxLength={50}
          className="h-10 flex-1"
        />
        <button type="submit" className="h-10 shrink-0 rounded-md brand-gradient px-5 text-sm font-medium text-white">{t("common.search", "搜索")}</button>
      </form>

      {keyword ? (
        <p className="text-sm text-muted-foreground">
          {tf("search.results_for", { kw: keyword }, "“{kw}” 的搜索结果")}{loaded && !error ? tf("search.result_count", { n: items.length }, " · 共 {n} 件") : ""}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{t("search.idle_hint", "输入关键词开始搜索商品。")}</p>
      )}

      {error && <p className="py-10 text-center text-sm text-muted-foreground">{error}</p>}
      {keyword && !loaded && !error && (
        <div className="grid place-items-center py-14"><CartLoading label={t("search.loading", "正在搜索商品…")} /></div>
      )}
      {keyword && loaded && !error && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 border-y border-border/70 py-14 text-center">
          <p className="text-sm text-muted-foreground">{t("search.empty", "没有找到相关商品")}</p>
          <p className="max-w-md text-xs text-muted-foreground">{t("search.empty_hint", "换个关键词试试，或到")} <Link to="/category" className="text-primary underline">{t("home.nav_all_category", "全部分类")}</Link> {t("search.empty_tail", "浏览。")}</p>
        </div>
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
