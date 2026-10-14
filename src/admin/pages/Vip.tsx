// 后台 VIP：VP1 套餐维护 / VP2 代开赠送 / 会员与到期名单（文档C §六.6；权限点 vip.manage）
// 套餐增删改只影响后续新开通——已售权益按开通瞬间的快照计费，不回溯
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, call, newIdem } from "../../api";
import { baseUnit, formatBase } from "../../const";
import { useAdmin } from "../AdminAuth";
import { PageTitle, Toolbar, errText, isConfirmCancel, riskyPost, useBusy } from "../ui";
import type { Paged, UserRow } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  VIP_PLAN_STATUS_TEXT, VIP_STATUS_TEXT, rateText, vipDaysLeft, yuanToCents,
  type VipPlan, type VipView,
} from "../../trade";

const PAGE = 20;

interface Draft {
  tier_key: string;
  name: string;
  zhe: string;
  duration_days: string;
  price_yuan: string;
  status: "on" | "off";
  sort_order: string;
  benefits: string;
}

const EMPTY: Draft = {
  tier_key: "", name: "", zhe: "9.5", duration_days: "30", price_yuan: "20",
  status: "on", sort_order: "0", benefits: "",
};

const toDraft = (p: VipPlan | null): Draft => (p ? {
  tier_key: p.tier_key,
  name: p.name,
  zhe: (p.discount_rate / 1000).toFixed(1).replace(/\.0$/, ""),
  duration_days: String(p.duration_days),
  price_yuan: (p.price_base / 100).toFixed(2),
  status: p.status === "off" ? "off" : "on",
  sort_order: String(p.sort_order),
  benefits: (p.benefits ?? []).join("\n"),
} : EMPTY);

/** 折 → 万分比：9.5 → 9500；10 折等于不打折，套餐不收 */
const toRate = (zhe: string): number => Math.round(Number(zhe) * 1000);

function draftError(d: Draft): string {
  if (!/^[a-z][a-z0-9_-]{1,29}$/.test(d.tier_key.trim())) return "等级键需为 2–30 位小写字母开头，仅含 a-z0-9_-";
  if (!d.name.trim()) return "请填写套餐名称";
  const rate = toRate(d.zhe);
  if (!Number.isFinite(rate) || rate < 1 || rate > 9999) return "折扣需为 0.01–9.999 折之间（万分比 1–9999）";
  const days = Number(d.duration_days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return "有效天数需为 1–3650 的整数";
  if (!yuanToCents(d.price_yuan)) return "套餐价格必须大于 0";
  const sort = Number(d.sort_order);
  if (!Number.isInteger(sort) || sort < 0 || sort > 9999) return "排序需为 0–9999 的整数";
  return "";
}

// —— VP1 套餐编辑器 ——
function PlanEditor({ plan, onSaved, onCancel }: {
  plan: VipPlan | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(plan));
  const [error, setError] = useState("");
  const [busy, run] = useBusy();
  const patch = (p: Partial<Draft>) => { setDraft((d) => ({ ...d, ...p })); setError(""); };

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const invalid = draftError(draft);
    if (invalid) { setError(invalid); return; }
    setError("");
    await run(async () => {
      try {
        await call("admin/vip-plan/save", {
          method: "POST", token: "admin", idem: newIdem(),
          body: {
            plan_id: plan?.plan_id,
            tier_key: draft.tier_key.trim(),
            name: draft.name.trim(),
            discount_rate: toRate(draft.zhe),
            duration_days: Number(draft.duration_days),
            price_base: yuanToCents(draft.price_yuan) ?? 0,
            benefits: draft.benefits.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 10),
            status: draft.status,
            sort_order: Number(draft.sort_order),
          },
        });
        onSaved();
      } catch (err) {
        setError(errText(err));
      }
    });
  }

  return (
    <div className="flex flex-col gap-4 border bg-card p-4">
      <p className="text-sm font-semibold">{plan ? `编辑套餐：${plan.name}` : "新建会员套餐"}</p>
      <form className="flex flex-col gap-4" onSubmit={onSave}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="vp-key">等级键 tier_key *</Label>
            <Input id="vp-key" required maxLength={30} value={draft.tier_key}
              onChange={(e) => patch({ tier_key: e.target.value })} placeholder="gold" disabled={Boolean(plan)} />
            {plan && <p className="text-xs text-muted-foreground">等级键是权益快照的标识，创建后不可改</p>}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="vp-name">套餐名称 *</Label>
            <Input id="vp-name" required maxLength={60} value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="金牌会员" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="vp-zhe">折扣（几折）*</Label>
            <Input id="vp-zhe" value={draft.zhe} onChange={(e) => patch({ zhe: e.target.value })} placeholder="9.5" />
            <p className="text-xs text-muted-foreground">
              万分比 {toRate(draft.zhe) || "—"} · 前台显示「{rateText(toRate(draft.zhe))}」
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="vp-days">有效天数 *</Label>
            <Input id="vp-days" type="number" min={1} max={3650} value={draft.duration_days} onChange={(e) => patch({ duration_days: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="vp-price">{`价格（${baseUnit()}）*`}</Label>
            <Input id="vp-price" value={draft.price_yuan} onChange={(e) => patch({ price_yuan: e.target.value })} placeholder="20.00" />
            <p className="text-xs text-muted-foreground">成交价一律按基准价折算，各币种展示价自动换算</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="vp-status">售卖状态</Label>
            <select id="vp-status" className="h-9 rounded-md border bg-background px-2 text-sm" value={draft.status}
              onChange={(e) => patch({ status: e.target.value as Draft["status"] })}>
              <option value="on">售卖中（前台可见）</option>
              <option value="off">已下架（前台不可见，仍可代开）</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="vp-sort">排序</Label>
            <Input id="vp-sort" type="number" min={0} max={9999} value={draft.sort_order} onChange={(e) => patch({ sort_order: e.target.value })} />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="vp-benefits">权益条目（每行一条，会整体复制进权益快照）</Label>
          <textarea id="vp-benefits" rows={3} className="rounded-md border bg-background px-3 py-2 text-sm"
            value={draft.benefits} onChange={(e) => patch({ benefits: e.target.value })}
            placeholder={"全场 9.5 折\n生日当月免运费"} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存套餐"}</Button>
          <Button type="button" variant="outline" onClick={onCancel}>返回列表</Button>
        </div>
      </form>
    </div>
  );
}

// —— VP2 后台代开 / 赠送（零扣款） ——
function GrantCard({ plans }: { plans: VipPlan[] }) {
  const [planId, setPlanId] = useState(plans[0]?.plan_id ?? "");
  const [keyword, setKeyword] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [userId, setUserId] = useState("");
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<VipView | null>(null);
  const [error, setError] = useState("");
  const [busy, run] = useBusy();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function grant() {
    if (!planId) { setError("请选择套餐"); return; }
    if (!userId) { setError("请选择被赠送的用户"); return; }
    if (reason.trim().length < 2) { setError("请填写赠送原因（至少 2 个字，会写入审计）"); return; }
    setError("");
    setResult(null);
    await run(async () => {
      try {
        const body: Record<string, unknown> = { user_id: userId, plan_id: planId, reason: reason.trim() };
        if (days.trim()) body.duration_days = Number(days);
        setResult(await riskyPost<VipView>("admin/user-vip/grant", body,
          `为用户 ${users.find((u) => u.id === userId)?.username ?? userId.slice(0, 8)} 开通 ${plans.find((p) => p.plan_id === planId)?.name ?? ""}`));
      } catch (e) {
        if (!isConfirmCancel(e)) setError(errText(e));
      }
    });
  }

  const picked = plans.find((p) => p.plan_id === planId);
  return (
    <div className="flex flex-col gap-3 border bg-card p-4">
      <p className="text-sm font-semibold">代开 / 赠送（⚠ 高危：零扣款、写审计）</p>
      <Toolbar>
        <span className="flex flex-col gap-1">
          <Label htmlFor="vg-plan">套餐（含已下架，便于补偿老套餐）</Label>
          <select id="vg-plan" className="h-9 min-w-44 rounded-md border bg-background px-2 text-sm" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {!plans.length && <option value="">（还没有套餐）</option>}
            {plans.map((p) => (
              <option key={p.plan_id} value={p.plan_id}>
                {p.name}（{rateText(p.discount_rate)} · {p.duration_days} 天 · {p.status === "off" ? "已下架" : "售卖中"}）
              </option>
            ))}
          </select>
        </span>
        <span className="flex flex-col gap-1">
          <Label htmlFor="vg-kw">用户搜索</Label>
          <Input id="vg-kw" className="h-9 w-40" placeholder="用户名/昵称" value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
        </span>
        <Button variant="outline" disabled={busy} onClick={search}>搜索</Button>
        <span className="flex flex-col gap-1">
          <Label htmlFor="vg-days">时长覆盖（天，留空按套餐）</Label>
          <Input id="vg-days" className="h-9 w-28" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
        </span>
        <span className="flex flex-col gap-1">
          <Label htmlFor="vg-reason">赠送原因 *</Label>
          <Input id="vg-reason" className="h-9 w-64" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="客诉补偿，赠送 7 天" />
        </span>
        <Button className="ml-auto" disabled={busy || !userId || !planId} onClick={() => void grant()}>
          {busy ? "处理中…" : "确认开通"}
        </Button>
      </Toolbar>
      {picked && (
        <p className="text-xs text-muted-foreground">
          成交价记 0、不产生钱包流水；折扣与天数按此刻套餐快照落库（{rateText(picked.discount_rate)} · {days.trim() ? `${Number(days)} 天` : `${picked.duration_days} 天`}）。
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="max-h-60 overflow-y-auto border">
        <Table>
          <TableHeader>
            <TableRow><TableHead className="w-10">选</TableHead><TableHead>用户名</TableHead><TableHead>昵称</TableHead><TableHead>余额</TableHead><TableHead>状态</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <input type="radio" name="vg-user" className="size-4 accent-[var(--primary)]" checked={userId === u.id}
                    onChange={() => setUserId(u.id)} aria-label={`选择 ${u.username}`} />
                </TableCell>
                <TableCell className="text-sm font-medium">{u.username}</TableCell>
                <TableCell className="text-sm">{u.nickname}</TableCell>
                <TableCell className="text-sm tabular-nums">{formatBase(u.balance)}</TableCell>
                <TableCell><Badge variant={u.status === "active" ? "secondary" : "destructive"}>{u.status === "active" ? "正常" : "禁用"}</Badge></TableCell>
              </TableRow>
            ))}
            {!users.length && <TableRow><TableCell colSpan={5} className="py-6 text-center text-muted-foreground">没有匹配的用户</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      {result && (
        <p className="text-sm text-primary">
          已开通：{result.tier_key} · {rateText(result.discount_rate)} · {result.start_at.slice(0, 10)} → {result.expire_at.slice(0, 10)}（续费在原到期日之后顺延）
        </p>
      )}
    </div>
  );
}

// —— 会员记录 / 到期名单 ——
function RecordsPanel() {
  const [rows, setRows] = useState<VipView[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [userId, setUserId] = useState("");
  const [error, setError] = useState("");
  const [busy, run] = useBusy();

  useEffect(() => {
    let alive = true;
    setError("");
    void run(async () => {
      try {
        const r = await call<Paged<VipView>>("admin/user-vips", {
          token: "admin", query: { status: status || undefined, user_id: userId || undefined, offset },
        });
        if (alive) { setRows(r.items); setNextOffset(r.next_offset ?? null); }
      } catch (e) {
        if (alive) { setRows([]); setNextOffset(null); setError(errText(e)); }
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, userId, offset]);

  const soon = (r: VipView) => r.status === "active" && vipDaysLeft(r.expire_at) <= 7;
  return (
    <>
      <Toolbar>
        <span className="flex flex-col gap-1">
          <Label htmlFor="vr-status">权益状态</Label>
          <select id="vr-status" className="h-9 rounded-md border bg-background px-2 text-sm" value={status}
            onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">全部</option>
            {Object.entries(VIP_STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </span>
        <span className="flex flex-col gap-1">
          <Label htmlFor="vr-user">用户 ID（从名单里复制）</Label>
          <Input id="vr-user" className="h-9 w-64 font-mono" value={userId}
            onChange={(e) => setUserId(e.target.value.trim())} placeholder="留空看全站" />
        </span>
        <Button variant="outline" disabled={busy} onClick={() => setOffset((o) => o)}>刷新</Button>
        <span className="text-xs text-muted-foreground">按到期时间倒序：7 天内到期的生效权益会标黄，便于安排续费提醒。</span>
      </Toolbar>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead><TableHead>等级</TableHead><TableHead>折扣</TableHead>
              <TableHead>生效起</TableHead><TableHead>到期</TableHead><TableHead>成交价</TableHead>
              <TableHead>来源</TableHead><TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.vip_id}>
                <TableCell className="text-sm">
                  {r.buyer?.username ?? (r.user_id ? r.user_id.slice(0, 8) : "—")}
                  {r.buyer?.nickname && <span className="text-muted-foreground">（{r.buyer.nickname}）</span>}
                </TableCell>
                <TableCell className="text-xs">{r.tier_key}</TableCell>
                <TableCell className="text-xs text-primary">{rateText(r.discount_rate)}</TableCell>
                <TableCell className="text-xs">{r.start_at.slice(0, 10)}</TableCell>
                <TableCell className={"text-xs " + (soon(r) ? "text-amber-700" : "")}>
                  {r.expire_at.slice(0, 10)}
                  {r.status === "active" && vipDaysLeft(r.expire_at) > 0 && <span className="ml-1 text-muted-foreground">剩 {vipDaysLeft(r.expire_at)} 天</span>}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {r.purchase_price_base === 0 ? "赠送" : formatBase(r.purchase_price_base)}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {r.payment_id ? r.payment_id.slice(0, 8) : "—"}
                </TableCell>
                <TableCell>
                  {/* status 是服务端原值：过期到扫任务落库前仍是 active，这里显式区分出来 */}
                  {r.status === "active" && vipDaysLeft(r.expire_at) === 0 ? (
                    <Badge variant="secondary">已过期待处理</Badge>
                  ) : (
                    <Badge variant={r.status === "active" ? "default" : r.status === "expired" ? "secondary" : "outline"}>
                      {VIP_STATUS_TEXT[r.status] ?? r.status}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                暂无会员记录：用户自助开通或后台代开后这里会出现。
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

export default function VipAdminPage() {
  const { has } = useAdmin();
  const [tab, setTab] = useState<"plans" | "grant" | "records">("plans");
  const [plans, setPlans] = useState<VipPlan[]>([]);
  const [editing, setEditing] = useState<"new" | VipPlan | null>(null);
  const [listError, setListError] = useState("");
  const [tick, setTick] = useState(0);
  const [busy, run] = useBusy();
  const canManage = has("vip.manage");

  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    setListError("");
    void run(async () => {
      try {
        const r = await call<{ items: VipPlan[] }>("admin/vip-plans", { token: "admin" });
        if (alive) setPlans(r.items);
      } catch (e) {
        if (alive) setListError(errText(e));
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, tick]);

  async function removePlan(p: VipPlan) {
    setListError("");
    await run(async () => {
      try {
        await riskyPost("admin/vip-plan/save", { plan_id: p.plan_id, delete: true }, `删除套餐：${p.name}`);
        setTick((k) => k + 1);
      } catch (e) {
        if (!isConfirmCancel(e)) setListError(errText(e));
      }
    });
  }

  async function toggleStatus(p: VipPlan) {
    setListError("");
    await run(async () => {
      try {
        await call("admin/vip-plan/save", {
          method: "POST", token: "admin", idem: newIdem(),
          body: {
            plan_id: p.plan_id, tier_key: p.tier_key, name: p.name, discount_rate: p.discount_rate,
            duration_days: p.duration_days, price_base: p.price_base, benefits: p.benefits,
            status: p.status === "on" ? "off" : "on", sort_order: p.sort_order,
          },
        });
        setTick((k) => k + 1);
      } catch (e) {
        if (e instanceof ApiError) setListError(errText(e));
      }
    });
  }

  if (!canManage) {
    return <p className="text-sm text-muted-foreground">当前账号缺少 vip.manage 权限，无法管理会员。</p>;
  }

  if (editing !== null) {
    return (
      <div className="flex flex-col gap-4">
        <PageTitle title={editing === "new" ? "新建会员套餐" : "编辑会员套餐"}
          desc="折扣为万分比（9500 = 9.5 折），只影响之后的新开通；已售权益按开通瞬间的快照继续生效。" />
        <PlanEditor
          plan={editing === "new" ? null : editing}
          onSaved={() => { setEditing(null); setTick((k) => k + 1); }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="VIP 会员" desc="套餐维护 VP1、代开赠送 VP2 与会员/到期名单（文档B §8：权益整体快照，不回溯改价）" />
      <div className="flex gap-2 text-sm">
        {([["plans", "套餐"], ["grant", "代开赠送"], ["records", "会员名单"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={"border px-4 py-1 transition " + (tab === k ? "border-primary bg-primary text-primary-foreground" : "hover:border-primary")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "plans" && (
        <>
          <Toolbar>
            <Button variant="outline" disabled={busy} onClick={() => setTick((k) => k + 1)}>刷新</Button>
            <Button className="ml-auto" onClick={() => setEditing("new")}>新建套餐</Button>
          </Toolbar>
          {listError && <p className="text-sm text-destructive">{listError}</p>}
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>套餐</TableHead><TableHead>等级键</TableHead><TableHead>折扣</TableHead><TableHead>时长</TableHead>
                  <TableHead>价格</TableHead><TableHead>权益</TableHead><TableHead>状态</TableHead><TableHead>排序</TableHead><TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((p) => (
                  <TableRow key={p.plan_id}>
                    <TableCell className="max-w-40 truncate text-sm font-medium">{p.name}</TableCell>
                    <TableCell className="font-mono text-xs">{p.tier_key}</TableCell>
                    <TableCell className="text-xs text-primary">{rateText(p.discount_rate)}</TableCell>
                    <TableCell className="text-xs">{p.duration_days} 天</TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {formatBase(p.price_base)}
                      {p.prices?.USD && <span className="ml-1 text-muted-foreground">${(p.prices.USD / 100).toFixed(2)}</span>}
                    </TableCell>
                    <TableCell className="max-w-52 truncate text-xs text-muted-foreground">{p.benefits.join("、") || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={p.status === "on" ? "default" : "secondary"}>{VIP_PLAN_STATUS_TEXT[p.status] ?? p.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{p.sort_order}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-1">
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(p)}>编辑</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggleStatus(p)}>
                          {p.status === "on" ? "下架" : "上架"}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void removePlan(p)}>删除</Button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {!plans.length && (
                  <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    还没有会员套餐：点「新建套餐」创建第一档
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            删除只封售卖入口（软删），已发出的权益与订单快照不受影响；下架的套餐仍可在此页代开。
          </p>
        </>
      )}

      {tab === "grant" && <GrantCard plans={plans} />}
      {tab === "records" && <RecordsPanel />}
    </div>
  );
}
