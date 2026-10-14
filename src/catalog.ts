// 商品目录共享类型与取数（文档C §三 P1–P3 响应形状）
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "./api";
import { text } from "./i18n";
import type { InstallmentProductConfig } from "./installments";

export interface CategoryNode {
  id: string;
  parent_id: string | null;
  name: string;
  name_i18n: Record<string, string> | null;
  icon_key: string | null;
  sort_order: number;
  status: string;
  children?: CategoryNode[];
}

export interface ProductItem {
  id: string;
  category_id: string;
  title: string;
  title_i18n: Record<string, string> | null;
  subtitle: string | null;
  subtitle_i18n?: Record<string, string> | null;
  brand: string | null;
  images: string[];
  tags: string[];
  sort_order: number;
  category_name?: string | null;
  category_name_i18n?: Record<string, string> | null;
  min_price: number | null;
  total_stock: number;
  /** 文档N 分期：商品分期配置 + 评分/已售（catalog.mjs decorateProducts 已下发，此前前端未取用） */
  installment?: InstallmentProductConfig;
  rating_avg?: number | null;
  rating_count?: number;
  sold_total?: number;
}

export interface ProductsPage {
  offset: number;
  limit: number;
  has_more: boolean;
  items: ProductItem[];
}

export interface ProductSku {
  id: string;
  spec_name: string;
  spec_name_i18n?: Record<string, string> | null;
  sku_code: string;
  price_base: number;
  original_price_base: number | null;
  currency_prices: Record<string, number>;
  available_stock: number;
  sold_count: number;
}

export interface ProductFull extends ProductItem {
  description: string;
  description_i18n?: Record<string, string> | null;
  extra: Record<string, unknown>;
  status?: string;
}

export interface ProductDetailResult {
  product: ProductFull;
  skus: ProductSku[];
  category: { id: string; name: string; name_i18n: Record<string, string> | null } | null;
}

/**
 * 目录指纹广播：SiteProvider 轮询 bootstrap 发现 catalog_version 变化后调用，
 * 已打开的分类/品牌/商品列表据此重取 —— 后台上架无需刷新页面。
 */
const CATALOG_EVENT = "mall:catalog-change";

export function announceCatalogChange() {
  window.dispatchEvent(new Event(CATALOG_EVENT));
}

function useCatalogTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    window.addEventListener(CATALOG_EVENT, fn);
    return () => window.removeEventListener(CATALOG_EVENT, fn);
  }, []);
  return tick;
}

export function useCatalogCategories() {
  const [items, setItems] = useState<CategoryNode[]>([]);
  const tick = useCatalogTick();
  useEffect(() => {
    let alive = true;
    call<{ items: CategoryNode[] }>("catalog/categories")
      .then((r) => { if (alive) setItems(r.items); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [tick]);
  return items;
}

export interface BrandFacet { brand: string; products: number }

/** P4 品牌聚合：在售商品的非空品牌去重计数，可按分类收窄 */
export function useCatalogBrands(categoryId?: string | null) {
  const [items, setItems] = useState<BrandFacet[]>([]);
  const tick = useCatalogTick();
  useEffect(() => {
    let alive = true;
    call<{ items: BrandFacet[] }>("catalog/brands", { query: { category_id: categoryId || undefined } })
      .then((r) => { if (alive) setItems(r.items); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [categoryId, tick]);
  return items;
}

/** 服务端固定每页 20 条；重取时最多回补 5 页，避免深滚列表发出几十次往返 */
const PAGE = 20;
const MAX_RELOAD_PAGES = 5;

/** 追加式分页：loadMore 拼接下一页（offset+20，服务端读 21 判 hasMore）；目录指纹变化时按当前深度整体重取 */
export function useCatalogProducts(params: { category_id?: string | null; keyword?: string; brand?: string; installment?: boolean }) {
  const key = `${params.category_id ?? ""}|${params.keyword ?? ""}|${params.brand ?? ""}|${params.installment ? "i" : ""}`;
  const tick = useCatalogTick();
  const [state, setState] = useState<{ items: ProductItem[]; hasMore: boolean; loading: boolean; error: string | null; loaded: boolean }>({
    items: [], hasMore: false, loading: false, error: null, loaded: false,
  });
  const pagesRef = useRef(1);
  const keyRef = useRef(key);

  // key 变化时 params 即新闭包；依赖数组仅需 key
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetchOne = useCallback((offset: number) => call<ProductsPage>("catalog/products", {
    query: {
      category_id: params.category_id || undefined,
      keyword: params.keyword || undefined,
      brand: params.brand || undefined,
      installment: params.installment ? "true" : undefined,
      offset,
    },
  }), [key]);

  const reload = useCallback(async (pages: number) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const n = Math.min(Math.max(pages, 1), MAX_RELOAD_PAGES);
      const resp = await Promise.all(Array.from({ length: n }, (_, i) => fetchOne(i * PAGE)));
      const seen = new Set<string>();
      const items: ProductItem[] = [];
      for (const page of resp) {
        for (const it of page.items) {
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          items.push(it);
        }
      }
      pagesRef.current = n;
      setState({ items, hasMore: resp[n - 1].has_more, loading: false, error: null, loaded: true });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof Error && e.message ? e.message : text("common.load_failed", "加载失败"), loaded: true }));
    }
  }, [fetchOne]);

  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      pagesRef.current = 1;
    }
    void reload(pagesRef.current);
  }, [key, tick, reload]);

  const loadMore = useCallback(() => {
    void fetchOne(pagesRef.current * PAGE)
      .then((page) => {
        pagesRef.current += 1;
        setState((s) => ({ items: [...s.items, ...page.items], hasMore: page.has_more, loading: false, error: null, loaded: true }));
      })
      .catch((e) => setState((s) => ({ ...s, loading: false, error: e instanceof Error && e.message ? e.message : text("common.load_failed", "加载失败") })));
  }, [fetchOne]);

  return { ...state, loadMore };
}
