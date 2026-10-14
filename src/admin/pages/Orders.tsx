// 后台订单管理 OD1–OD6（文档C §六.3；高危动作走 confirm + 审计）
import { useCallback, useEffect, useState } from "react";
import { call, newIdem } from "../../api";
import { formatBase } from "../../const";
import { useSite } from "../../site";
import { useAdmin } from "../AdminAuth";
import { PageTitle, Toolbar, errText, isConfirmCancel, riskyPost } from "../ui";
import { AddressFields, addressDraftError, oneLine, toDraft, type AddressDraft } from "../../components/AddressFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  METHOD_TEXT, ORDER_STATUS_TEXT, PAYMENT_ROW_TEXT, PAYMENT_TYPE_TEXT, PAY_STATUS_TEXT, SHIP_STATUS_TEXT,
  coinOf, fmtTime, fmtDate, money, symbolOf, useDeadline,
  type AllowedActions, type OrderLine, type OrderRow, type PaymentRow,
} from "../../trade";
import type { InstallmentAdminView } from "../../installments";

interface ListRow {
  id: string;
  order_no: string;
  user_id: string;
  status_order: string;
  status_payment: string;
  status_shipping: string;
  actual_paid_amount_base: number;
  currency_code: string;
  currency_actual_amount: number;
  payment_deadline: string;
  buyer_remark: string | null;
  shipped_at: string | null;
  created_at: string;
  installment_count: number | null;
  buyer: { username: string; nickname: string } | null;
  item_count: number;
}
interface Page<T> { offset: number; limit: number; has_more: boolean; next_offset: number | null; items: T[] }
interface OD2 {
  order: OrderRow;
  buyer: { username: string; nickname: string; balance: number; currency_code: string; status: string } | null;
  items: OrderLine[];
  status_logs: Array<{ id: string; dim: string; from_status: string; to_status: string; operator_type: string; reason: string | null; created_at: string }>;
  payments: PaymentRow[];
  installment: InstallmentAdminView | null;
  idempotency_summary: Array<{ action: string; state: string; created_at: string }>;
  allowed_actions: AllowedActions;
}

const FILTERS: Array<[string, string, string[]]> = [
  ["status_order", "订单维", Object.keys(ORDER_STATUS_TEXT)],
  ["status_payment", "支付维", Object.keys(PAY_STATUS_TEXT)],
  ["status_shipping", "物流维", Object.keys(SHIP_STATUS_TEXT)],
];

function DimBadges({ row }: { row: ListRow }) {
  return (
    <span className="flex flex-wrap gap-1">
      <Badge variant={row.status_order === "COMPLETED" || row.status_order === "PAID" ? "default" : "secondary"}>
        {ORDER_STATUS_TEXT[row.status_order] ?? row.status_order}
      </Badge>
      <Badge variant="outline">{PAY_STATUS_TEXT[row.status_payment] ?? row.status_payment}</Badge>
      <Badge variant="outline">{SHIP_STATUS_TEXT[row.status_shipping] ?? row.status_shipping}</Badge>
      {Number(row.installment_count) >= 2 && (
        <Badge variant="outline" className="border-primary text-primary">分期 {row.installment_count} 期</Badge>
      )}
    </span>
  );
}

function ShipForm({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [form, setForm] = useState({ carrier: "", tracking_no: "", note: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-3">
      <span className="flex flex-col gap-1">
        <Label htmlFor="od-carrier">快递公司 *</Label>
        <Input id="od-carrier" className="h-8 w-28" value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} placeholder="顺丰" />
      </span>
      <span className="flex flex-col gap-1">
        <Label htmlFor="od-no">运单号 *</Label>
        <Input id="od-no" className="h-8 w-40" value={form.tracking_no} onChange={(e) => setForm({ ...form, tracking_no: e.target.value })} placeholder="SF1234567890" />
      </span>
      <span className="flex flex-col gap-1">
        <Label htmlFor="od-note">备注</Label>
        <Input id="od-note" className="h-8 w-32" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </span>
      <Button
        size="sm"
        disabled={busy || !form.carrier.trim() || form.tracking_no.trim().length < 3}
        onClick={async () => {
          setBusy(true); setError("");
          try {
            await riskyPost("admin/order/ship", {
              order_id: orderId, carrier: form.carrier.trim(), tracking_no: form.tracking_no.trim(), note: form.note || undefined,
            }, "发货");
            onDone();
          } catch (e) {
            if (!isConfirmCancel(e)) setError(errText(e));
          } finally { setBusy(false); }
        }}
      >确认发货</Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function CloseForm({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <span className="flex flex-col gap-1">
        <Label htmlFor="od-reason">关单原因（≥2 字，写入审计）</Label>
        <Input id="od-reason" className="h-8 w-56" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </span>
      <Button
        size="sm" variant="outline" className="text-destructive"
        disabled={reason.trim().length < 2}
        onClick={async () => {
          try {
            const r = await riskyPost<{ stock_released: boolean }>("admin/order/close", { order_id: orderId, reason: reason.trim() }, "强制关单");
            if (r && r.stock_released === false) window.alert("订单已关闭，但部分库存解冻失败，请查看库存流水");
            onDone();
          } catch (e) {
            if (!isConfirmCancel(e)) setError(errText(e));
          }
        }}
      >强制关单</Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function AddressEdit({ order, onDone }: { order: OrderRow; onDone: () => void }) {
  const [draft, setDraft] = useState<AddressDraft>(toDraft(order.address_snapshot));
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">修改收货信息（OD6）</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <AddressFields value={draft} onChange={(patch) => { setDraft((d) => ({ ...d, ...patch })); setError(""); setOk(""); }} />
        {error && <p className="text-sm text-destructive">{error}</p>}
        {ok && <p className="text-sm text-primary">{ok}</p>}
        <Button
          size="sm"
          onClick={async () => {
            const invalid = addressDraftError(draft);
            if (invalid) { setError(invalid); return; }
            try {
              await call("admin/order/address", {
                method: "POST", token: "admin", idem: crypto.randomUUID(),
                body: { order_id: order.id, ...draft, district: draft.district || undefined, postal_code: draft.postal_code || undefined },
              });
              setOk("收货信息已更新");
              onDone();
            } catch (e) { setError(errText(e)); }
          }}
        >保存收货信息</Button>
      </CardContent>
    </Card>
  );
}

// 后台分期账单面板：以不可变下单快照 installment_config.periods 为主干（首付未付时账单行尚未生成），
// 再按期序叠加 order_installments 实时状态（PAID/逾期）。口径对齐购物端 OrderDetail。
function InstallmentBillPanel({ inst }: { inst: InstallmentAdminView }) {
  const snapshot = inst.installment_config?.periods ?? [];
  const live = (idx: number) => inst.periods.find((p) => p.installment_index === idx) ?? null;
  const rows = (snapshot.length ? snapshot.map((s) => ({ index: s.index, amount: Number(s.amount_base), isDeposit: s.index === 1 }))
    : inst.periods.map((p) => ({ index: p.installment_index, amount: Number(p.amount_base), isDeposit: p.installment_index === 1 })))
    .sort((a, b) => a.index - b.index);
  const n = rows.length;
  const paidCount = rows.filter((r) => live(r.index)?.status === "PAID").length;
  const paidBase = rows.filter((r) => live(r.index)?.status === "PAID").reduce((s, r) => s + r.amount, 0);
  const totalBase = inst.installment_config?.total_base ?? rows.reduce((s, r) => s + r.amount, 0);
  const remainingBase = Math.max(0, totalBase - paidBase);
  const settled = n > 0 && paidCount === n;
  const dueOf = (idx: number) => snapshot.find((s) => s.index === idx)?.due_date ?? live(idx)?.due_date ?? null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <b>分期账单（共 {n} 期）</b>
        <Badge variant={settled ? "default" : inst.status_payment === "INSTALLMENT_ACTIVE" ? "secondary" : "outline"}>
          {settled ? "已结清" : inst.status_payment === "INSTALLMENT_ACTIVE" ? "分期进行中" : "待付首付"}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">已付 {paidCount}/{n} 期</span>
      </div>
      <div className="h-1.5 w-full bg-muted" role="progressbar" aria-valuenow={paidCount} aria-valuemin={0} aria-valuemax={n}>
        <div className="h-full bg-primary" style={{ width: `${n ? Math.round((paidCount / n) * 100) : 0}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>已收 {formatBase(paidBase)}</span>
        <span>待收 {formatBase(remainingBase)}</span>
        {inst.next_due_date && <span>下期到期 {fmtDate(inst.next_due_date)}</span>}
        {inst.overdue_indexes.length > 0 && <span className="text-destructive">逾期 {inst.overdue_indexes.join("、")} 期</span>}
      </div>
      <ul className="flex flex-col divide-y divide-border/70 border-t">
        {rows.map((r) => {
          const st = live(r.index);
          return (
            <li key={r.index} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="w-16 shrink-0">{r.isDeposit ? "首付" : `第 ${r.index} 期`}</span>
              <span className="font-medium">{formatBase(r.amount)}</span>
              {dueOf(r.index) && <span className="text-xs text-muted-foreground">到期 {fmtDate(dueOf(r.index))}</span>}
              <span className="ml-auto text-xs">
                {st?.status === "PAID" ? <b className="text-primary">已付</b>
                  : st?.overdue ? <b className="text-destructive">逾期</b>
                  : <span className="text-muted-foreground">{inst.status_payment === "INSTALLMENT_ACTIVE" || r.isDeposit ? "待付" : "未开始"}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {inst.status_payment === "INSTALLMENT_ACTIVE" && remainingBase > 0 && (
        <p className="text-xs text-muted-foreground">
          逐期人工收款：余额付款即时到账；扫码尾款在「凭证审核」队列按本期金额逐笔确认（首付走「订单付款」分项）。买家亦可一次性提前结清剩余 {formatBase(remainingBase)}（不收手续费，已付各期不退）。
        </p>
      )}
    </div>
  );
}

function Detail({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged: () => void }) {
  const { has } = useAdmin();
  const { currencies } = useSite();
  const [data, setData] = useState<OD2 | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await call<OD2>("admin/order/detail", { token: "admin", query: { order_id: orderId } }));
      setError("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [orderId]);
  useEffect(() => { void load(); }, [load]);

  const { text } = useDeadline(data && data.order.status_order === "PENDING_PAYMENT" ? data.order.payment_deadline : null, data?.order.expired === true);

  if (loading && !data) return <p className="text-sm text-muted-foreground">订单详情加载中…</p>;
  if (!data) return <p className="text-sm text-destructive">{error}</p>;

  const { order, items, payments, status_logs, buyer, installment, allowed_actions: acts } = data;
  const symbol = symbolOf(currencies, order.currency_code);
  const canShip = has("order.ship");
  const canOperate = has("order.operate");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="font-mono">{order.order_no}</span>
          <Badge variant="secondary">{ORDER_STATUS_TEXT[order.status_order] ?? order.status_order}</Badge>
          <Badge variant="outline">{PAY_STATUS_TEXT[order.status_payment] ?? order.status_payment}</Badge>
          <Badge variant="outline">{SHIP_STATUS_TEXT[order.status_shipping] ?? order.status_shipping}</Badge>
          {text && <span className="text-xs font-normal text-destructive">{text}</span>}
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={onClose}>返回列表</Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <p className="font-medium">买家</p>
            <p className="text-muted-foreground">{buyer ? `${buyer.nickname}（${buyer.username}）` : order.user_id}</p>
            <p className="text-muted-foreground">余额（计价基准）{buyer ? formatBase(buyer.balance) : "—"} · 状态 {buyer?.status ?? "—"}</p>
            <p className="text-muted-foreground">下单 {fmtTime(order.created_at)}</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-medium">收货信息</p>
            <p className="text-muted-foreground">{order.address_snapshot ? oneLine(order.address_snapshot) : "—"}</p>
            {order.buyer_remark && <p className="text-muted-foreground">买家备注：{order.buyer_remark}</p>}
            {order.cancel_reason && <p className="text-destructive">取消原因：{order.cancel_reason}</p>}
            {order.extra?.carrier && <p className="text-muted-foreground">物流：{order.extra.carrier} {order.extra.tracking_no}</p>}
          </div>
        </div>

        {order.extra?.installment_profile && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">分期购买留存信息</p>
            {([
              ["姓名", order.extra.installment_profile.name],
              ["手机号", order.extra.installment_profile.phone],
              ["邮箱地址", order.extra.installment_profile.email],
              ["详细住址", order.extra.installment_profile.address],
            ] as const).map(([label, value]) => (
              <p key={label} className="text-muted-foreground">{label}：{value || "—"}</p>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">商品明细</p>
          {items.map((line) => (
            <div key={line.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-1.5">
              <span className="flex-1 truncate">{line.title_snapshot}</span>
              <span className="text-xs text-muted-foreground">{line.spec_snapshot}</span>
              <span className="text-xs">{formatBase(line.price_base_snapshot)} × {line.quantity}</span>
              <span className="font-medium">{formatBase(line.subtotal_base)}</span>
            </div>
          ))}
          <p className="mt-1 text-right">
            应付 <b className="text-primary">{formatBase(order.actual_paid_amount_base)}</b>
            <span className="ml-2 text-xs text-muted-foreground">展示 {money(order.currency_actual_amount, symbol)}（{order.currency_name_snapshot ?? order.currency_code}）</span>
          </p>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">支付分项与凭证</p>
          {!payments.length && <p className="text-muted-foreground">暂无分项</p>}
          {payments.map((p) => {
            // 加密货币分项带出票当刻的币种快照（文档L §2.5）：审核拿它逐位对顾客截图，事后改汇率/小数位都不影响这张单
            const coin = p.coin_symbol ? coinOf(p.coin_units, p.coin_decimals) : null;
            return (
              <div key={p.id} className="flex flex-col gap-1 rounded-lg border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <b>{PAYMENT_TYPE_TEXT[p.payment_type] ?? p.payment_type} · {METHOD_TEXT[p.method] ?? p.method}</b>
                  <Badge variant={p.status === "CONFIRMED" ? "default" : "secondary"}>{PAYMENT_ROW_TEXT[p.status] ?? p.status}</Badge>
                  <span className="ml-auto">{formatBase(p.amount_base)} / {money(p.amount_currency, symbol)}</span>
                </div>
                {coin !== null && p.coin_symbol && (
                  <p className="text-xs text-muted-foreground">
                    客户所选币种 <b className="text-foreground">{p.coin_symbol}{p.coin_network ? ` / ${p.coin_network}` : ""}</b>，
                    应付 <b className="text-foreground">{coin} {p.coin_symbol}</b>
                    <span className="ml-1">（到账需 ≥ 此数；本位币 {formatBase(p.amount_base)} 只作记账口径）</span>
                  </p>
                )}
                {p.reject_reason && <p className="text-xs text-destructive">驳回：{p.reject_reason}</p>}
                {p.proofs.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>流水号 {f.transaction_no ?? "—"}</span>
                    <span>申报 {money(f.amount_declared, symbol)}</span>
                    <span>{f.review_status}</span>
                    {f.image_url && <a href={f.image_url} target="_blank" rel="noreferrer" className="text-primary underline">截图</a>}
                    <span>{fmtTime(f.created_at)}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {installment && <InstallmentBillPanel inst={installment} />}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">可执行操作</p>
          {acts.pay_blocked_reason === "in_review" && <p className="text-xs text-muted-foreground">有凭证正在审核中，先处理审核队列再操作发货。</p>}
          {order.status_order === "PAID" && canShip && <ShipForm orderId={order.id} onDone={() => { void load(); onChanged(); }} />}
          {order.status_order === "PENDING_PAYMENT" && canOperate && <CloseForm orderId={order.id} onDone={() => { void load(); onChanged(); }} />}
          {order.status_order === "SHIPPED" && canOperate && (
            <Button
              size="sm" variant="outline"
              onClick={async () => {
                try { await riskyPost("admin/order/complete", { order_id: order.id }, "代确认收货"); void load(); onChanged(); }
                catch (e) { if (!isConfirmCancel(e)) setError(errText(e)); }
              }}
            >代确认收货</Button>
          )}
          {acts.can_change_address && canShip && <AddressEdit order={order} onDone={load} />}
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">状态轨迹</p>
          <ol className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {status_logs.map((l) => (
              <li key={l.id}>{fmtTime(l.created_at)} · {l.dim} · {l.from_status} → {l.to_status} · {l.operator_type}{l.reason ? ` · ${l.reason}` : ""}</li>
            ))}
            {!status_logs.length && <li>暂无记录</li>}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminOrdersPage() {
  const { has } = useAdmin();
  const { currencies } = useSite();
  const emptyFilters = { status_order: "", status_payment: "", status_shipping: "", keyword: "", date_from: "", date_to: "" };
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [page, setPage] = useState<{ has_more: boolean; next_offset: number | null }>({ has_more: false, next_offset: null });
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError("");
    const keyword = filters.keyword.trim();
    call<Page<ListRow>>("admin/orders", {
      token: "admin",
      query: {
        status_order: filters.status_order || undefined,
        status_payment: filters.status_payment || undefined,
        status_shipping: filters.status_shipping || undefined,
        keyword: /^[A-Za-z0-9]{2,40}$/.test(keyword) ? keyword : undefined,
        date_from: filters.date_from || undefined,
        date_to: filters.date_to ? `${filters.date_to}T23:59:59` : undefined,
        offset,
      },
    })
      .then((r) => {
        if (!alive) return;
        setRows(r.items);
        setPage({ has_more: r.has_more, next_offset: r.next_offset });
      })
      .catch((e: unknown) => { if (alive) { setRows([]); setError(errText(e)); } });
    return () => { alive = false; };
  }, [filters, offset, tick]);

  function apply(patch: Partial<typeof emptyFilters>) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  if (openId && has("order.read")) {
    return (
      <div className="flex flex-col gap-4">
        <PageTitle title="订单详情" desc="OD2 全量快照 + OD3–OD6 高危操作（⚠ 二次确认并写入审计）" />
        <Detail orderId={openId} onClose={() => setOpenId(null)} onChanged={() => setTick((t) => t + 1)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="订单管理" desc="OD1 三维状态筛选 + 单号/日期检索；点击进入详情执行发货、关单、改址" />
      <Toolbar>
        {FILTERS.map(([key, label, options]) => (
          <span key={key} className="flex flex-col gap-1">
            <Label htmlFor={`of-${key}`}>{label}</Label>
            <select
              id={`of-${key}`}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={draft[key as keyof typeof draft]}
              onChange={(e) => { apply({ [key]: e.target.value } as Partial<typeof draft>); setFilters({ ...filters, [key]: e.target.value }); setOffset(0); }}
            >
              <option value="">全部</option>
              {options.map((o) => <option key={o} value={o}>{ORDER_STATUS_TEXT[o] ?? PAY_STATUS_TEXT[o] ?? SHIP_STATUS_TEXT[o] ?? o}</option>)}
            </select>
          </span>
        ))}
        <span className="flex flex-col gap-1">
          <Label htmlFor="of-kw">单号关键词</Label>
          <Input id="of-kw" className="h-9 w-36" value={draft.keyword} onChange={(e) => apply({ keyword: e.target.value })} placeholder="字母数字 2–40" />
        </span>
        <span className="flex flex-col gap-1">
          <Label htmlFor="of-from">下单起</Label>
          <Input id="of-from" type="date" className="h-9 w-36" value={draft.date_from} onChange={(e) => apply({ date_from: e.target.value })} />
        </span>
        <span className="flex flex-col gap-1">
          <Label htmlFor="of-to">下单止</Label>
          <Input id="of-to" type="date" className="h-9 w-36" value={draft.date_to} onChange={(e) => apply({ date_to: e.target.value })} />
        </span>
        <Button variant="outline" onClick={() => { setFilters(draft); setOffset(0); setTick((t) => t + 1); }}>查询</Button>
        <Button variant="ghost" onClick={() => { setDraft(emptyFilters); setFilters(emptyFilters); setOffset(0); }}>清空</Button>
      </Toolbar>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单号</TableHead><TableHead>买家</TableHead><TableHead>件数</TableHead>
              <TableHead>金额</TableHead><TableHead>三维状态</TableHead><TableHead>支付时限</TableHead><TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.order_no}<div className="text-muted-foreground">{fmtTime(r.created_at)}</div></TableCell>
                <TableCell className="text-sm">{r.buyer?.nickname ?? "—"}</TableCell>
                <TableCell className="text-sm">{r.item_count}</TableCell>
                <TableCell className="text-sm">{formatBase(r.actual_paid_amount_base)}<div className="text-xs text-muted-foreground">{money(r.currency_actual_amount, symbolOf(currencies, r.currency_code))}</div></TableCell>
                <TableCell><DimBadges row={r} /></TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmtTime(r.payment_deadline)}</TableCell>
                <TableCell><Button size="sm" variant="ghost" onClick={() => setOpenId(r.id)}>详情</Button></TableCell>
              </TableRow>
            ))}
            {!rows?.length && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{rows ? "没有符合条件的订单" : error || "加载中…"}</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</Button>
        <span className="text-muted-foreground">第 {Math.floor(offset / 20) + 1} 页</span>
        <Button size="sm" variant="outline" disabled={!page.has_more || page.next_offset === null} onClick={() => setOffset(page.next_offset ?? offset + 20)}>下一页</Button>
      </div>
    </div>
  );
}
