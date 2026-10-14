// 后台优惠券：CY1 模板维护 / 券实例查询 / CY2 批量发放（权限点 coupon.manage / coupon.grant）
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, call, newIdem } from "../../api";
import { baseUnit, formatBase } from "../../const";
import { useAdmin } from "../AdminAuth";
import { PageTitle, Toolbar, errText, isConfirmCancel, riskyPost, useBusy } from "../ui";
import type {
  AdminCouponRow, BatchGrantResult, CouponTemplateRow, Paged, UserRow,
} from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  COUPON_SCOPE_TEXT, COUPON_STATUS_TEXT, COUPON_TYPE_TEXT, couponRuleText, yuanToCents,
} from "../../trade";

const PAGE = 20;
const TEMPLATE_STATUS_TEXT: Record<string, string> = { on: "发放中", off: "已停用", archived: "已归档" };
/** 模板状态流转矩阵（与后端 NEXT_TEMPLATE_STATUS 一致） */
const NEXT_STATUS: Record<string, [string, string][]> = {
  off: [["on", "开始发放"]],
  on: [["off", "停止发放"], ["archived", "归档"]],
  archived: [],
};
const GRANT_REASON: Record<string, string> = {
  quota_reached: "已达上限（库存或每人上限）",
  coupon_unavailable: "模板未发放中或已过有效期",
  not_found: "用户不存在",
  internal_error: "发放失败",
};

interface CategoryOpt { id: string; parent_id: string | null; name: string }
interface ProductOpt { id: string; title: string; status: string }

interface Draft {
  name: string;
  name_en: string;
  name_ja: string;
  name_ko: string;
  name_es: string;
  coupon_type: "threshold" | "direct";
  threshold_yuan: string;
  discount_yuan: string;
  scope: "all" | "category" | "product";
  scope_ids: string[];
  window: "days" | "range";
  valid_days: string;
  valid_from: string;
  valid_until: string;
  unlimited: boolean;
  total_quota: string;
  per_user_limit: string;
  claimable: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: "", name_en: "", name_ja: "", name_ko: "", name_es: "",
  coupon_type: "threshold", threshold_yuan: "200", discount_yuan: "30",
  scope: "all", scope_ids: [], window: "days", valid_days: "7", valid_from: "", valid_until: "",
  unlimited: true, total_quota: "", per_user_limit: "1", claimable: false,
};

/** 多语录入 → name_i18n：留空的语言不写入，买家端自动回落中文原文 */
function i18nMap(vals: { en: string; ja: string; ko: string; es: string }): Record<string, string> {
  const m: Record<string, string> = {};
  if (vals.en.trim()) m.en = vals.en.trim();
  if (vals.ja.trim()) m.ja = vals.ja.trim();
  if (vals.ko.trim()) m.ko = vals.ko.trim();
  if (vals.es.trim()) m.es = vals.es.trim();
  return m;
}

const NAME_LANGS: { lang: "en" | "ja" | "ko" | "es"; label: string }[] = [
  { lang: "en", label: "English" },
  { lang: "ja", label: "日本語" },
  { lang: "ko", label: "한국어" },
  { lang: "es", label: "Español" },
];

/** Draft 里对应的券名录入字段：name_en / name_ja / name_ko / name_es */
const nameKey = (lang: "en" | "ja" | "ko" | "es") => `name_${lang}` as keyof Draft;

/** 列表提示：这张券已配了哪几语券名，没配的语种在小语种界面回落中文 */
const langsOf = (m: Record<string, string> | null | undefined) =>
  NAME_LANGS.filter((L) => m?.[L.lang]).map((L) => L.label).join(" / ");

const toDraft = (t: CouponTemplateRow | null): Draft => (t ? {
  name: t.name,
  name_en: t.name_i18n?.en ?? "",
  name_ja: t.name_i18n?.ja ?? "",
  name_ko: t.name_i18n?.ko ?? "",
  name_es: t.name_i18n?.es ?? "",
  coupon_type: t.coupon_type === "direct" ? "direct" : "threshold",
  threshold_yuan: (t.threshold_amount_base / 100).toFixed(2),
  discount_yuan: (t.discount_amount_base / 100).toFixed(2),
  scope: t.scope === "category" || t.scope === "product" ? t.scope : "all",
  scope_ids: t.scope_ids ?? [],
  window: t.valid_days > 0 ? "days" : "range",
  valid_days: String(t.valid_days ?? 0),
  valid_from: t.valid_from ? t.valid_from.slice(0, 16) : "",
  valid_until: t.valid_until ? t.valid_until.slice(0, 16) : "",
  unlimited: t.unlimited,
  total_quota: t.total_quota === null ? "" : String(t.total_quota),
  per_user_limit: String(t.per_user_limit),
  claimable: t.claimable ?? false,
} : EMPTY_DRAFT);

function draftError(d: Draft): string {
  if (!d.name.trim()) return "请填写券名称";
  if (!yuanToCents(d.discount_yuan)) return "抵扣面额必须大于 0";
  if (d.coupon_type === "threshold" && !yuanToCents(d.threshold_yuan)) return "满减券的使用门槛必须大于 0";
  if (d.scope !== "all" && !d.scope_ids.length) return d.scope === "category" ? "请选择至少一个分类" : "请选择至少一个商品";
  if (d.window === "days") {
    const days = Number(d.valid_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return "领取后有效天数需为 1–3650 的整数";
  } else {
    const from = Date.parse(d.valid_from);
    const until = Date.parse(d.valid_until);
    if (!Number.isFinite(from) || !Number.isFinite(until)) return "请填写完整的有效期起止时间";
    if (until <= from) return "有效期终点必须晚于起点";
  }
  if (!d.unlimited) {
    const quota = Number(d.total_quota);
    if (!Number.isInteger(quota) || quota < 1) return "发放总量需为不小于 1 的整数";
  }
  const per = Number(d.per_user_limit);
  if (!Number.isInteger(per) || per < 1 || per > 999) return "每人限领需为 1–999 的整数";
  return "";
}

/** 时间输入按 UTC 解释，与列表显示同一口径，避免编辑一次保存就漂移 8 小时 */
const isoOf = (local: string): string => {
  const ms = Date.parse(local.length === 16 ? `${local}:00Z` : local);
  return new Date(ms).toISOString();
};

// —— 模板编辑器 ——
function TemplateEditor({ template, categories, onSaved, onCancel }: {
  template: CouponTemplateRow | null;
  categories: CategoryOpt[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(template));
  const [error, setError] = useState("");
  const [busy, run] = useBusy();
  const [productKw, setProductKw] = useState("");
  const [loadedProducts, setLoadedProducts] = useState<ProductOpt[]>([]);
  const [searching, setSearching] = useState(false);

  const patch = (p: Partial<Draft>) => { setDraft((d) => ({ ...d, ...p })); setError(""); };

  const toggleScope = (id: string) => patch({
    scope_ids: draft.scope_ids.includes(id) ? draft.scope_ids.filter((x) => x !== id) : [...draft.scope_ids, id].slice(0, 50),
  });

  async function searchProducts() {
    setSearching(true);
    setError("");
    try {
      const r = await call<Paged<ProductOpt>>("admin/products", {
        token: "admin", query: { keyword: productKw || undefined },
      });
      setLoadedProducts((prev) => {
        const map = new Map(prev.map((p) => [p.id, p]));
        for (const p of r.items) map.set(p.id, p);
        return [...map.values()];
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setSearching(false);
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const invalid = draftError(draft);
    if (invalid) { setError(invalid); return; }
    setError("");
    await run(async () => {
      try {
        await call("admin/coupon-template/save", {
          method: "POST", token: "admin", idem: newIdem(),
          body: {
            template_id: template?.id,
            name: draft.name.trim(),
            name_i18n: i18nMap({ en: draft.name_en, ja: draft.name_ja, ko: draft.name_ko, es: draft.name_es }),
            coupon_type: draft.coupon_type,
            threshold_amount_base: draft.coupon_type === "threshold" ? yuanToCents(draft.threshold_yuan) ?? 0 : 0,
            discount_amount_base: yuanToCents(draft.discount_yuan) ?? 0,
            scope: draft.scope,
            scope_ids: draft.scope === "all" ? [] : draft.scope_ids,
            valid_days: draft.window === "days" ? Number(draft.valid_days) : 0,
            valid_from: draft.window === "range" ? isoOf(draft.valid_from) : undefined,
            valid_until: draft.window === "range" ? isoOf(draft.valid_until) : undefined,
            unlimited: draft.unlimited,
            total_quota: draft.unlimited ? undefined : Number(draft.total_quota),
            per_user_limit: Number(draft.per_user_limit),
            claimable: draft.claimable,
          },
        });
        onSaved();
      } catch (err) {
        setError(errText(err));
      }
    });
  }

  const choices: { id: string; label: string }[] = draft.scope === "category"
    ? categories.map((c) => ({ id: c.id, label: (c.parent_id ? "— " : "") + c.name }))
    : loadedProducts.map((p) => ({ id: p.id, label: p.title }));
  const unresolved = draft.scope === "product"
    ? draft.scope_ids.filter((id) => !loadedProducts.some((p) => p.id === id))
    : [];

  return (
    <Card>
      <CardHeader><CardTitle>{template ? `编辑模板：${template.name}` : "新建券模板"}</CardTitle></CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={onSave}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="cy-name">券名称 *</Label>
              <Input id="cy-name" required maxLength={60} value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="满 200 减 30" />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
              <Label>多语言券名（选填，留空的语言自动显示中文券名）</Label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {NAME_LANGS.map((L) => (
                  <Input key={L.lang} aria-label={`${L.label}券名`} maxLength={60} value={draft[nameKey(L.lang)] as string}
                    onChange={(e) => patch({ [nameKey(L.lang)]: e.target.value } as Partial<Draft>)} placeholder={L.label} />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="cy-type">券类型</Label>
              <select id="cy-type" className="h-9 rounded-md border bg-background px-2 text-sm" value={draft.coupon_type}
                onChange={(e) => patch({ coupon_type: e.target.value as Draft["coupon_type"] })}>
                <option value="threshold">满减券</option>
                <option value="direct">立减券</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="cy-scope">适用范围</Label>
              <select id="cy-scope" className="h-9 rounded-md border bg-background px-2 text-sm" value={draft.scope}
                onChange={(e) => patch({ scope: e.target.value as Draft["scope"], scope_ids: [] })}>
                <option value="all">全场通用</option>
                <option value="category">指定分类</option>
                <option value="product">指定商品</option>
              </select>
            </div>
            {draft.coupon_type === "threshold" && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="cy-thd">{`使用门槛（${baseUnit()}）*`}</Label>
                <Input id="cy-thd" value={draft.threshold_yuan} onChange={(e) => patch({ threshold_yuan: e.target.value })} />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="cy-dis">{`抵扣面额（${baseUnit()}）*`}</Label>
              <Input id="cy-dis" value={draft.discount_yuan} onChange={(e) => patch({ discount_yuan: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="cy-per">每人限领（张）</Label>
              <Input id="cy-per" type="number" min={1} max={999} value={draft.per_user_limit} onChange={(e) => patch({ per_user_limit: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="cy-window">有效期方式</Label>
              <select id="cy-window" className="h-9 rounded-md border bg-background px-2 text-sm" value={draft.window}
                onChange={(e) => patch({ window: e.target.value as Draft["window"] })}>
                <option value="days">领取后 N 天</option>
                <option value="range">固定起止时间</option>
              </select>
            </div>
            {draft.window === "days" ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="cy-days">领取后有效天数 *</Label>
                <Input id="cy-days" type="number" min={1} max={3650} value={draft.valid_days} onChange={(e) => patch({ valid_days: e.target.value })} />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="cy-from">生效时间（UTC）*</Label>
                  <Input id="cy-from" type="datetime-local" value={draft.valid_from} onChange={(e) => patch({ valid_from: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="cy-until">失效时间（UTC）*</Label>
                  <Input id="cy-until" type="datetime-local" value={draft.valid_until} onChange={(e) => patch({ valid_until: e.target.value })} />
                </div>
              </>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="cy-unlimited">发放总量</Label>
              <label className="flex h-9 items-center gap-2 text-sm">
                <input id="cy-unlimited" type="checkbox" className="size-4 accent-[var(--primary)]" checked={draft.unlimited}
                  onChange={(e) => patch({ unlimited: e.target.checked })} />
                不限量
              </label>
            </div>
            {!draft.unlimited && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="cy-quota">发放总量上限 *</Label>
                <Input id="cy-quota" type="number" min={1} value={draft.total_quota} onChange={(e) => patch({ total_quota: e.target.value })} />
                {template && <p className="text-xs text-muted-foreground">已发放 {template.issued_count} 张，不可小于该数量</p>}
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="cy-claim">领券中心</Label>
              <label className="flex h-9 items-center gap-2 text-sm">
                <input id="cy-claim" type="checkbox" className="size-4 accent-[var(--primary)]" checked={draft.claimable}
                  onChange={(e) => patch({ claimable: e.target.checked })} />
                允许用户在领券中心自助领取
              </label>
            </div>
          </div>

          {draft.scope !== "all" && (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{draft.scope === "category" ? "选择分类" : "选择商品"}</span>
                <span className="text-xs text-muted-foreground">已选 {draft.scope_ids.length} / 50</span>
                {draft.scope === "product" && (
                  <>
                    <Input className="h-8 w-40" placeholder="商品关键词" value={productKw}
                      onChange={(e) => setProductKw(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void searchProducts(); } }} />
                    <Button type="button" size="sm" variant="outline" disabled={searching} onClick={() => void searchProducts()}>
                      {searching ? "查询中…" : "搜索"}
                    </Button>
                  </>
                )}
              </div>
              <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                {choices.map((o) => (
                  <button key={o.id} type="button"
                    onClick={() => toggleScope(o.id)}
                    className={"rounded-md border px-3 py-1 text-xs transition "
                      + (draft.scope_ids.includes(o.id) ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}
                  >
                    {o.label}
                  </button>
                ))}
                {draft.scope === "product" && !choices.length && (
                  <span className="text-xs text-muted-foreground">输入关键词后点「搜索」加载商品</span>
                )}
              </div>
              {draft.scope === "product" && unresolved.length > 0 && (
                <p className="text-xs text-muted-foreground">已选但不在当前搜索结果中的商品 ID：{unresolved.map((id) => id.slice(0, 8)).join("、")}</p>
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存模板"}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>返回列表</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// —— 批量发放 ——
function GrantCard({ templates }: { templates: CouponTemplateRow[] }) {
  const [templateId, setTemplateId] = useState(templates.find((t) => t.status === "on")?.id ?? "");
  const [seq, setSeq] = useState("0");
  const [keyword, setKeyword] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [result, setResult] = useState<BatchGrantResult | null>(null);
  const [error, setError] = useState("");
  const [busy, run] = useBusy();

  useEffect(() => {
    if (!templateId) setTemplateId(templates.find((t) => t.status === "on")?.id ?? "");
  }, [templates, templateId]);

  const search = useCallback(() => {
    setError("");
    void run(async () => {
      try {
        const r = await call<Paged<UserRow>>("admin/users", { token: "admin", query: { keyword: keyword || undefined } });
        setUsers(r.items);
      } catch (e) {
        setError(errText(e));
      }
    });
  }, [keyword, run]);

  useEffect(() => {
    search();
    // 仅在挂载时拉取一次用户列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(0, 50)));

  async function grant() {
    if (!templateId) { setError("请选择发放中的券模板"); return; }
    if (!picked.length) { setError("请至少勾选一个用户"); return; }
    setError("");
    setResult(null);
    await run(async () => {
      try {
        setResult(await riskyPost<BatchGrantResult>("admin/coupon/batch-grant", {
          template_id: templateId, user_ids: picked, seq: Number(seq) || 0,
        }, `向 ${picked.length} 位用户发放优惠券`));
        search();
      } catch (e) {
        if (!isConfirmCancel(e)) setError(errText(e));
      }
    });
  }

  const template = templates.find((t) => t.id === templateId);
  return (
    <Card>
      <CardHeader><CardTitle>批量发放（⚠ 高危操作，需二次确认并写入审计）</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Toolbar>
          <span className="flex flex-col gap-1">
            <Label htmlFor="cg-tpl">券模板</Label>
            <select id="cg-tpl" className="h-9 min-w-52 rounded-md border bg-background px-2 text-sm" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">（无发放中的模板）</option>
              {templates.filter((t) => t.status === "on").map((t) => (
                <option key={t.id} value={t.id}>{t.name}（{couponRuleText(t)}）</option>
              ))}
            </select>
          </span>
          <span className="flex flex-col gap-1">
            <Label htmlFor="cg-seq">批次号（重复提交同一批次不会重复发券）</Label>
            <Input id="cg-seq" className="h-9 w-24" type="number" min={0} max={999} value={seq} onChange={(e) => setSeq(e.target.value)} />
          </span>
          <span className="flex flex-col gap-1">
            <Label htmlFor="cg-kw">用户搜索</Label>
            <Input id="cg-kw" className="h-9 w-40" placeholder="用户名/昵称" value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
          </span>
          <Button variant="outline" onClick={search} disabled={busy}>搜索</Button>
          <Button className="ml-auto" onClick={() => void grant()} disabled={busy || !picked.length}>
            {busy ? "处理中…" : `发放给 ${picked.length} 人`}
          </Button>
        </Toolbar>
        {template && !template.unlimited && (
          <p className="text-xs text-muted-foreground">
            该模板已发放 {template.issued_count} / {template.total_quota} 张，每人限领 {template.per_user_limit} 张（已达上限的用户会被跳过并标记原因）。
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow><TableHead className="w-10">选</TableHead><TableHead>用户名</TableHead><TableHead>昵称</TableHead><TableHead>未用券</TableHead><TableHead>状态</TableHead><TableHead>注册时间</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={picked.includes(u.id)} onChange={() => toggle(u.id)} aria-label={`选择 ${u.username}`} />
                  </TableCell>
                  <TableCell className="text-sm font-medium">{u.username}</TableCell>
                  <TableCell className="text-sm">{u.nickname}</TableCell>
                  <TableCell className="text-sm">{u.coupon_unused ?? 0}</TableCell>
                  <TableCell><Badge variant={u.status === "active" ? "secondary" : "destructive"}>{u.status === "active" ? "正常" : "禁用"}</Badge></TableCell>
                  <TableCell className="text-xs">{u.created_at?.slice(0, 10)}</TableCell>
                </TableRow>
              ))}
              {!users.length && <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">没有匹配的用户</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
        {result && (
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
            <p className="text-sm font-medium">发放结果：成功 {result.granted} / 请求 {result.requested}</p>
            <ul className="flex flex-col gap-1 text-xs">
              {result.results.map((r) => {
                const u = users.find((x) => x.id === r.user_id);
                const okRow = r.granted || r.duplicated;
                return (
                  <li key={r.user_id} className="flex flex-wrap gap-2">
                    <span className={okRow ? "text-primary" : "text-destructive"}>{u?.username ?? r.user_id.slice(0, 8)}</span>
                    <span className="text-muted-foreground">
                      {r.granted ? "已发放" : r.duplicated ? "此前已发放（幂等命中）" : GRANT_REASON[r.reason ?? ""] ?? r.reason}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function CouponsPage() {
  const { has } = useAdmin();
  const [tab, setTab] = useState<"templates" | "coupons" | "grant">("templates");
  const [templates, setTemplates] = useState<CouponTemplateRow[]>([]);
  const [tplTotal, setTplTotal] = useState(0);
  const [tplOffset, setTplOffset] = useState(0);
  const [tplStatus, setTplStatus] = useState("");
  const [editing, setEditing] = useState<"new" | CouponTemplateRow | null>(null);
  const [listError, setListError] = useState("");
  const [tick, setTick] = useState(0);
  const [categories, setCategories] = useState<CategoryOpt[]>([]);
  const [busy, run] = useBusy();

  const [coupons, setCoupons] = useState<AdminCouponRow[]>([]);
  const [couponOffset, setCouponOffset] = useState(0);
  const [couponFilter, setCouponFilter] = useState({ status: "", template_id: "" });
  const [couponError, setCouponError] = useState("");

  useEffect(() => {
    call<{ items: CategoryOpt[] }>("admin/categories", { token: "admin" })
      .then((r) => setCategories(r.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    setListError("");
    void run(async () => {
      try {
        const r = await call<Paged<CouponTemplateRow>>("admin/coupon-templates", {
          token: "admin", query: { status: tplStatus || undefined, offset: tplOffset },
        });
        if (!alive) return;
        setTemplates(r.items);
        setTplTotal(r.total ?? r.items.length);
      } catch (e) {
        if (alive) setListError(errText(e));
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tplStatus, tplOffset, tick]);

  useEffect(() => {
    if (tab !== "coupons") return;
    let alive = true;
    setCouponError("");
    void run(async () => {
      try {
        const r = await call<Paged<AdminCouponRow>>("admin/coupons", {
          token: "admin",
          query: {
            status: couponFilter.status || undefined,
            template_id: couponFilter.template_id || undefined,
            offset: couponOffset,
          },
        });
        if (alive) setCoupons(r.items);
      } catch (e) {
        if (alive) { setCoupons([]); setCouponError(errText(e)); }
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, couponFilter, couponOffset, tick]);

  async function changeStatus(t: CouponTemplateRow, to: string, label: string) {
    try {
      if (to === "on") {
        await call("admin/coupon-template/status", { method: "POST", token: "admin", idem: newIdem(), body: { template_id: t.id, status: to } });
      } else {
        await riskyPost("admin/coupon-template/status", { template_id: t.id, status: to }, `${label}：${t.name}`);
      }
      setTick((k) => k + 1);
    } catch (e) {
      if (e instanceof ApiError && e.code === "confirm_required") return;
      window.alert(errText(e));
    }
  }

  async function removeTemplate(t: CouponTemplateRow) {
    try {
      await riskyPost("admin/coupon-template/delete", { template_id: t.id }, `删除券模板：${t.name}`);
      if (editing !== null && editing !== "new" && editing.id === t.id) setEditing(null);
      setTick((k) => k + 1);
    } catch (e) {
      if (e instanceof ApiError && e.code === "confirm_required") return;
      window.alert(errText(e));
    }
  }

  const canManage = has("coupon.manage");
  const canGrant = has("coupon.grant");

  if (editing !== null && canManage) {
    return (
      <div className="flex flex-col gap-4">
        <PageTitle title={editing === "new" ? "新建券模板" : "编辑券模板"} desc="新建模板默认为「已停用」，需手动开始发放后才可被领取或下发。" />
        <TemplateEditor
          template={editing === "new" ? null : editing}
          categories={categories}
          onSaved={() => { setEditing(null); setTick((k) => k + 1); }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="优惠券" desc="券模板维护、券实例核对与批量发放（文档C CY1/CY2；权限点 coupon.manage / coupon.grant）" />
      <div className="flex gap-2 text-sm">
        {([["templates", "券模板"], ["coupons", "券实例"], ["grant", "批量发放"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={"rounded-md border px-4 py-1 transition " + (tab === k ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "templates" && (
        <>
          <Toolbar>
            <span className="flex flex-col gap-1">
              <Label htmlFor="ct-status">模板状态</Label>
              <select id="ct-status" className="h-9 rounded-md border bg-background px-2 text-sm" value={tplStatus}
                onChange={(e) => { setTplStatus(e.target.value); setTplOffset(0); }}>
                <option value="">全部</option><option value="on">发放中</option><option value="off">已停用</option><option value="archived">已归档</option>
              </select>
            </span>
            <Button variant="outline" onClick={() => setTick((k) => k + 1)}>刷新</Button>
            {canManage && <Button className="ml-auto" onClick={() => setEditing("new")}>新建模板</Button>}
          </Toolbar>
          {listError && <p className="text-sm text-destructive">{listError}</p>}
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>券名称</TableHead><TableHead>类型</TableHead><TableHead>规则</TableHead><TableHead>适用范围</TableHead>
                  <TableHead>有效期</TableHead><TableHead>发放/上限</TableHead><TableHead>每人</TableHead><TableHead>领券中心</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="max-w-44 text-sm">
                      <span className="block truncate font-medium">{t.name}</span>
                      <span className="block text-xs text-muted-foreground">{langsOf(t.name_i18n) || "未配多语言，小语种显示中文名"}</span>
                    </TableCell>
                    <TableCell className="text-xs">{COUPON_TYPE_TEXT[t.coupon_type] ?? t.coupon_type}</TableCell>
                    <TableCell className="text-xs text-primary">{couponRuleText(t)}</TableCell>
                    <TableCell className="text-xs">{COUPON_SCOPE_TEXT[t.scope] ?? t.scope}{t.scope !== "all" ? `（${t.scope_ids.length}）` : ""}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.valid_days > 0 ? `领取后 ${t.valid_days} 天` : `${t.valid_from?.slice(0, 10) ?? "—"} → ${t.valid_until?.slice(0, 10) ?? "—"}`}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{t.issued_count} / {t.unlimited ? "不限" : t.total_quota}</TableCell>
                    <TableCell className="text-xs">{t.per_user_limit}</TableCell>
                    <TableCell className="text-xs">{t.claimable ? <Badge variant="secondary">自助可领</Badge> : <span className="text-muted-foreground">仅后台发放</span>}</TableCell>
                    <TableCell>
                      <Badge variant={t.status === "on" ? "default" : t.status === "off" ? "secondary" : "outline"}>{TEMPLATE_STATUS_TEXT[t.status] ?? t.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {canManage && (
                        <span className="flex flex-wrap items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>编辑</Button>
                          {NEXT_STATUS[t.status]?.map(([to, label]) => (
                            <Button key={to} size="sm" variant={to === "on" ? "outline" : "ghost"}
                              className={to === "archived" ? "text-destructive" : ""}
                              disabled={busy}
                              onClick={() => void changeStatus(t, to, label)}>
                              {label}
                            </Button>
                          ))}
                          {t.status !== "on" && (
                            <Button size="sm" variant="ghost" className="text-destructive" disabled={busy}
                              onClick={() => void removeTemplate(t)}>删除</Button>
                          )}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {!templates.length && (
                  <TableRow><TableCell colSpan={10} className="py-8 text-center text-muted-foreground">暂无券模板：点击「新建模板」创建第一张券</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Button size="sm" variant="outline" disabled={tplOffset === 0} onClick={() => setTplOffset(Math.max(0, tplOffset - PAGE))}>上一页</Button>
            <span>{tplOffset + 1}–{Math.min(tplTotal, tplOffset + PAGE)} / 共 {tplTotal}</span>
            <Button size="sm" variant="outline" disabled={tplOffset + PAGE >= tplTotal} onClick={() => setTplOffset(tplOffset + PAGE)}>下一页</Button>
          </div>
        </>
      )}

      {tab === "coupons" && (
        <>
          <Toolbar>
            <span className="flex flex-col gap-1">
              <Label htmlFor="ci-status">券状态</Label>
              <select id="ci-status" className="h-9 rounded-md border bg-background px-2 text-sm" value={couponFilter.status}
                onChange={(e) => { setCouponFilter((f) => ({ ...f, status: e.target.value })); setCouponOffset(0); }}>
                <option value="">全部</option>
                {Object.entries(COUPON_STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </span>
            <span className="flex flex-col gap-1">
              <Label htmlFor="ci-tpl">模板</Label>
              <select id="ci-tpl" className="h-9 min-w-40 rounded-md border bg-background px-2 text-sm" value={couponFilter.template_id}
                onChange={(e) => { setCouponFilter((f) => ({ ...f, template_id: e.target.value })); setCouponOffset(0); }}>
                <option value="">全部</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </span>
            <Button variant="outline" onClick={() => setTick((k) => k + 1)}>刷新</Button>
          </Toolbar>
          {couponError && <p className="text-sm text-destructive">{couponError}</p>}
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow><TableHead>券名称</TableHead><TableHead>用户</TableHead><TableHead>状态</TableHead><TableHead>面额</TableHead><TableHead>有效期至</TableHead><TableHead>来源</TableHead><TableHead>关联订单</TableHead><TableHead>领取时间</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {coupons.map((c) => (
                  <TableRow key={c.coupon_id}>
                    <TableCell className="max-w-40 truncate text-sm">{c.name || "券已下架"}</TableCell>
                    <TableCell className="text-sm">{c.username}{c.nickname ? `（${c.nickname}）` : ""}</TableCell>
                    <TableCell><Badge variant={c.status === "UNUSED" ? "default" : c.status === "LOCKED" ? "secondary" : "outline"}>{COUPON_STATUS_TEXT[c.status] ?? c.status}</Badge></TableCell>
                    <TableCell className="text-xs tabular-nums">{formatBase(c.discount_amount_base)}</TableCell>
                    <TableCell className="text-xs">{c.expire_at.slice(0, 10)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.source}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{c.order_id ? c.order_id.slice(0, 8) : "—"}</TableCell>
                    <TableCell className="text-xs">{c.created_at.slice(0, 10)}</TableCell>
                  </TableRow>
                ))}
                {!coupons.length && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">{coupons.length ? "" : "暂无券实例（发放后此处可核对）"}</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Button size="sm" variant="outline" disabled={couponOffset === 0} onClick={() => setCouponOffset(Math.max(0, couponOffset - PAGE))}>上一页</Button>
            <span>每页 {PAGE} 条 · 偏移 {couponOffset}</span>
            <Button size="sm" variant="outline" disabled={coupons.length < PAGE} onClick={() => setCouponOffset(couponOffset + PAGE)}>下一页</Button>
          </div>
        </>
      )}

      {tab === "grant" && (canGrant
        ? <GrantCard templates={templates} />
        : <p className="text-sm text-muted-foreground">当前账号缺少 coupon.grant 权限，无法发放优惠券。</p>)}
      {tab === "grant" && !templates.some((t) => t.status === "on") && canGrant && (
        <p className="text-xs text-muted-foreground">没有「发放中」的模板：先在券模板标签页把某个模板设为发放中。</p>
      )}
    </div>
  );
}
