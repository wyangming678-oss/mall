// 后台金币：CO1 规则维护 / CO2 兑换专区目录 / CO3 兑换单履约（文档F §五；权限点 coin.manage / coin.fulfill）
// 规则只约束此后新发放/新兑换，历史流水与兑换单快照不回溯；实物兑换单独立于订单链，仅在此发货/撤销
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { call, newIdem, uploadImageKey } from "../../api";
import { useAdmin } from "../AdminAuth";
import { PageTitle, Toolbar, errText, isConfirmCancel, riskyPost, useBusy } from "../ui";
import type { Paged } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { COIN_ITEM_TYPE_TEXT, REDEMPTION_STATUS_TEXT, coinText } from "../../coins";
import { fmtTime } from "../../trade";

const PAGE = 20;
const asInt = (v: string): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
};

interface BonusStep { streak: number; bonus: number }
interface CoinRules {
  checkin: { base: number; bonus_schedule: BonusStep[]; cycle_days: number };
  order_reward: { enabled: boolean; rate_bp: number; min: number; max: number };
  invite_reward: { inviter: number; invitee: number };
}
interface CoinItemAdmin {
  id: string; item_type: string; title: string; title_i18n: Record<string, string> | null;
  description: string; images: string[]; coin_price: number; stock_mode: string;
  stock_available: number | null; per_user_limit: number; redeemed_count: number; status: string;
  sort_order: number; coupon_template_id: string | null; sku_id: string | null;
  vip_plan_id: string | null; vip_duration_days: number | null;
  virtual_content: string | null; created_at: string; updated_at: string;
}
interface CoinRedemptionAdmin {
  id: string; user_id: string; coin_item_id: string; item_type: string; title_snapshot: string;
  coin_amount: number; status: string; coupon_instance_id: string | null; virtual_snapshot: string | null;
  user_vip_id: string | null; vip_status: string | null; vip_expire_at: string | null;
  address_snapshot: { receiver_name?: string; phone?: string; province?: string; city?: string; detail?: string } | null;
  ship_company: string | null; ship_no: string | null; created_at: string; updated_at: string;
  username: string; nickname: string;
}
interface VipPlanOpt { plan_id: string; name: string; status: string; duration_days: number }

// —— CO1 规则编辑器 ——
function RulesEditor({ onSaved }: { onSaved: () => void }) {
  const [rules, setRules] = useState<CoinRules | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, run] = useBusy();

  useEffect(() => {
    let alive = true;
    call<CoinRules>("admin/coin/rules", { token: "admin" })
      .then((r) => { if (alive) setRules(r); })
      .catch((e: unknown) => { if (alive) setError(errText(e)); });
    return () => { alive = false; };
  }, []);

  if (!rules) return <p className="py-6 text-sm text-muted-foreground">{error || "加载金币规则…"}</p>;

  const patch = (p: Partial<CoinRules>) => { setRules((r) => (r ? { ...r, ...p } : r)); setError(""); setMsg(""); };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!rules) return;
    if (rules.order_reward.min > rules.order_reward.max) { setError("返币下限不得大于上限"); return; }
    setError(""); setMsg("");
    await run(async () => {
      try {
        await call("admin/coin/rules/save", { method: "POST", token: "admin", idem: newIdem(), body: { coin_rules: rules } });
        setMsg("已保存并即时生效");
        onSaved();
      } catch (err) {
        setError(errText(err));
      }
    });
  }

  const setStep = (i: number, key: keyof BonusStep, val: string) => {
    const arr = rules.checkin.bonus_schedule.map((s, idx) => (idx === i ? { ...s, [key]: asInt(val) } : s));
    patch({ checkin: { ...rules.checkin, bonus_schedule: arr } });
  };

  return (
    <form className="flex flex-col gap-5 border bg-card p-4" onSubmit={save}>
      <p className="text-sm font-semibold">金币规则（CO1）</p>

      <section className="flex flex-col gap-3">
        <p className="text-sm font-medium">每日签到</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm">基础签到金币</span>
            <Input type="number" min={0} value={rules.checkin.base} onChange={(e) => patch({ checkin: { ...rules.checkin, base: asInt(e.target.value) } })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm">连签周期（天，0=不设上限）</span>
            <Input type="number" min={0} max={3650} value={rules.checkin.cycle_days} onChange={(e) => patch({ checkin: { ...rules.checkin, cycle_days: asInt(e.target.value) } })} />
          </label>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm">连签阶梯加成（连续满 streak 天额外 +bonus，最多 10 档）</span>
            {rules.checkin.bonus_schedule.length < 10 && (
              <Button type="button" size="sm" variant="outline"
                onClick={() => patch({ checkin: { ...rules.checkin, bonus_schedule: [...rules.checkin.bonus_schedule, { streak: (rules.checkin.bonus_schedule.at(-1)?.streak ?? 0) + 1, bonus: 0 }] } })}>
                加一档
              </Button>
            )}
          </div>
          {!rules.checkin.bonus_schedule.length && <p className="text-xs text-muted-foreground">暂无阶梯：只按基础金币签到。</p>}
          {rules.checkin.bonus_schedule.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">连签</span>
              <Input className="h-8 w-20" type="number" min={1} max={3650} value={s.streak} onChange={(e) => setStep(i, "streak", e.target.value)} />
              <span className="text-muted-foreground">天，额外 +</span>
              <Input className="h-8 w-24" type="number" min={0} value={s.bonus} onChange={(e) => setStep(i, "bonus", e.target.value)} />
              <span className="text-muted-foreground">金币</span>
              <Button type="button" size="sm" variant="ghost" className="ml-auto text-destructive"
                onClick={() => patch({ checkin: { ...rules.checkin, bonus_schedule: rules.checkin.bonus_schedule.filter((_, idx) => idx !== i) } })}>删除</Button>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 border-t pt-4">
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={rules.order_reward.enabled} onCheckedChange={(v) => patch({ order_reward: { ...rules.order_reward, enabled: v } })} />
          下单返币（完成订单后按实付比例返金币）
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm">返币比例（万分比，100=1%）</span>
            <Input type="number" min={0} max={10000} value={rules.order_reward.rate_bp} onChange={(e) => patch({ order_reward: { ...rules.order_reward, rate_bp: asInt(e.target.value) } })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm">单笔下限</span>
            <Input type="number" min={0} value={rules.order_reward.min} onChange={(e) => patch({ order_reward: { ...rules.order_reward, min: asInt(e.target.value) } })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm">单笔上限</span>
            <Input type="number" min={0} value={rules.order_reward.max} onChange={(e) => patch({ order_reward: { ...rules.order_reward, max: asInt(e.target.value) } })} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">返币在订单「已完成」时触发，退款窗口已关闭，无需撤币。</p>
      </section>

      <section className="flex flex-col gap-3 border-t pt-4">
        <p className="text-sm font-medium">邀请返金币</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-sm">邀请人得金币（每次触发）</span>
            <Input type="number" min={0} value={rules.invite_reward.inviter} onChange={(e) => patch({ invite_reward: { ...rules.invite_reward, inviter: asInt(e.target.value) } })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm">被邀请人得金币</span>
            <Input type="number" min={0} value={rules.invite_reward.invitee} onChange={(e) => patch({ invite_reward: { ...rules.invite_reward, invitee: asInt(e.target.value) } })} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">与「邀请奖励类型=coin」配合使用：奖励类型选金币时按此数额到账。</p>
      </section>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {msg && <p className="text-sm text-primary">{msg}</p>}
      <div><Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存金币规则"}</Button></div>
    </form>
  );
}

// —— CO2 兑换项编辑器 ——
interface ItemDraft {
  item_type: string; title: string; description: string; images: string[]; coin_price: string;
  stock_mode: string; stock_available: string; per_user_limit: string; sort_order: string;
  coupon_template_id: string; vip_plan_id: string; vip_duration_days: string; sku_id: string;
}
const EMPTY_ITEM: ItemDraft = {
  item_type: "coupon", title: "", description: "", images: [], coin_price: "100", stock_mode: "limited",
  stock_available: "100", per_user_limit: "0", sort_order: "0", coupon_template_id: "", vip_plan_id: "", vip_duration_days: "", sku_id: "",
};
const toItemDraft = (it: CoinItemAdmin): ItemDraft => ({
  item_type: it.item_type, title: it.title, description: it.description ?? "", images: it.images ?? [],
  coin_price: String(it.coin_price), stock_mode: it.stock_mode, stock_available: String(it.stock_available ?? 0),
  per_user_limit: String(it.per_user_limit), sort_order: String(it.sort_order),
  coupon_template_id: it.coupon_template_id ?? "", sku_id: it.sku_id ?? "",
  vip_plan_id: it.vip_plan_id ?? "", vip_duration_days: it.vip_duration_days ? String(it.vip_duration_days) : "",
});

// 已停售类型（文档P §2）：历史项只读，不能再保存，只能归档
const RETIRED_ITEM_TYPES = ["virtual"];

function ItemEditor({ item, templates, plans, onSaved, onCancel }: {
  item: CoinItemAdmin | null; templates: { id: string; name: string; status: string }[];
  plans: VipPlanOpt[]; onSaved: () => void; onCancel: () => void;
}) {
  const [d, setD] = useState<ItemDraft>(() => (item ? toItemDraft(item) : EMPTY_ITEM));
  const [error, setError] = useState("");
  const [busy, run] = useBusy();
  const patch = (p: Partial<ItemDraft>) => { setD((x) => ({ ...x, ...p })); setError(""); };

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    await run(async () => {
      try {
        const next = [...d.images];
        for (const f of Array.from(files)) {
          if (next.length >= 6) break;
          next.push(await uploadImageKey(f, "products", "admin"));
        }
        patch({ images: next });
      } catch (e) { setError(errText(e)); }
    });
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (RETIRED_ITEM_TYPES.includes(d.item_type)) { setError("「虚拟权益」已停售，不能再保存此项"); return; }
    if (!d.title.trim()) { setError("请填写标题"); return; }
    if (asInt(d.coin_price) < 1) { setError("兑换金币价需 ≥ 1"); return; }
    if (d.item_type === "coupon" && !d.coupon_template_id) { setError("券类兑换项需选择关联券模板"); return; }
    if (d.item_type === "vip") {
      if (!d.vip_plan_id) { setError("权益兑换项需选择关联会员套餐"); return; }
      if (asInt(d.vip_duration_days) < 1) { setError("权益时长（天）需 ≥ 1"); return; }
    }
    setError("");
    await run(async () => {
      try {
        await call("admin/coin-item/save", {
          method: "POST", token: "admin", idem: newIdem(),
          body: {
            item_id: item?.id,
            item_type: d.item_type,
            title: d.title.trim(),
            description: d.description.trim(),
            images: d.images,
            coin_price: asInt(d.coin_price),
            stock_mode: d.stock_mode,
            stock_available: d.stock_mode === "limited" ? asInt(d.stock_available) : 0,
            per_user_limit: asInt(d.per_user_limit),
            sort_order: asInt(d.sort_order),
            coupon_template_id: d.item_type === "coupon" ? d.coupon_template_id : null,
            vip_plan_id: d.item_type === "vip" ? d.vip_plan_id : null,
            vip_duration_days: d.item_type === "vip" ? asInt(d.vip_duration_days) : null,
            sku_id: d.item_type === "physical" && d.sku_id.trim() ? d.sku_id.trim() : null,
          },
        });
        onSaved();
      } catch (err) { setError(errText(err)); }
    });
  }

  const retired = RETIRED_ITEM_TYPES.includes(d.item_type);
  const planDays = (id: string) => String(plans.find((p) => p.plan_id === id)?.duration_days ?? "");

  return (
    <form className="flex flex-col gap-4 border bg-card p-4" onSubmit={onSave}>
      <p className="text-sm font-semibold">{item ? `编辑兑换项：${item.title}` : "新建兑换项"}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm">兑换类型 *</span>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={d.item_type} onChange={(e) => patch({ item_type: e.target.value })} disabled={Boolean(item)}>
            <option value="coupon">优惠券</option>
            <option value="vip">会员权益</option>
            <option value="physical">实物商品</option>
            {retired && <option value={d.item_type}>{COIN_ITEM_TYPE_TEXT[d.item_type] ?? d.item_type}（已停售）</option>}
          </select>
          {item && !retired && <p className="text-xs text-muted-foreground">类型创建后不可改，如需换类型请归档后重建</p>}
          {retired && <p className="text-xs text-destructive">「虚拟权益」已停售：此项不能再保存，请归档后按需新建「会员权益」或「实物商品」。</p>}
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-sm">标题 *</span>
          <Input maxLength={60} value={d.title} onChange={(e) => patch({ title: e.target.value })} placeholder="5 无门槛券 / 定制帆布包" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">兑换金币价 *</span>
          <Input type="number" min={1} value={d.coin_price} onChange={(e) => patch({ coin_price: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">库存模式</span>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={d.stock_mode} onChange={(e) => patch({ stock_mode: e.target.value })}>
            <option value="limited">限量（扣减库存）</option>
            <option value="unlimited">不限量</option>
          </select>
        </label>
        {d.stock_mode === "limited" && (
          <label className="flex flex-col gap-1">
            <span className="text-sm">可兑库存</span>
            <Input type="number" min={0} value={d.stock_available} onChange={(e) => patch({ stock_available: e.target.value })} />
            {item && <p className="text-xs text-muted-foreground">已兑 {item.redeemed_count} 件，不得低于此数</p>}
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-sm">每人限兑（0=不限）</span>
          <Input type="number" min={0} max={999} value={d.per_user_limit} onChange={(e) => patch({ per_user_limit: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">排序（小在前）</span>
          <Input type="number" min={0} max={999} value={d.sort_order} onChange={(e) => patch({ sort_order: e.target.value })} />
        </label>

        {d.item_type === "coupon" && (
          <label className="flex flex-col gap-1 lg:col-span-2">
            <span className="text-sm">关联券模板 *</span>
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={d.coupon_template_id} onChange={(e) => patch({ coupon_template_id: e.target.value })}>
              <option value="">（选择券模板）</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.status !== "on" ? "（已停用）" : ""}</option>)}
            </select>
          </label>
        )}
        {d.item_type === "vip" && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-sm">关联会员套餐 *</span>
              <select className="h-9 rounded-md border bg-background px-2 text-sm" value={d.vip_plan_id} onChange={(e) => patch({ vip_plan_id: e.target.value, vip_duration_days: planDays(e.target.value) })}>
                <option value="">（选择会员套餐）</option>
                {plans.map((p) => <option key={p.plan_id} value={p.plan_id}>{p.name}{p.status !== "on" ? "（已下架）" : ""}</option>)}
              </select>
              {!plans.length && (
                <p className="text-xs text-amber-700">
                  还没有可选的会员套餐：请先到后台「VIP 会员」页新建套餐；若那里也打不开，是当前账号缺少 vip.manage 权限。
                </p>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">权益时长（天）*</span>
              <Input type="number" min={1} max={3650} value={d.vip_duration_days} onChange={(e) => patch({ vip_duration_days: e.target.value })} placeholder="如 30 / 14 / 1" />
              <span className="text-xs text-muted-foreground">兑换即发放会员时长，可覆盖套餐默认天数；权益内容一律取所选套餐，发放后不可撤销</span>
            </label>
          </>
        )}
        {d.item_type === "physical" && (
          <label className="flex flex-col gap-1 lg:col-span-2">
            <span className="text-sm">关联 SKU（可选，UUID）</span>
            <Input className="font-mono" value={d.sku_id} onChange={(e) => patch({ sku_id: e.target.value })} placeholder="仅备注用途，发货在本页兑换单处理" />
          </label>
        )}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm">说明</span>
        <textarea rows={2} className="rounded-md border bg-background px-3 py-2 text-sm" maxLength={500} value={d.description} onChange={(e) => patch({ description: e.target.value })} />
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-sm">图片（最多 6 张）</span>
        <div className="flex flex-wrap items-center gap-2">
          {d.images.map((k, i) => (
            <span key={k} className="flex items-center gap-1 border bg-muted/40 px-2 py-1 text-xs font-mono">
              {k.slice(0, 18)}…
              <button type="button" className="text-destructive" onClick={() => patch({ images: d.images.filter((_, idx) => idx !== i) })}>✕</button>
            </span>
          ))}
          {d.images.length < 6 && (
            <label className="cursor-pointer border border-dashed px-3 py-1 text-sm text-muted-foreground hover:border-primary">
              {busy ? "上传中…" : "+ 上传图片"}
              <input type="file" accept="image/*" multiple className="hidden" disabled={busy} onChange={(e) => void upload(e.target.files)} />
            </label>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || retired}>{busy ? "保存中…" : "保存兑换项"}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>返回列表</Button>
      </div>
      <p className="text-xs text-muted-foreground">新建的兑换项默认为「已下架」，保存后在列表里点「上架」才对前台可见。</p>
    </form>
  );
}

// —— CO2 目录面板 ——
function CatalogPanel({ templates, plans }: {
  templates: { id: string; name: string; status: string }[]; plans: VipPlanOpt[];
}) {
  const [rows, setRows] = useState<CoinItemAdmin[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<"new" | CoinItemAdmin | null>(null);
  const [busy, run] = useBusy();

  const reload = useCallback(() => {
    setError("");
    void run(async () => {
      try {
        const r = await call<Paged<CoinItemAdmin>>("admin/coin-items", {
          token: "admin", query: { status: status || undefined, item_type: type || undefined, offset },
        });
        setRows(r.items); setNextOffset(r.next_offset ?? null);
      } catch (e) { setError(errText(e)); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, type, offset]);

  useEffect(() => { reload(); }, [reload, tick]);

  async function toggle(it: CoinItemAdmin, to: string) {
    setError("");
    await run(async () => {
      try {
        await call("admin/coin-item/status", { method: "POST", token: "admin", idem: newIdem(), body: { item_id: it.id, status: to } });
        setTick((k) => k + 1);
      } catch (e) { setError(errText(e)); }
    });
  }

  if (editing !== null) {
    return (
      <ItemEditor
        item={editing === "new" ? null : editing}
        templates={templates}
        plans={plans}
        onSaved={() => { setEditing(null); setTick((k) => k + 1); }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <>
      <Toolbar>
        <label className="flex flex-col gap-1">
          <span className="text-sm">状态</span>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">全部</option><option value="on">已上架</option><option value="off">已下架</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">类型</span>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={type} onChange={(e) => { setType(e.target.value); setOffset(0); }}>
            <option value="">全部</option>
            <option value="coupon">优惠券</option><option value="vip">会员权益</option><option value="physical">实物商品</option>
          </select>
        </label>
        <Button variant="outline" disabled={busy} onClick={() => setTick((k) => k + 1)}>刷新</Button>
        <Button className="ml-auto" onClick={() => setEditing("new")}>新建兑换项</Button>
      </Toolbar>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>标题</TableHead><TableHead>类型</TableHead><TableHead>金币价</TableHead>
              <TableHead>库存</TableHead><TableHead>每人限兑</TableHead><TableHead>已兑</TableHead>
              <TableHead>状态</TableHead><TableHead>排序</TableHead><TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((it) => (
              <TableRow key={it.id}>
                <TableCell className="max-w-40 truncate text-sm font-medium">{it.title}</TableCell>
                <TableCell className="text-xs">{COIN_ITEM_TYPE_TEXT[it.item_type] ?? it.item_type}</TableCell>
                <TableCell className="text-xs tabular-nums text-primary">{coinText(it.coin_price)}</TableCell>
                <TableCell className="text-xs tabular-nums">{it.stock_mode === "unlimited" ? "不限" : coinText(it.stock_available ?? 0)}</TableCell>
                <TableCell className="text-xs">{it.per_user_limit > 0 ? it.per_user_limit : "—"}</TableCell>
                <TableCell className="text-xs tabular-nums">{it.redeemed_count}</TableCell>
                <TableCell><Badge variant={it.status === "on" ? "default" : "secondary"}>{it.status === "on" ? "已上架" : "已下架"}</Badge></TableCell>
                <TableCell className="text-xs">{it.sort_order}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(it)}>编辑</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggle(it, it.status === "on" ? "off" : "on")}>
                      {it.status === "on" ? "下架" : "上架"}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void toggle(it, "archived")}>归档</Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                还没有兑换项：点「新建兑换项」创建，保存后记得上架。
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
        <span>每页 {PAGE} 条 · 偏移 {offset}</span>
        <Button size="sm" variant="outline" disabled={nextOffset === null} onClick={() => setOffset(nextOffset ?? 0)}>下一页</Button>
      </div>
    </>
  );
}

// —— CO3 兑换单履约：发货 / 撤销弹窗 ——
function FulfillDialog({ row, mode, onClose, onDone }: {
  row: CoinRedemptionAdmin; mode: "ship" | "revoke"; onClose: () => void; onDone: () => void;
}) {
  const [company, setCompany] = useState("");
  const [no, setNo] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, run] = useBusy();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    await run(async () => {
      try {
        if (mode === "ship") {
          if (!company.trim() || !no.trim()) { setError("请填写物流公司与运单号"); return; }
          await riskyPost("admin/coin-redemption/ship", { redemption_id: row.id, ship_company: company.trim(), ship_no: no.trim() },
            `为「${row.title_snapshot}」发货：${company.trim()} ${no.trim()}`);
        } else {
          await riskyPost("admin/coin-redemption/revoke", { redemption_id: row.id, reason: reason.trim() },
            `撤销兑换「${row.title_snapshot}」（退币${row.item_type === "coupon" ? " + 撤回未用券" : ""}${row.item_type === "physical" ? " + 回库存" : ""}）`);
        }
        onDone();
      } catch (e) {
        if (!isConfirmCancel(e)) setError(errText(e));
      }
    });
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-modal>
      <form className="flex w-full max-w-md flex-col gap-3 border bg-background p-4" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <p className="text-sm font-semibold">{mode === "ship" ? "实物兑换发货" : "撤销兑换（退币）"}</p>
        <p className="text-xs text-muted-foreground">
          {row.username}{row.nickname ? `（${row.nickname}）` : ""} · {COIN_ITEM_TYPE_TEXT[row.item_type] ?? row.item_type}「{row.title_snapshot}」 · 消耗 {coinText(row.coin_amount)} 金币
        </p>
        {mode === "ship" && (
          <>
            {row.address_snapshot && (
              <p className="border border-dashed px-2 py-1 text-xs text-muted-foreground">
                收货：{row.address_snapshot.receiver_name} {row.address_snapshot.phone} · {row.address_snapshot.province}{row.address_snapshot.city}{row.address_snapshot.detail}
              </p>
            )}
            <label className="flex flex-col gap-1"><span className="text-sm">物流公司 *</span>
              <Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={40} placeholder="顺丰" /></label>
            <label className="flex flex-col gap-1"><span className="text-sm">运单号 *</span>
              <Input value={no} onChange={(e) => setNo(e.target.value)} maxLength={60} placeholder="SF1234567890" /></label>
          </>
        )}
        {mode === "revoke" && (
          <>
            <label className="flex flex-col gap-1"><span className="text-sm">撤销原因（写入审计）</span>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="商品缺货 / 用户申请" /></label>
            <p className="text-xs text-muted-foreground">券已使用的兑换单不可撤销；撤销会退回金币并回收库存。</p>
          </>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="submit" className="ml-auto" disabled={busy}>{busy ? "提交中…" : mode === "ship" ? "确认发货" : "确认撤销"}</Button>
        </div>
      </form>
    </div>
  );
}

function RedemptionsPanel({ canFulfill }: { canFulfill: boolean }) {
  const [rows, setRows] = useState<CoinRedemptionAdmin[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [acting, setActing] = useState<{ row: CoinRedemptionAdmin; mode: "ship" | "revoke" } | null>(null);
  const [busy, run] = useBusy();

  const reload = useCallback(() => {
    setError("");
    void run(async () => {
      try {
        const r = await call<Paged<CoinRedemptionAdmin> & { counts_by_status: Record<string, number> }>("admin/coin-redemptions", {
          token: "admin", query: { status: status || undefined, item_type: type || undefined, offset },
        });
        setRows(r.items); setCounts(r.counts_by_status ?? {}); setNextOffset(r.next_offset ?? null);
      } catch (e) { setError(errText(e)); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, type, offset]);

  useEffect(() => { reload(); }, [reload, tick]);

  return (
    <>
      <Toolbar>
        <label className="flex flex-col gap-1">
          <span className="text-sm">状态</span>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">全部</option>
            {Object.entries(REDEMPTION_STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v}（{counts[k] ?? 0}）</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">类型</span>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={type} onChange={(e) => { setType(e.target.value); setOffset(0); }}>
            <option value="">全部</option>
            <option value="coupon">优惠券</option><option value="vip">会员权益</option><option value="physical">实物商品</option>
          </select>
        </label>
        <Button variant="outline" disabled={busy} onClick={() => setTick((k) => k + 1)}>刷新</Button>
      </Toolbar>
      {!canFulfill && <p className="text-sm text-amber-700">当前账号缺少 coin.fulfill 权限，仅可查看兑换单，不能发货或撤销。</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead><TableHead>兑换项</TableHead><TableHead>类型</TableHead>
              <TableHead>金币</TableHead><TableHead>状态</TableHead><TableHead>收货/权益/物流</TableHead><TableHead>时间</TableHead><TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-sm">{r.username}{r.nickname ? <span className="text-muted-foreground">（{r.nickname}）</span> : ""}</TableCell>
                <TableCell className="max-w-40 truncate text-sm">{r.title_snapshot}</TableCell>
                <TableCell className="text-xs">{COIN_ITEM_TYPE_TEXT[r.item_type] ?? r.item_type}</TableCell>
                <TableCell className="text-xs tabular-nums text-primary">{coinText(r.coin_amount)}</TableCell>
                <TableCell><Badge variant={r.status === "REVOKED" ? "outline" : r.status === "RECEIVED" ? "outline" : "secondary"}>{REDEMPTION_STATUS_TEXT[r.status] ?? r.status}</Badge></TableCell>
                <TableCell className="max-w-52 text-xs text-muted-foreground">
                  {r.item_type === "physical" && r.address_snapshot && (
                    <span>{r.address_snapshot.receiver_name} {r.address_snapshot.province ?? ""}{r.address_snapshot.city ?? ""}{r.address_snapshot.detail ?? ""}</span>
                  )}
                  {r.ship_company && <span className="block">物流：{r.ship_company} {r.ship_no}</span>}
                  {r.item_type === "coupon" && r.coupon_instance_id && <span>券 {r.coupon_instance_id.slice(0, 8)}</span>}
                  {r.item_type === "vip" && (
                    <span>会员有效期至 {r.vip_expire_at ? String(r.vip_expire_at).slice(0, 10) : "—"}
                      {r.vip_status === "refunded" ? "（发放异常，已收回）" : ""}
                    </span>
                  )}
                  {r.item_type === "virtual" && r.virtual_snapshot && <span className="line-clamp-1">{r.virtual_snapshot}</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtTime(r.created_at)}</TableCell>
                <TableCell>
                  {canFulfill && (
                    <span className="flex flex-wrap items-center gap-1">
                      {r.item_type === "physical" && r.status === "PENDING_SHIP" && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setActing({ row: r, mode: "ship" })}>发货</Button>
                      )}
                      {r.item_type === "vip" ? (
                        <span className="text-xs text-muted-foreground">权益已到账，不可撤销</span>
                      ) : (
                        (r.status === "REDEEMED" || r.status === "PENDING_SHIP") && (
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setActing({ row: r, mode: "revoke" })}>撤销</Button>
                        )
                      )}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">暂无兑换单。</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
        <span>每页 {PAGE} 条 · 偏移 {offset}</span>
        <Button size="sm" variant="outline" disabled={nextOffset === null} onClick={() => setOffset(nextOffset ?? 0)}>下一页</Button>
      </div>

      {acting && (
        <FulfillDialog row={acting.row} mode={acting.mode} onClose={() => setActing(null)} onDone={() => { setActing(null); setTick((k) => k + 1); }} />
      )}
    </>
  );
}

export default function CoinAdminPage() {
  const { has } = useAdmin();
  const [tab, setTab] = useState<"rules" | "catalog" | "redemptions">("rules");
  const [templates, setTemplates] = useState<{ id: string; name: string; status: string }[]>([]);
  const [plans, setPlans] = useState<VipPlanOpt[]>([]);
  const canManage = has("coin.manage");
  const canFulfill = has("coin.fulfill");

  useEffect(() => {
    if (!canManage) return;
    call<{ items: { id: string; name: string; status: string }[] }>("admin/coupon-templates", { token: "admin" })
      .then((r) => setTemplates(r.items.map((t) => ({ id: t.id, name: t.name, status: t.status }))))
      .catch(() => setTemplates([]));
    // 权益项需绑定会员套餐；套餐列表由 VIP 页维护，缺 vip.manage 时这里只会拿到空数组（编辑器给出去配的提示）
    call<{ items: VipPlanOpt[] }>("admin/vip-plans", { token: "admin" })
      .then((r) => setPlans((r.items ?? []).map((p) => ({ plan_id: p.plan_id, name: p.name, status: p.status, duration_days: Number(p.duration_days) || 0 }))))
      .catch(() => setPlans([]));
  }, [canManage]);

  if (!canManage && !canFulfill) {
    return <p className="text-sm text-muted-foreground">当前账号缺少金币相关权限（coin.manage / coin.fulfill），无法管理金币商城。</p>;
  }

  const tabs: ["rules" | "catalog" | "redemptions", string][] = [["rules", "金币规则"], ["catalog", "兑换专区"], ["redemptions", "兑换单"]];
  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="金币商城" desc="发放规则 CO1、兑换专区目录 CO2 与兑换单履约 CO3（文档F；金币与现金钱包完全独立）" />
      <div className="flex gap-2 text-sm">
        {tabs.map(([k, label]) => {
          const blocked = (k === "rules" || k === "catalog") && !canManage;
          return (
            <button key={k} type="button" disabled={blocked} onClick={() => setTab(k)}
              className={"border px-4 py-1 transition disabled:opacity-40 " + (tab === k ? "border-primary bg-primary text-primary-foreground" : "hover:border-primary")}>
              {label}
            </button>
          );
        })}
      </div>
      {tab === "rules" && <RulesEditor onSaved={() => undefined} />}
      {tab === "catalog" && <CatalogPanel templates={templates} plans={plans} />}
      {tab === "redemptions" && <RedemptionsPanel canFulfill={canFulfill} />}
    </div>
  );
}
