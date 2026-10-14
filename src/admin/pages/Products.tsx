import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, call, newIdem } from "../../api";
import { useAdmin, hasPerm } from "../AdminAuth";
import { PageTitle, Toolbar, errText, riskyPost, useBusy } from "../ui";
import { useAssetUrl } from "../../components/BrandMark";
import { baseUnit, formatBase } from "../../const";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { INSTALLMENT_PERIODS, type InstallmentProductConfig } from "../../installments";

interface CategoryRow { id: string; parent_id: string | null; name: string; name_i18n: Record<string, string> | null; icon_key: string | null; sort_order: number; status: string }
interface ListRow {
  id: string; category_id: string; title: string; brand: string | null; subtitle: string | null; images: string[];
  status: string; sort_order: number; min_price: number | null; total_stock: number; frozen_stock: number; sku_count: number;
}
interface SkuRow {
  id: string | null; spec_name: string; spec_en: string; spec_ja: string; spec_ko: string; spec_es: string;
  sku_code: string;
  price_yuan: string; original_yuan: string; stock: number; frozen: number; sold: number;
  status: "on" | "off";
}
const emptySku = (): SkuRow => ({
  id: null, spec_name: "", spec_en: "", spec_ja: "", spec_ko: "", spec_es: "", sku_code: "",
  price_yuan: "", original_yuan: "", stock: 0, frozen: 0, sold: 0, status: "on",
});
interface LogRow {
  id: string; sku_id: string; change_type: string; quantity: number;
  available_before: number; available_after: number; reference_type: string; reason: string | null;
  created_at: string; sku: { sku_code: string; spec_name: string } | null;
}

const STATUS_LABEL: Record<string, string> = { draft: "草稿", on: "在售", off: "已下架" };

async function uploadImage(file: File, prefix: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return call<{ key: string }>("file/upload", {
    method: "POST", token: "admin", idem: newIdem(),
    body: { name: file.name, data_base64: btoa(bin), prefix },
  }).then((r) => r.key);
}

const yuan2cents = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

// —— 批量导入：CSV 固定模板 + 免依赖解析（处理引号/内嵌逗号与换行/转义引号）——
// 新列一律追加在末尾：无表头按位取列，插中间会让老模板整体错位。
const COLS = ["category_name", "group_key", "title", "subtitle", "description", "spec_name", "sku_code", "price", "original", "stock", "status", "brand"] as const;
const norm = (s: string) => s.trim().toLowerCase().replace(/[^0-9a-z一-龥]/g, "").replace(/元$/, "");
const LABEL_KEY: Record<string, string> = {
  分类: "category_name", 分类名: "category_name", 类目: "category_name",
  款号: "group_key", 标题: "title", 名称: "title", 副标题: "subtitle",
  描述: "description", 详情: "description", 规格: "spec_name", 规格名: "spec_name",
  sku编码: "sku_code", sku: "sku_code", 编码: "sku_code",
  售价: "price", 价格: "price", 原价: "original", 划线价: "original",
  库存: "stock", 可售库存: "stock", 状态: "status", 品牌: "brand",
};
const STATUS_CODE: Record<string, string> = {
  在售: "on", 上架: "on", on: "on", 下架: "off", off: "off", 草稿: "draft", draft: "draft",
};
const ACTION_LABEL: Record<string, string> = { created: "新建 SKU", updated: "更新 SKU", error: "失败" };

function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQ = false;
  const push = () => { row.push(field); rows.push(row); row = []; field = ""; };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") push();
    else field += c;
  }
  if (field.length > 0 || row.length > 0) push();
  return rows;
}

interface BulkItem {
  no: number;
  show: { category: string; group: string; title: string; sku: string; price: string; stock: string; status: string };
  row: Record<string, unknown> | null;
  error: string | null;
  result?: { action: string; error?: string };
}

function buildItems(matrix: string[][]): { headerSkipped: boolean; items: BulkItem[] } {
  if (!matrix.length) return { headerSkipped: false, items: [] };
  const headerSkipped = matrix[0].some((c) => norm(c) in LABEL_KEY);
  const idx = COLS.map((key, ci) => {
    if (!headerSkipped) return ci;
    const at = matrix[0].findIndex((c) => LABEL_KEY[norm(c)] === key);
    return at;
  });
  const get = (r: string[], key: (typeof COLS)[number]) => {
    const col = idx[COLS.indexOf(key)];
    return col >= 0 ? (r[col] ?? "").trim() : "";
  };
  const data = headerSkipped ? matrix.slice(1) : matrix;
  const items: BulkItem[] = [];
  data.forEach((r, i) => {
    if (r.every((c) => c.trim() === "")) return;
    const category_name = get(r, "category_name");
    const title = get(r, "title");
    const sku_code = get(r, "sku_code");
    const priceRaw = get(r, "price");
    const originalRaw = get(r, "original");
    const stockRaw = get(r, "stock");
    const statusRaw = get(r, "status");
    const price = yuan2cents(priceRaw);
    const stockNum = stockRaw === "" ? 0 : Number(stockRaw);
    const status = statusRaw === "" ? "draft" : (STATUS_CODE[norm(statusRaw)] ?? null);
    let error: string | null = null;
    if (!category_name) error = "分类名为空";
    else if (!title) error = "标题为空";
    else if (!/^[A-Za-z0-9_-]{4,40}$/.test(sku_code)) error = "SKU 编码需 4–40 位字母/数字/-/_";
    else if (price === null) error = "售价无效（需 >0）";
    else if (originalRaw && yuan2cents(originalRaw) === null) error = "原价无效";
    else if (!Number.isInteger(stockNum) || stockNum < 0) error = "库存需为非负整数";
    else if (!status) error = "状态只认 在售/下架/草稿";
    const row = error ? null : {
      category_name,
      group_key: get(r, "group_key"),
      title,
      subtitle: get(r, "subtitle") || undefined,
      description: get(r, "description") || undefined,
      spec_name: get(r, "spec_name") || "标准",
      sku_code,
      price_base: price,
      original_price_base: originalRaw ? yuan2cents(originalRaw) ?? undefined : undefined,
      available_stock: stockNum,
      status,
      brand: get(r, "brand") || undefined,
    };
    items.push({
      no: i + 1,
      show: { category: category_name, group: get(r, "group_key"), title, sku: sku_code, price: priceRaw, stock: stockRaw || "0", status: status || statusRaw },
      row, error,
    });
  });
  return { headerSkipped, items };
}

const TEMPLATE = [
  "分类名,款号,标题,副标题,描述,规格名,SKU编码,售价,原价,库存,状态,品牌",
  '连衣裙,DR-100,夏季碎花连衣裙,轻薄透气,"面料柔软，适合夏季穿着",标准,SKU-DR100-A,129.00,199.00,50,在售,云栖',
  "连衣裙,DR-100,夏季碎花连衣裙,,,白色 S,SKU-DR100-B,129.00,199.00,30,在售,云栖",
  "帽子,,棒球帽,,同款帽可只填一行,T恤蓝,SKU-CAP-01,59.00,,100,草稿,",
].join("\n");

function ImageCell({ imageKey }: { imageKey: string | null | undefined }) {
  const url = useAssetUrl(imageKey ?? null);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  return (
    <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted">
      {url && !broken
        ? <img src={url} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
        : <span className="text-[10px] text-muted-foreground">无图</span>}
    </span>
  );
}

// —— SPU+SKU 编辑器 ——
/** 多语录入 → *_i18n：留空的语言不写入，买家端自动回落中文原文 */
function i18nMap(vals: { en: string; ja: string; ko: string; es: string }): Record<string, string> {
  const m: Record<string, string> = {};
  if (vals.en.trim()) m.en = vals.en.trim();
  if (vals.ja.trim()) m.ja = vals.ja.trim();
  if (vals.ko.trim()) m.ko = vals.ko.trim();
  if (vals.es.trim()) m.es = vals.es.trim();
  return m;
}
/** 已存译文是否有内容（空对象 {} 也算无，用于决定是否展开录入区） */
const hasText = (m: Record<string, string> | null | undefined) => Boolean(m && (m.en || m.ja || m.ko || m.es));

function ProductEditor({ productId, categories, onSaved, onCancel }: {  productId: string | null;
  categories: CategoryRow[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [spu, setSpu] = useState({
    category_id: "", title: "", title_en: "", title_ja: "", title_ko: "", title_es: "",
    subtitle: "", subtitle_en: "", subtitle_ja: "", subtitle_ko: "", subtitle_es: "",
    brand: "", description: "", desc_en: "", desc_ja: "", desc_ko: "", desc_es: "",
    tagsText: "", status: "draft", sort_order: "0", images: [] as string[],
    rating_avg: "", rating_count: "", sold_total: "",
  });
  const [inst, setInst] = useState<InstallmentProductConfig>({ enabled: false, periods: [] });
  // products.extra 是通用 jsonb：编辑时保留非 installment 的其他键，保存时并回去，避免整份覆盖丢数据
  const [extraRest, setExtraRest] = useState<Record<string, unknown>>({});
  const [skus, setSkus] = useState<SkuRow[]>([]);
  const [openI18n, setOpenI18n] = useState(false);
  const [skuI18n, setSkuI18n] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(productId !== null);
  const [error, setError] = useState("");
  const [busy, run] = useBusy();
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!productId) {
      setSkus([emptySku()]);
      setInst({ enabled: false, periods: [] });
      setExtraRest({});
      return;
    }
    let alive = true;
    void call<{ product: Record<string, unknown>; skus: Array<Record<string, unknown>> }>("admin/product", { token: "admin", query: { id: productId } })
      .then((r) => {
        if (!alive) return;
        const p = r.product as {
          category_id: string; title: string; title_i18n: Record<string, string> | null;
          subtitle: string | null; subtitle_i18n: Record<string, string> | null;
          brand: string | null; description: string; description_i18n: Record<string, string> | null;
          images: string[]; tags: string[]; status: string; sort_order: number;
          rating_avg: string | number | null; rating_count: number | null; sold_total: number | null;
          extra: { installment?: InstallmentProductConfig } | null;
        };
        setSpu({
          category_id: p.category_id, title: p.title,
          title_en: p.title_i18n?.en ?? "", title_ja: p.title_i18n?.ja ?? "", title_ko: p.title_i18n?.ko ?? "", title_es: p.title_i18n?.es ?? "",
          subtitle: p.subtitle ?? "",
          subtitle_en: p.subtitle_i18n?.en ?? "", subtitle_ja: p.subtitle_i18n?.ja ?? "", subtitle_ko: p.subtitle_i18n?.ko ?? "", subtitle_es: p.subtitle_i18n?.es ?? "",
          brand: p.brand ?? "", description: p.description ?? "",
          desc_en: p.description_i18n?.en ?? "", desc_ja: p.description_i18n?.ja ?? "", desc_ko: p.description_i18n?.ko ?? "", desc_es: p.description_i18n?.es ?? "",
          tagsText: (p.tags ?? []).join("，"), status: p.status, sort_order: String(p.sort_order), images: p.images ?? [],
          rating_avg: p.rating_avg === null || p.rating_avg === undefined ? "" : String(p.rating_avg),
          rating_count: p.rating_count ? String(p.rating_count) : "",
          sold_total: p.sold_total ? String(p.sold_total) : "",
        });
        setOpenI18n(hasText(p.subtitle_i18n) || hasText(p.description_i18n));
        const rawExtra = (p.extra ?? {}) as Record<string, unknown>;
        const restExtra: Record<string, unknown> = { ...rawExtra };
        delete restExtra.installment;
        setExtraRest(restExtra);
        setInst((rawExtra.installment as InstallmentProductConfig) ?? { enabled: false, periods: [] });
        setSkus((r.skus ?? []).map((s) => {
          const m = (s.spec_name_i18n ?? null) as Record<string, string> | null;
          return {
            id: s.id as string, spec_name: s.spec_name as string,
            spec_en: m?.en ?? "", spec_ja: m?.ja ?? "", spec_ko: m?.ko ?? "", spec_es: m?.es ?? "",
            sku_code: s.sku_code as string,
            price_yuan: String(((s.price_base as number) / 100).toFixed(2)),
            original_yuan: s.original_price_base ? String((Number(s.original_price_base) / 100).toFixed(2)) : "",
            stock: Number(s.available_stock), frozen: Number(s.frozen_stock), sold: Number(s.sold_count ?? 0),
            status: (s.status as "on" | "off"),
          };
        }));
        setLoading(false);
      })
      .catch((e: unknown) => { setError(errText(e)); setLoading(false); });
    return () => { alive = false; };
  }, [productId]);

  const setSku = (i: number, patch: Partial<SkuRow>) =>
    setSkus((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError("");
    await run(async () => {
      try {
        const body = {
          product_id: productId ?? undefined,
          category_id: spu.category_id,
          title: spu.title,
          title_i18n: i18nMap({ en: spu.title_en, ja: spu.title_ja, ko: spu.title_ko, es: spu.title_es }),
          subtitle: spu.subtitle || undefined,
          subtitle_i18n: i18nMap({ en: spu.subtitle_en, ja: spu.subtitle_ja, ko: spu.subtitle_ko, es: spu.subtitle_es }),
          brand: spu.brand.trim() || undefined,
          description: spu.description || undefined,
          description_i18n: i18nMap({ en: spu.desc_en, ja: spu.desc_ja, ko: spu.desc_ko, es: spu.desc_es }),
          tags: spu.tagsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 10),
          extra: { ...extraRest, installment: { enabled: inst.enabled && inst.periods.length > 0, periods: inst.periods } },
          images: spu.images.slice(0, 9),
          status: spu.status,
          sort_order: Number(spu.sort_order) || 0,
          rating_avg: spu.rating_avg.trim() || undefined,
          rating_count: spu.rating_count.trim() ? Number(spu.rating_count) : undefined,
          sold_total: spu.sold_total.trim() ? Number(spu.sold_total) : undefined,
          skus: skus.map((s) => ({
            id: s.id ?? undefined,
            spec_name: s.spec_name,
            spec_name_i18n: i18nMap({ en: s.spec_en, ja: s.spec_ja, ko: s.spec_ko, es: s.spec_es }),
            sku_code: s.sku_code,
            price_base: yuan2cents(s.price_yuan) ?? 0,
            original_price_base: s.original_yuan ? yuan2cents(s.original_yuan) ?? undefined : undefined,
            available_stock: s.id ? undefined : s.stock,
            status: s.status,
          })),
        };
        await call("admin/product/save", { method: "POST", token: "admin", idem: newIdem(), body });
        onSaved();
      } catch (err) {
        setError(errText(err));
      }
    });
  }

  async function onUpload(file: File) {
    setUploading(true);
    setError("");
    try {
      const key = await uploadImage(file, "products");
      setSpu((s) => ({ ...s, images: [...s.images, key].slice(0, 9) }));
    } catch (err) {
      setError(errText(err));
    } finally {
      setUploading(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">商品加载中…</p>;

  return (
    <Card>
      <CardHeader><CardTitle>{productId ? "编辑商品" : "新建商品"}</CardTitle></CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={onSave}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="pd-title">标题 *</Label>
              <Input id="pd-title" required maxLength={200} value={spu.title} onChange={(e) => setSpu({ ...spu, title: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pd-sub">副标题</Label>
              <Input id="pd-sub" maxLength={200} value={spu.subtitle} onChange={(e) => setSpu({ ...spu, subtitle: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label>多语言标题（选填，留空的语言自动显示中文标题）</Label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <Input aria-label="英文标题" maxLength={200} value={spu.title_en} onChange={(e) => setSpu({ ...spu, title_en: e.target.value })} placeholder="English" />
                <Input aria-label="日文标题" maxLength={200} value={spu.title_ja} onChange={(e) => setSpu({ ...spu, title_ja: e.target.value })} placeholder="日本語" />
                <Input aria-label="韩文标题" maxLength={200} value={spu.title_ko} onChange={(e) => setSpu({ ...spu, title_ko: e.target.value })} placeholder="한국어" />
                <Input aria-label="西语标题" maxLength={200} value={spu.title_es} onChange={(e) => setSpu({ ...spu, title_es: e.target.value })} placeholder="Español" />
              </div>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label>多语言副标题（选填，留空的语言自动显示中文副标题）</Label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <Input aria-label="英文副标题" maxLength={200} value={spu.subtitle_en} onChange={(e) => setSpu({ ...spu, subtitle_en: e.target.value })} placeholder="English" />
                <Input aria-label="日文副标题" maxLength={200} value={spu.subtitle_ja} onChange={(e) => setSpu({ ...spu, subtitle_ja: e.target.value })} placeholder="日本語" />
                <Input aria-label="韩文副标题" maxLength={200} value={spu.subtitle_ko} onChange={(e) => setSpu({ ...spu, subtitle_ko: e.target.value })} placeholder="한국어" />
                <Input aria-label="西语副标题" maxLength={200} value={spu.subtitle_es} onChange={(e) => setSpu({ ...spu, subtitle_es: e.target.value })} placeholder="Español" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pd-brand">品牌</Label>
              <Input id="pd-brand" maxLength={40} value={spu.brand} onChange={(e) => setSpu({ ...spu, brand: e.target.value })} placeholder="如 AURA / 云栖" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pd-cat">分类 *</Label>
              <select id="pd-cat" required className="h-9 rounded-md border bg-background px-2 text-sm" value={spu.category_id} onChange={(e) => setSpu({ ...spu, category_id: e.target.value })}>
                <option value="" disabled>选择分类</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.parent_id ? "— " : ""}{c.name}{c.status === "off" ? "（隐藏）" : ""}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="pd-status">状态</Label>
                <select id="pd-status" className="h-9 rounded-md border bg-background px-2 text-sm" value={spu.status} onChange={(e) => setSpu({ ...spu, status: e.target.value })}>
                  <option value="draft">草稿</option>
                  <option value="on">上架在售</option>
                  <option value="off">下架</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="pd-sort">排序</Label>
                <Input id="pd-sort" className="w-20" type="number" min={0} value={spu.sort_order} onChange={(e) => setSpu({ ...spu, sort_order: e.target.value })} />
              </div>
            </div>
            <div className="flex flex-col gap-2 border-t pt-3 sm:col-span-2">
              <p className="text-sm font-medium">前台展示数据</p>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="pd-rating">评分（0–5）</Label>
                  <Input id="pd-rating" className="w-24" type="number" min={0} max={5} step={0.01} placeholder="如 4.8" value={spu.rating_avg} onChange={(e) => setSpu({ ...spu, rating_avg: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="pd-rating-count">评价数</Label>
                  <Input id="pd-rating-count" className="w-24" type="number" min={0} max={999999} placeholder="如 126" value={spu.rating_count} onChange={(e) => setSpu({ ...spu, rating_count: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="pd-sold">已售数量</Label>
                  <Input id="pd-sold" className="w-24" type="number" min={0} max={9999999} placeholder="如 3000" value={spu.sold_total} onChange={(e) => setSpu({ ...spu, sold_total: e.target.value })} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                这三项决定商品卡与详情页上的「★ 评分（评价数）· 已售 N」。留空即不显示；已售留空时自动取各规格实际销量合计。评分以这里填写的为准，不会自动统计真实评价（详情页下方「商品评价」仍是买家评价原样列表）。
              </p>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="pd-tags">标签（逗号分隔，≤10）</Label>
              <Input id="pd-tags" value={spu.tagsText} onChange={(e) => setSpu({ ...spu, tagsText: e.target.value })} placeholder="新品，热销，包邮" />
            </div>
            <div className="flex flex-col gap-2 border-t pt-3 sm:col-span-2">
              <label className="flex items-center gap-3 text-sm">
                支持分期付款
                <Switch checked={inst.enabled} onCheckedChange={(v) => setInst((s) => ({ ...s, enabled: v }))} />
              </label>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-sm text-muted-foreground">可选期数（每月一期，0 息）</span>
                {INSTALLMENT_PERIODS.map((n) => {
                  const on = inst.periods.includes(n);
                  return (
                    <label key={n} className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={on}
                        disabled={!inst.enabled}
                        onChange={(e) => setInst((s) => ({
                          ...s,
                          periods: e.target.checked
                            ? [...s.periods, n].sort((a, b) => a - b)
                            : s.periods.filter((p) => p !== n),
                        }))}
                      />
                      {n} 期
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                开启并勾选后，前台商品卡显示「支持分期付款」，买家结算时从这些期数里选（多商品同单取交集）。至少勾一个期数才算开启。
              </p>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="pd-desc">图文详情（纯文本，≤5000）</Label>
              <textarea id="pd-desc" maxLength={5000} rows={4} className="rounded-md border bg-background px-3 py-2 text-sm" value={spu.description} onChange={(e) => setSpu({ ...spu, description: e.target.value })} />
              <button
                type="button"
                onClick={() => setOpenI18n((v) => !v)}
                className="w-fit text-xs text-primary underline"
              >
                {openI18n ? "收起" : "展开多语言详情"}{spu.desc_en || spu.desc_ja || spu.desc_ko || spu.desc_es ? "（已填写）" : ""}
              </button>
              {openI18n && (
                <div className="flex flex-col gap-3 border-l-2 border-border pl-3">
                  <p className="text-xs text-muted-foreground">选填，留空的语言自动显示中文详情</p>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="pd-desc-en">English 详情</Label>
                    <textarea id="pd-desc-en" maxLength={5000} rows={3} className="rounded-md border bg-background px-3 py-2 text-sm" value={spu.desc_en} onChange={(e) => setSpu({ ...spu, desc_en: e.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="pd-desc-ja">日本語 詳細</Label>
                    <textarea id="pd-desc-ja" maxLength={5000} rows={3} className="rounded-md border bg-background px-3 py-2 text-sm" value={spu.desc_ja} onChange={(e) => setSpu({ ...spu, desc_ja: e.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="pd-desc-ko">한국어 상세</Label>
                    <textarea id="pd-desc-ko" maxLength={5000} rows={3} className="rounded-md border bg-background px-3 py-2 text-sm" value={spu.desc_ko} onChange={(e) => setSpu({ ...spu, desc_ko: e.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="pd-desc-es">Español detalle</Label>
                    <textarea id="pd-desc-es" maxLength={5000} rows={3} className="rounded-md border bg-background px-3 py-2 text-sm" value={spu.desc_es} onChange={(e) => setSpu({ ...spu, desc_es: e.target.value })} />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">商品图（≤9 张，首图用于列表封面）</span>
              <label className={`cursor-pointer text-sm text-primary underline ${uploading ? "pointer-events-none opacity-60" : ""}`}>
                {uploading ? "上传中…" : "上传图片"}
                <input
                  type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); e.target.value = ""; }}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              {spu.images.map((k, i) => (
                <span key={k} className="relative">
                  <ImageCell imageKey={k} />
                  <button
                    type="button" aria-label="移除图片"
                    className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-destructive text-[10px] leading-none text-white"
                    onClick={() => setSpu((s) => ({ ...s, images: s.images.filter((_, j) => j !== i) }))}
                  >×</button>
                </span>
              ))}
              {!spu.images.length && <span className="text-xs text-muted-foreground">暂无图片</span>}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">SKU 规格</span>
              <Button type="button" size="sm" variant="outline" onClick={() => setSkus((rows) => [...rows, emptySku()])}>
                添加规格
              </Button>
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>规格名</TableHead><TableHead>SKU 编码</TableHead>
                    <TableHead>{`售价（${baseUnit()}）`}</TableHead><TableHead>划线价</TableHead>
                    <TableHead>可售库存</TableHead><TableHead>状态</TableHead><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skus.map((s, i) => {
                    const rk = s.id ?? `new-${i}`;
                    const open = Boolean(skuI18n[rk]);
                    return (
                    <Fragment key={rk}>
                      <TableRow>
                        <TableCell><Input className="h-8 w-28" value={s.spec_name} onChange={(e) => setSku(i, { spec_name: e.target.value })} placeholder="标准版" /></TableCell>
                        <TableCell><Input className="h-8 w-32" value={s.sku_code} onChange={(e) => setSku(i, { sku_code: e.target.value })} placeholder="SKU-001" /></TableCell>
                        <TableCell><Input className="h-8 w-24" value={s.price_yuan} onChange={(e) => setSku(i, { price_yuan: e.target.value })} placeholder="99.00" /></TableCell>
                        <TableCell><Input className="h-8 w-24" value={s.original_yuan} onChange={(e) => setSku(i, { original_yuan: e.target.value })} placeholder="选填" /></TableCell>
                        <TableCell>
                          {s.id ? (
                            <StockCell sku={s} onChanged={onSaved} />
                          ) : (
                            <Input className="h-8 w-20" type="number" min={0} value={s.stock} onChange={(e) => setSku(i, { stock: Number(e.target.value) || 0 })} />
                          )}
                        </TableCell>
                        <TableCell><Switch checked={s.status === "on"} onCheckedChange={(v) => setSku(i, { status: v ? "on" : "off" })} /></TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Button type="button" size="sm" variant="ghost" onClick={() => setSkuI18n((m) => ({ ...m, [rk]: !open }))}>
                            {open ? "收起译名" : s.spec_en || s.spec_ja || s.spec_ko || s.spec_es ? "规格译名 ✓" : "规格译名"}
                          </Button>
                          {skus.length > 1 && (
                            <Button type="button" size="sm" variant="ghost" onClick={() => setSkus((rows) => rows.filter((_, j) => j !== i))}>移除</Button>
                          )}
                        </TableCell>
                      </TableRow>
                      {open && (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/40 py-2">
                            <div className="flex flex-col gap-1">
                              <span className="text-xs text-muted-foreground">规格名多语言（选填，留空的语言自动显示「{s.spec_name || "规格名"}」）</span>
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                <Input aria-label="英文规格名" className="h-8" maxLength={60} value={s.spec_en} onChange={(e) => setSku(i, { spec_en: e.target.value })} placeholder="English" />
                                <Input aria-label="日文规格名" className="h-8" maxLength={60} value={s.spec_ja} onChange={(e) => setSku(i, { spec_ja: e.target.value })} placeholder="日本語" />
                                <Input aria-label="韩文规格名" className="h-8" maxLength={60} value={s.spec_ko} onChange={(e) => setSku(i, { spec_ko: e.target.value })} placeholder="한국어" />
                                <Input aria-label="西语规格名" className="h-8" maxLength={60} value={s.spec_es} onChange={(e) => setSku(i, { spec_es: e.target.value })} placeholder="Español" />
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                    );
                  })}
                  {!skus.length && (
                    <TableRow><TableCell colSpan={7} className="py-6 text-center text-muted-foreground">至少添加一个 SKU</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">已存在 SKU 的库存只能走「调整」写入流水，保存不会覆盖；改价不影响历史订单快照。</p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !skus.length}>{busy ? "保存中…" : "保存商品"}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>返回列表</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// 已有 SKU：只读库存 + 行内调整（⚠ stock.adjust）
function StockCell({ sku, onChanged }: { sku: SkuRow; onChanged: () => void }) {
  const [adjusting, setAdjusting] = useState(false);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    try {
      await riskyPost("admin/stock/adjust", { sku_id: sku.id, delta: Number(delta), reason }, `库存调整 ${delta}`);
      setAdjusting(false); setDelta(""); setReason("");
      onChanged();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "confirm_required")) setError(errText(err));
    }
  }

  if (!adjusting) {
    return (
      <span className="flex items-center gap-1 whitespace-nowrap text-sm">
        {sku.stock}
        <button type="button" className="text-xs text-primary underline" onClick={() => setAdjusting(true)}>调整</button>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <Input className="h-7 w-16" placeholder="±数量" value={delta} onChange={(e) => setDelta(e.target.value)} />
        <Input className="h-7 w-24" placeholder="原因" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button type="button" size="sm" onClick={() => void submit()} disabled={!delta || !reason.trim()}>提交</Button>
      </span>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}

// —— 分类管理 ——
function CategoriesCard({ categories, onChanged }: { categories: CategoryRow[]; onChanged: () => void }) {
  const { has } = useAdmin();
  const canManage = has("product.manage");
  const [draft, setDraft] = useState({ category_id: null as string | null, parent_id: "", name: "", name_en: "", name_ja: "", name_ko: "", name_es: "", sort_order: "0", status: "on" });

  async function save() {
    try {
      await call("admin/category/save", {
        method: "POST", token: "admin", idem: newIdem(),
        body: {
          category_id: draft.category_id ?? undefined,
          parent_id: draft.parent_id || undefined,
          name: draft.name,
          name_i18n: i18nMap({ en: draft.name_en, ja: draft.name_ja, ko: draft.name_ko, es: draft.name_es }),
          sort_order: Number(draft.sort_order) || 0, status: draft.status,
        },
      });
      setDraft({ category_id: null, parent_id: "", name: "", name_en: "", name_ja: "", name_ko: "", name_es: "", sort_order: "0", status: "on" });
      onChanged();
    } catch (e) {
      window.alert(errText(e));
    }
  }

  const edit = (c: CategoryRow) => setDraft({
    category_id: c.id, parent_id: c.parent_id ?? "", name: c.name,
    name_en: c.name_i18n?.en ?? "", name_ja: c.name_i18n?.ja ?? "", name_ko: c.name_i18n?.ko ?? "", name_es: c.name_i18n?.es ?? "",
    sort_order: String(c.sort_order), status: c.status,
  });

  return (
    <Card>
      <CardHeader><CardTitle>分类管理</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <span className="flex flex-col gap-1">
            <Label htmlFor="ct-parent">父分类</Label>
            <select id="ct-parent" className="h-9 rounded-md border bg-background px-2 text-sm" value={draft.parent_id} onChange={(e) => setDraft({ ...draft, parent_id: e.target.value })}>
              <option value="">（顶级）</option>
              {categories.filter((c) => !c.parent_id && c.id !== draft.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </span>
          <span className="flex flex-col gap-1">
            <Label htmlFor="ct-name">名称</Label>
            <Input id="ct-name" className="h-9 w-32" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </span>
          <span className="flex flex-col gap-1">
            <Label>多语言名称（选填）</Label>
            <span className="flex items-center gap-1">
              <Input className="h-9 w-24" aria-label="英文分类名" maxLength={60} value={draft.name_en} onChange={(e) => setDraft({ ...draft, name_en: e.target.value })} placeholder="English" />
              <Input className="h-9 w-24" aria-label="日文分类名" maxLength={60} value={draft.name_ja} onChange={(e) => setDraft({ ...draft, name_ja: e.target.value })} placeholder="日本語" />
              <Input className="h-9 w-24" aria-label="韩文分类名" maxLength={60} value={draft.name_ko} onChange={(e) => setDraft({ ...draft, name_ko: e.target.value })} placeholder="한국어" />
              <Input className="h-9 w-24" aria-label="西语分类名" maxLength={60} value={draft.name_es} onChange={(e) => setDraft({ ...draft, name_es: e.target.value })} placeholder="Español" />
            </span>
          </span>
          <span className="flex flex-col gap-1">
            <Label htmlFor="ct-sort">排序</Label>
            <Input id="ct-sort" className="h-9 w-16" type="number" value={draft.sort_order} onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} />
          </span>
          <span className="flex flex-col gap-1">
            <Label htmlFor="ct-status">状态</Label>
            <select id="ct-status" className="h-9 rounded-md border bg-background px-2 text-sm" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="on">显示</option><option value="off">隐藏</option>
            </select>
          </span>
          {canManage && <Button size="sm" onClick={() => void save()} disabled={!draft.name.trim()}>{draft.category_id ? "保存修改" : "新增分类"}</Button>}
          {draft.category_id && <Button size="sm" variant="outline" onClick={() => setDraft({ category_id: null, parent_id: "", name: "", name_en: "", name_ja: "", name_ko: "", name_es: "", sort_order: "0", status: "on" })}>取消编辑</Button>}
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow><TableHead>名称</TableHead><TableHead>层级</TableHead><TableHead>排序</TableHead><TableHead>状态</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="text-sm">{c.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.parent_id ? "二级" : "一级"}</TableCell>
                  <TableCell className="text-sm">{c.sort_order}</TableCell>
                  <TableCell><Badge variant={c.status === "on" ? "default" : "secondary"}>{c.status === "on" ? "显示" : "隐藏"}</Badge></TableCell>
                  <TableCell>{canManage && <Button size="sm" variant="ghost" onClick={() => edit(c)}>编辑</Button>}</TableCell>
                </TableRow>
              ))}
              {!categories.length && <TableRow><TableCell colSpan={5} className="py-6 text-center text-muted-foreground">暂无分类，先新增一个</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// —— 库存流水 ——
function LogsCard({ productFilter }: { productFilter: string | null }) {
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    call<{ items: LogRow[] }>("admin/inventory/logs", { token: "admin", query: { product_id: productFilter ?? undefined } })
      .then((r) => setLogs(r.items))
      .catch((e: unknown) => { setLogs([]); setError(errText(e)); });
  }, [productFilter]);
  useEffect(() => { load(); }, [load]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          库存流水{productFilter ? "（当前商品 SKU）" : "（最近）"}
          <Button size="sm" variant="outline" onClick={load}>刷新</Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow><TableHead>时间</TableHead><TableHead>SKU</TableHead><TableHead>类型</TableHead><TableHead>变动</TableHead><TableHead>可售 前→后</TableHead><TableHead>来源</TableHead><TableHead>原因</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {(logs ?? []).map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap text-xs">{l.created_at.slice(0, 19).replace("T", " ")}</TableCell>
                  <TableCell className="font-mono text-xs">{l.sku?.sku_code ?? l.sku_id.slice(0, 8)}</TableCell>
                  <TableCell className="text-xs">{l.change_type}</TableCell>
                  <TableCell className={"text-xs font-medium " + (l.quantity >= 0 ? "text-primary" : "text-destructive")}>{l.quantity > 0 ? `+${l.quantity}` : l.quantity}</TableCell>
                  <TableCell className="text-xs">{l.available_before} → {l.available_after}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{l.reference_type}</TableCell>
                  <TableCell className="max-w-40 truncate text-xs text-muted-foreground" title={l.reason ?? ""}>{l.reason}</TableCell>
                </TableRow>
              ))}
              {!logs?.length && <TableRow><TableCell colSpan={7} className="py-6 text-center text-muted-foreground">{logs ? "暂无流水记录" : "加载中…"}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// —— 批量导入（CSV 固定模板 → 浏览器解析 → admin/product/bulk 以 SKU 编码为键 upsert；不处理图片）——
function BulkImportCard({ categories, onDone }: { categories: CategoryRow[]; onDone: () => void }) {
  const { has } = useAdmin();
  const canManage = has("product.manage");
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<{ headerSkipped: boolean; items: BulkItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<{ total: number; products_created: number; created: number; updated: number; failed: number } | null>(null);

  const parse = (src: string) => {
    setError(""); setSummary(null);
    setParsed(src.trim() ? buildItems(parseCsv(src)) : null);
  };

  const items = parsed?.items ?? [];
  const valid = items.filter((it) => !it.error && it.row);
  const localBad = items.filter((it) => it.error);

  async function submit() {
    if (!valid.length) return;
    setBusy(true); setError(""); setSummary(null);
    setParsed((p) => (p ? { ...p, items: p.items.map((it) => ({ ...it, result: undefined })) } : p));
    try {
      const rows = valid.map((it) => it.row);
      const r = await call<{
        total: number; products_created: number; created: number; updated: number; failed: number;
        results: Array<{ index: number; action: string; error?: string }>;
      }>("admin/product/bulk", { method: "POST", token: "admin", idem: newIdem(), body: { rows } });
      setSummary({ total: r.total, products_created: r.products_created, created: r.created, updated: r.updated, failed: r.failed });
      const byNo = new Map<number, { action: string; error?: string }>();
      r.results.forEach((res) => { const it = valid[res.index]; if (it) byNo.set(it.no, { action: res.action, error: res.error }); });
      setParsed((p) => (p ? { ...p, items: p.items.map((it) => ({ ...it, result: byNo.get(it.no) })) } : p));
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function onFile(file: File) {
    void file.text().then((t) => { setText(t); parse(t); });
  }

  function downloadTemplate() {
    const blob = new Blob([`﻿${TEMPLATE}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "商品批量导入模板.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader><CardTitle>批量导入商品</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          固定列：<b>分类名·款号(选填)·标题·副标题·描述·规格名·SKU编码·售价·原价·库存·状态</b>。
          金额一律按站点本位币（当前为 {baseUnit()}）填写，表头不写单位；旧模板的「售价(元)」照样识别。
          以 <b>SKU 编码</b> 为唯一键：已存在则更新价格/状态并按表格值设置库存（走流水），不存在则按「款号或标题」归为同一商品并新建。
          状态只认 <b>在售/下架/草稿</b>（留空=草稿）。分类名必须与现有分类完全一致。<b>图片不在此导入，请导入后到编辑页补图。</b>
        </p>
        {categories.length > 0 && (
          <p className="text-xs text-muted-foreground">现有分类：{categories.map((c) => c.name).join("、")}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={downloadTemplate}>下载 CSV 模板</Button>
          <label className={`cursor-pointer text-sm text-primary underline ${busy ? "pointer-events-none opacity-60" : ""}`}>
            选择 CSV 文件
            <input type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
          </label>
        </div>
        <textarea
          className="min-h-32 rounded-md border bg-background px-3 py-2 font-mono text-xs"
          placeholder="也可以直接粘贴 CSV 内容到此处"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => parse(text)} disabled={!text.trim()}>解析预览</Button>
          {canManage && (
            <Button size="sm" onClick={() => void submit()} disabled={busy || !valid.length}>
              {busy ? "导入中…" : `导入 ${valid.length} 行`}
            </Button>
          )}
          {parsed && <span className="text-xs text-muted-foreground">解析出 {items.length} 行，可导入 {valid.length}，本地校验未过 {localBad.length}</span>}
        </div>
        {!canManage && <p className="text-xs text-destructive">当前账号无 product.manage 权限，只能预览，不能提交导入。</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {summary && (
          <p className="text-sm">
            导入完成：新建商品 <b>{summary.products_created}</b> 个 · 新建 SKU <b className="text-primary">{summary.created}</b> · 更新 SKU <b>{summary.updated}</b> · 失败 <b className={summary.failed ? "text-destructive" : ""}>{summary.failed}</b>
          </p>
        )}

        {parsed && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>行</TableHead><TableHead>分类名</TableHead><TableHead>款号</TableHead><TableHead>标题</TableHead>
                  <TableHead>SKU 编码</TableHead><TableHead>{`售价（${baseUnit()}）`}</TableHead><TableHead>库存</TableHead><TableHead>状态</TableHead><TableHead>校验 / 结果</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((it) => (
                  <TableRow key={it.no}>
                    <TableCell className="text-xs text-muted-foreground">{it.no}</TableCell>
                    <TableCell className="text-xs">{it.show.category}</TableCell>
                    <TableCell className="text-xs">{it.show.group || "—"}</TableCell>
                    <TableCell className="max-w-40 truncate text-xs" title={it.show.title}>{it.show.title}</TableCell>
                    <TableCell className="font-mono text-xs">{it.show.sku}</TableCell>
                    <TableCell className="text-xs">{it.show.price || "—"}</TableCell>
                    <TableCell className="text-xs">{it.show.stock}</TableCell>
                    <TableCell className="text-xs">{STATUS_LABEL[it.show.status] ?? it.show.status}</TableCell>
                    <TableCell className="text-xs">
                      {it.error
                        ? <span className="text-destructive">{it.error}</span>
                        : it.result
                          ? (it.result.action === "error"
                            ? <span className="text-destructive">{it.result.error ?? "失败"}</span>
                            : <Badge variant={it.result.action === "created" ? "default" : "secondary"}>{ACTION_LABEL[it.result.action] ?? it.result.action}</Badge>)
                          : <span className="text-muted-foreground">待导入</span>}
                    </TableCell>
                  </TableRow>
                ))}
                {!items.length && <TableRow><TableCell colSpan={9} className="py-6 text-center text-muted-foreground">未解析到数据行，请检查模板/内容</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ProductsPage() {
  const { has } = useAdmin();
  const [tab, setTab] = useState<"products" | "categories" | "logs" | "bulk">("products");
  const [filters, setFilters] = useState({ status: "", category: "", keyword: "" });
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [listError, setListError] = useState("");
  const [tick, setTick] = useState(0);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ total: number; limit: number }>({ total: 0, limit: 20 });
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [editing, setEditing] = useState<string | null | "new">(null);
  const [logsSku, setLogsSku] = useState<string | null>(null);

  // 改筛选条件时回到第一页，避免停在旧页码上看不到匹配结果
  const applyFilters = (patch: Partial<typeof filters>) => { setFilters((f) => ({ ...f, ...patch })); setOffset(0); };

  useEffect(() => {
    call<{ items: CategoryRow[] }>("admin/categories", { token: "admin" })
      .then((r) => setCategories(r.items))
      .catch(() => undefined);
  }, [tick]);

  useEffect(() => {
    if (tab !== "products") return;
    let alive = true;
    setListError("");
    call<{ items: ListRow[]; total: number; offset: number; limit: number }>("admin/products", {
      token: "admin",
      query: {
        status: filters.status || undefined,
        category_id: filters.category || undefined,
        keyword: filters.keyword || undefined,
        offset: offset || undefined,
      },
    })
      .then((r) => { if (alive) { setRows(r.items); setPage({ total: r.total, limit: r.limit }); } })
      .catch((e: unknown) => { if (alive) { setRows([]); setListError(errText(e)); } });
    return () => { alive = false; };
  }, [tab, filters, offset, tick]);

  async function setStatus(id: string, action: "on" | "off" | "del") {
    try {
      if (action === "on") {
        await call("admin/product/status", { method: "POST", token: "admin", idem: newIdem(), body: { product_id: id, action } });
      } else {
        await riskyPost("admin/product/status", { product_id: id, action }, action === "del" ? "删除商品" : "下架商品");
      }
      setTick((t) => t + 1);
    } catch (e) {
      if (e instanceof ApiError && e.code === "confirm_required") return;
      window.alert(errText(e));
    }
  }

  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? "—";

  if (editing !== null) {
    return (
      <div className="flex flex-col gap-4">
        <PageTitle title={editing === "new" ? "新建商品" : "编辑商品"} desc="保存后按状态即时生效（在售商品会出现在商城首页与分类页）" />
        <ProductEditor
          productId={editing === "new" ? null : editing}
          categories={categories}
          onSaved={() => { setEditing(null); setTick((t) => t + 1); }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="商品管理" desc="商品/分类/库存流水（文档C PR1–PR4；权限点 product.read / product.manage / stock.adjust）" />
      <div className="flex gap-2 text-sm">
        {([["products", "商品"], ["categories", "分类"], ["bulk", "批量导入"], ["logs", "库存流水"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={"rounded-md border px-4 py-1 transition " + (tab === k ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}>{label}</button>
        ))}
      </div>

      {tab === "products" && (
        <>
          <Toolbar>
            <span className="flex flex-col gap-1">
              <Label htmlFor="pl-status">状态</Label>
              <select id="pl-status" className="h-9 rounded-md border bg-background px-2 text-sm" value={filters.status} onChange={(e) => applyFilters({ status: e.target.value })}>
                <option value="">全部</option><option value="draft">草稿</option><option value="on">在售</option><option value="off">已下架</option>
              </select>
            </span>
            <span className="flex flex-col gap-1">
              <Label htmlFor="pl-cat">分类</Label>
              <select id="pl-cat" className="h-9 rounded-md border bg-background px-2 text-sm" value={filters.category} onChange={(e) => applyFilters({ category: e.target.value })}>
                <option value="">全部</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.parent_id ? "— " : ""}{c.name}</option>)}
              </select>
            </span>
            <span className="flex flex-col gap-1">
              <Label htmlFor="pl-kw">关键词</Label>
              <Input id="pl-kw" className="h-9 w-40" value={filters.keyword} onChange={(e) => applyFilters({ keyword: e.target.value })} placeholder="标题/副标题" />
            </span>
            <Button variant="outline" onClick={() => { setOffset(0); setTick((t) => t + 1); }}>查询</Button>
            {has("product.manage") && <Button className="ml-auto" onClick={() => setEditing("new")}>新建商品</Button>}
          </Toolbar>

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow><TableHead>商品</TableHead><TableHead>分类</TableHead><TableHead>最低价</TableHead><TableHead>可售/冻结</TableHead><TableHead>SKU</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {(rows ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <ImageCell imageKey={p.images[0]} />
                        <span className="flex min-w-0 flex-col">
                          <span className="max-w-56 truncate text-sm font-medium">{p.title}</span>
                          {p.brand && <span className="max-w-56 truncate text-xs text-muted-foreground">{p.brand}</span>}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{catName(p.category_id)}</TableCell>
                    <TableCell className="text-sm">{p.min_price === null ? "—" : formatBase(p.min_price)}</TableCell>
                    <TableCell className="text-sm">{p.total_stock} / {p.frozen_stock}</TableCell>
                    <TableCell className="text-sm">{p.sku_count}</TableCell>
                    <TableCell>
                      <Badge variant={p.status === "on" ? "default" : p.status === "draft" ? "secondary" : "outline"}>{STATUS_LABEL[p.status] ?? p.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {has("product.manage") && (
                        <span className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(p.id)}>编辑</Button>
                          {p.status !== "on" && <Button size="sm" variant="outline" onClick={() => void setStatus(p.id, "on")}>上架</Button>}
                          {p.status === "on" && <Button size="sm" variant="outline" onClick={() => void setStatus(p.id, "off")}>下架</Button>}
                          {p.status !== "draft" && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void setStatus(p.id, "del")}>删除</Button>}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {!rows?.length && (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{rows ? "暂无商品：点击「新建商品」录入第一个 SKU，上架后前端立即展示" : listError || "加载中…"}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - page.limit))}>上一页</Button>
            <span className="text-muted-foreground">共 {page.total} 条 · 第 {Math.floor(offset / page.limit) + 1} 页</span>
            <Button size="sm" variant="outline" disabled={offset + (rows?.length ?? 0) >= page.total} onClick={() => setOffset(offset + page.limit)}>下一页</Button>
          </div>
        </>
      )}

      {tab === "categories" && <CategoriesCard categories={categories} onChanged={() => setTick((t) => t + 1)} />}
      {tab === "bulk" && <BulkImportCard categories={categories} onDone={() => setTick((t) => t + 1)} />}
      {tab === "logs" && (
        <>
          <Toolbar>
            <span className="flex flex-col gap-1">
              <Label htmlFor="lg-sku">按商品查看</Label>
              <select id="lg-sku" className="h-9 rounded-md border bg-background px-2 text-sm" value={logsSku ?? ""} onChange={(e) => setLogsSku(e.target.value || null)}>
                <option value="">全部流水</option>
                {(rows ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </span>
          </Toolbar>
          <LogsCard productFilter={logsSku} />
        </>
      )}
    </div>
  );
}
