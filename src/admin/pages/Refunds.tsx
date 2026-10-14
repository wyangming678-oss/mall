// 后台售后退款 RF1/RF2（文档B §5、文档C R1/R2/RF1/RF2）：审核 + 线下退款结果登记，均为高危操作
import { useCallback, useEffect, useState } from "react";
import { call } from "../../api";
import { formatBase, getBaseCode } from "../../const";
import { useSite } from "../../site";
import { useAdmin } from "../AdminAuth";
import { PageTitle, errText, isConfirmCancel, riskyPost } from "../ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ORDER_STATUS_TEXT, PAY_STATUS_TEXT, REFUND_METHOD_TEXT, REFUND_STATUS_TEXT,
  fmtTime, money, symbolOf, type RefundView,
} from "../../trade";

interface RefundRow extends RefundView {
  order: { id: string; order_no: string; status_order: string; status_payment: string; status_shipping: string } | null;
  buyer: { id: string; username: string; nickname: string } | null;
}
interface QueuePage {
  offset: number; limit: number; has_more: boolean; next_offset: number | null;
  items: RefundRow[]; counts_by_status: Record<string, number>;
}
interface DetailResult {
  refund: RefundView & { image_urls: string[] };
  order: {
    id: string; order_no: string; status_order: string; status_payment: string; status_shipping: string;
    actual_paid_amount_base: number; currency_code: string; currency_rate_scaled: number;
    currency_actual_amount: number; pre_refund_status: string | null;
  } | null;
  items: Array<{
    id: string; product_id: string; sku_id: string; title_snapshot: string; spec_snapshot: string;
    quantity: number; subtotal_base: number; price_base_snapshot: number; consumed_qty: number; refundable_qty: number;
  }>;
  buyer: { id: string; username: string; nickname: string; balance: number } | null;
  status_logs: Array<{ id: string; dim: string; from_status: string; to_status: string; operator_type: string; reason: string | null; created_at: string }>;
  refunded_base: number;
  remaining_refundable_base: number;
  order_refunds: RefundView[];
}
interface ActionResult {
  refund_id: string;
  status?: string;
  completed?: boolean;
  fully?: boolean;
  amount_base?: number;
  remaining_refundable_base?: number;
  pending_offline?: boolean;
  already_marked?: boolean;
  amount_base_offline?: number;
  credit?: { touched: boolean; amount_base: number };
  stock?: { skipped: boolean; restored: unknown[]; failures: unknown[] };
}

const TABS: Array<[string, string]> = [
  ["", "全部"],
  ["PENDING", REFUND_STATUS_TEXT.PENDING],
  ["PROCESSING", REFUND_STATUS_TEXT.PROCESSING],
  ["COMPLETED", REFUND_STATUS_TEXT.COMPLETED],
  ["REJECTED", REFUND_STATUS_TEXT.REJECTED],
];

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  PENDING: "secondary", APPROVED: "secondary", PROCESSING: "secondary", COMPLETED: "default", REJECTED: "destructive",
};

function RefundBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{REFUND_STATUS_TEXT[status] ?? status}</Badge>;
}

/** 结果话术：COMPLETED 才是终结，PROCESSING + 待线下表示余额已冲正、等 RF2；一单一退，部分退款后本单不再开放第二笔 */
function resultText(status: string | undefined, r: ActionResult): string {
  if (r.already_marked) return "线下退款结果此前已登记，无需重复操作";
  if (r.pending_offline) {
    return `余额来源部分已退回（${formatBase(r.credit?.amount_base ?? 0)} 基准），扫码来源 ${formatBase(Number(r.amount_base_offline ?? 0))} 需线下退回后在「登记线下退款」中确认`;
  }
  if (status === "COMPLETED" || r.completed) {
    return r.fully
      ? "退款已完成（整单退完）：余额已冲正、库存已回库、订单转「已退款」"
      : `部分退款已到账：余额已冲正、所选明细行已回库，订单回到「已付款」。一单一退，本单剩余 ${formatBase(Number(r.remaining_refundable_base ?? 0))} 基准不再开放退款`;
  }
  if (status === "PROCESSING") return "已过审并进入退款处理中";
  return "退款单状态已更新";
}

function ReviewForm({ refund, onDone }: { refund: RefundView; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function decide(decision: "approve" | "reject") {
    if (reason.trim().length < 2) {
      setError("审核意见至少 2 个字（通过与驳回都必填）");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = decision === "approve"
        ? { refund_id: refund.id, decision, reason: reason.trim() }
        : { refund_id: refund.id, decision, reject_reason: reason.trim() };
      const r = await riskyPost<ActionResult>("admin/refund/review", body, decision === "approve" ? "同意退款" : "驳回退款");
      onDone(decision === "reject"
        ? "已驳回：未退余额、未动库存、未恢复优惠券，订单已回到申请前状态"
        : resultText(r.status, r));
    } catch (e) {
      if (!isConfirmCancel(e)) setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-3">
      <span className="flex flex-col gap-1">
        <Label htmlFor="rf-reason">审核意见（≥2 字，写入审计）</Label>
        <Input id="rf-reason" className="h-8 w-64" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </span>
      <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>同意退款</Button>
      <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => void decide("reject")}>驳回</Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function OfflineForm({ refund, symbol, onDone }: { refund: RefundView; symbol: string; onDone: (msg: string) => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <span className="flex flex-col gap-1">
        <Label htmlFor="rf-offline">
          线下退款备注（扫码来源 {money(refund.refund_split.offline_qr, symbol)} 已原路退回）
        </Label>
        <Input id="rf-offline" className="h-8 w-64" value={note} onChange={(e) => setNote(e.target.value)} placeholder="转账流水号 / 收款账户" maxLength={200} />
      </span>
      <Button
        size="sm" disabled={busy || note.trim().length < 2}
        onClick={async () => {
          setBusy(true); setError("");
          try {
            const r = await riskyPost<ActionResult>("admin/refund/offline-done", { refund_id: refund.id, note: note.trim() }, "登记线下退款");
            onDone(resultText(r.status, r));
          } catch (e) {
            if (!isConfirmCancel(e)) setError(errText(e));
          } finally { setBusy(false); }
        }}
      >登记线下退款</Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function Detail({ refundId, onBack, onChanged }: { refundId: string; onBack: () => void; onChanged: () => void }) {
  const { currencies } = useSite();
  const [data, setData] = useState<DetailResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await call<DetailResult>("admin/refund/detail", { token: "admin", query: { refund_id: refundId } }));
      setError("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [refundId]);
  useEffect(() => { void load(); }, [load]);

  if (loading && !data) return <p className="text-sm text-muted-foreground">退款单详情加载中…</p>;
  if (!data?.refund) return <p className="text-sm text-destructive">{error || "退款单不存在"}</p>;

  const { refund, order, items, buyer, status_logs: logs, refunded_base, remaining_refundable_base, order_refunds } = data;
  const symbol = symbolOf(currencies, refund.currency_code ?? getBaseCode());
  const split = refund.refund_split;
  const reviewable = ["PENDING", "APPROVED"].includes(refund.status);
  const needsOffline = split.offline_qr > 0 && !split.offline_done_at && refund.status === "PROCESSING";
  // 本笔退款覆盖的明细行数量（lines=null 表示整单一次退）
  const lineQty = new Map((refund.lines ?? []).map((l) => [l.item_id, l.quantity]));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="font-mono">{order?.order_no ?? refund.order_id}</span>
          <RefundBadge status={refund.status} />
          {order && <Badge variant="outline">{ORDER_STATUS_TEXT[order.status_order] ?? order.status_order}</Badge>}
          {order && <Badge variant="outline">{PAY_STATUS_TEXT[order.status_payment] ?? order.status_payment}</Badge>}
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={onBack}>返回列表</Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {notice && <p className="text-sm text-primary">{notice}</p>}

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <p className="font-medium">退款金额与来源</p>
            <p><b className="text-primary">{formatBase(refund.amount_base)}</b><span className="ml-2 text-xs text-muted-foreground">展示 {refund.amount_currency === null ? "—" : money(refund.amount_currency, symbol)}（{refund.currency_code ?? "—"}）· 计价基准 {formatBase(refund.amount_base)}</span></p>
            <p className="text-muted-foreground">退款方式：{REFUND_METHOD_TEXT[refund.refund_method] ?? refund.refund_method}</p>
            <p className="text-muted-foreground">余额来源 {formatBase(split.balance)} · 扫码来源 {formatBase(split.offline_qr)}</p>
            <p className="text-muted-foreground">本单累计已退 {formatBase(refunded_base)} · 未退 {formatBase(remaining_refundable_base)} 基准（实付 {order ? formatBase(order.actual_paid_amount_base) : "—"}）· 一单一退，本单已有退款记录后不再开放第二笔</p>
            {split.offline_qr > 0 && (
              <p className={split.offline_done_at ? "text-muted-foreground" : "text-destructive"}>
                线下退款：{split.offline_done_at ? `已于 ${fmtTime(split.offline_done_at)} 登记（${split.offline_note ?? "—"}）` : "尚未登记线下退款结果"}
              </p>
            )}
            {refund.wallet_txn_id && <p className="text-xs text-muted-foreground">冲正流水 {refund.wallet_txn_id}</p>}
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-medium">买家与申请信息</p>
            <p className="text-muted-foreground">{buyer ? `${buyer.nickname}（${buyer.username}）` : refund.user_id}</p>
            <p className="text-muted-foreground">当前余额（计价基准）{buyer ? formatBase(buyer.balance) : "—"}</p>
            <p className="text-muted-foreground">申请原因：{refund.apply_reason}</p>
            <p className="text-muted-foreground">提交于 {fmtTime(refund.created_at)} · 更新 {fmtTime(refund.updated_at)}</p>
            {refund.reject_reason && <p className="text-destructive">驳回原因：{refund.reject_reason}</p>}
            {order?.pre_refund_status && <p className="text-muted-foreground">申请前订单状态：{ORDER_STATUS_TEXT[order.pre_refund_status] ?? order.pre_refund_status}</p>}
          </div>
        </div>

        {!!items.length && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">商品明细（未发货部分退款后按行回库）</p>
            {items.map((line) => {
              const sel = refund.lines === null ? line.quantity : (lineQty.get(line.id) ?? 0);
              return (
                <div key={line.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-1.5">
                  <span className="flex-1 truncate">{line.title_snapshot}</span>
                  <span className="text-xs text-muted-foreground">{line.spec_snapshot} · 单价 {formatBase(line.price_base_snapshot)}</span>
                  <span className="text-xs">共 {line.quantity} · 已退 {line.consumed_qty} · 可退 {line.refundable_qty}</span>
                  {sel > 0 && <Badge variant="secondary" className="text-xs">本笔 × {sel}</Badge>}
                  <span className="font-medium">{formatBase(line.subtotal_base)}</span>
                </div>
              );
            })}
          </div>
        )}

        {order_refunds.length > 1 && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">同订单退款历史（{order_refunds.length} 笔）</p>
            {order_refunds.map((rf) => (
              <div key={rf.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 px-3 py-1.5 text-xs">
                <RefundBadge status={rf.status} />
                <span className="font-medium">{formatBase(rf.amount_base)}</span>
                <span className="text-muted-foreground">{rf.lines ? `按行 ${rf.lines.reduce((s, l) => s + l.quantity, 0)} 件` : "整单"}</span>
                <span className="text-muted-foreground">{fmtTime(rf.created_at)}</span>
                {rf.id === refund.id && <span className="text-primary">← 当前查看</span>}
                {rf.reject_reason && <span className="text-destructive">{rf.reject_reason}</span>}
              </div>
            ))}
          </div>
        )}

        {(refund.image_count > 0 || !!refund.image_urls?.length) && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">买家凭证截图（{refund.image_count} 张）</p>
            <div className="flex flex-wrap gap-2">
              {(refund.image_urls ?? []).map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="block size-28 overflow-hidden rounded-lg border bg-muted">
                  <img src={u} alt="退款凭证" className="size-full object-cover" />
                </a>
              ))}
              {!refund.image_urls?.length && <span className="text-xs text-muted-foreground">签名 URL 暂不可用（本地预览不含存储）</span>}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">可执行操作</p>
          {reviewable && <ReviewForm refund={refund} onDone={(msg) => { setNotice(msg); onChanged(); void load(); }} />}
          {needsOffline && <OfflineForm refund={refund} symbol={symbol} onDone={(msg) => { setNotice(msg); onChanged(); void load(); }} />}
          {!reviewable && !needsOffline && (
            <p className="text-sm text-muted-foreground">
              {refund.status === "COMPLETED"
                ? "退款已完成，单据终结，不可再次审核。"
                : refund.status === "REJECTED"
                  ? "已驳回，单据终结；买家如需退款要重新下单。"
                  : "该单已提交，请等待处理。"}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">状态轨迹</p>
          <ol className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {logs.map((l) => (
              <li key={l.id}>{fmtTime(l.created_at)} · {l.dim} · {l.from_status} → {l.to_status} · {l.operator_type}{l.reason ? ` · ${l.reason}` : ""}</li>
            ))}
            {!logs.length && <li>暂无记录</li>}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

/** #279：客服受理退款会话后，由后台代客发起退款单（PENDING），仍走既有「审核」同意/驳回。
 *  未填明细＝退全部可退余额（复用整单引擎，库存与金额口径与买家自助整单退一致）。 */
function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [orderRef, setOrderRef] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const ref = orderRef.trim();
    if (ref.length < 3) { setError("请填写订单号或订单ID"); return; }
    if (reason.trim().length < 2) { setError("请填写退款原因（≥2 字，写入审计）"); return; }
    setBusy(true); setError("");
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
      const body = isUuid ? { order_id: ref, apply_reason: reason.trim() } : { order_no: ref, apply_reason: reason.trim() };
      await riskyPost("admin/refund/create", body, "为订单发起退款（生成待审退款单，退全部可退余额）");
      setOrderRef(""); setReason(""); setOpen(false);
      onCreated();
    } catch (e) {
      if (!isConfirmCancel(e)) setError(errText(e));
    } finally { setBusy(false); }
  }

  if (!open) {
    return <Button size="sm" onClick={() => setOpen(true)}>为订单发起退款</Button>;
  }
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-3">
      <span className="flex flex-col gap-1">
        <Label htmlFor="rf-create-order">订单号 / 订单ID</Label>
        <Input id="rf-create-order" className="h-8 w-64" value={orderRef} onChange={(e) => setOrderRef(e.target.value)} placeholder="客服会话里买家报的订单号" maxLength={64} />
      </span>
      <span className="flex flex-col gap-1">
        <Label htmlFor="rf-create-reason">退款原因（≥2 字，写入审计）</Label>
        <Input id="rf-create-reason" className="h-8 w-64" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </span>
      <Button size="sm" disabled={busy} onClick={() => void submit()}>发起退款单</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>取消</Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <span className="w-full text-xs text-muted-foreground">生成「待审核」退款单（退全部可退余额），随后在列表中点「审核」同意即执行退款。</span>
    </div>
  );
}

export default function AdminRefundsPage() {
  const { has } = useAdmin();
  const { currencies } = useSite();
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<RefundRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ has_more: boolean; next_offset: number | null }>({ has_more: false, next_offset: null });
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError("");
    call<QueuePage>("admin/refunds", { token: "admin", query: { status: status || undefined, offset } })
      .then((r) => {
        if (!alive) return;
        setRows(r.items);
        setCounts(r.counts_by_status ?? {});
        setPage({ has_more: r.has_more, next_offset: r.next_offset });
      })
      .catch((e: unknown) => { if (alive) { setRows([]); setError(errText(e)); } });
    return () => { alive = false; };
  }, [status, offset, tick]);

  if (!has("refund.review")) {
    return <p className="text-sm text-muted-foreground">当前账号缺少售后审核权限（refund.review）。</p>;
  }

  if (openId) {
    return (
      <div className="flex flex-col gap-4">
        <PageTitle title="退款单详情" desc="RF1 同意 / 驳回（⚠ 二次确认并写入审计）· RF2 登记线下退款结果" />
        <Detail refundId={openId} onBack={() => setOpenId(null)} onChanged={() => setTick((t) => t + 1)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="售后退款" desc="一单可多笔部分退款（累计不超实付）；同时至多一笔在途；驳回零资源触碰并释放占用；完成四步（余额→按行回库→券不恢复→终态或回已付款）各自幂等" />

      <CreateForm onCreated={() => { setStatus(""); setOffset(0); setTick((t) => t + 1); }} />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(([key, label]) => (
          <Button
            key={key || "all"} size="sm" variant={status === key ? "default" : "outline"}
            onClick={() => { setStatus(key); setOffset(0); }}
          >
            {label}{key && counts[key] ? ` · ${counts[key]}` : ""}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)}>刷新</Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单号</TableHead><TableHead>买家</TableHead><TableHead>退款金额</TableHead>
              <TableHead>来源拆分</TableHead><TableHead>方式</TableHead><TableHead>状态</TableHead>
              <TableHead>申请原因</TableHead><TableHead>提交时间</TableHead><TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((r) => {
              const symbol = symbolOf(currencies, r.currency_code ?? getBaseCode());
              return (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.order?.order_no ?? "—"}
                    <div className="text-muted-foreground">{r.order ? (ORDER_STATUS_TEXT[r.order.status_order] ?? r.order.status_order) : ""}</div>
                  </TableCell>
                  <TableCell className="text-sm">{r.buyer?.nickname ?? "—"}</TableCell>
                  <TableCell className="text-sm">{formatBase(r.amount_base)}
                    <div className="text-xs text-muted-foreground">{r.amount_currency === null ? "—" : money(r.amount_currency, symbol)}</div>
                    <div className="text-xs text-muted-foreground">{r.lines ? `按行 ${r.lines.reduce((s, l) => s + l.quantity, 0)} 件` : "整单"}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    余额 {formatBase(r.refund_split.balance)} / 扫码 {formatBase(r.refund_split.offline_qr)}
                    {r.refund_split.offline_qr > 0 && (
                      <div className={r.refund_split.offline_done_at ? "text-muted-foreground" : "text-destructive"}>
                        {r.refund_split.offline_done_at ? "线下已登记" : "线下待登记"}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{REFUND_METHOD_TEXT[r.refund_method] ?? r.refund_method}</TableCell>
                  <TableCell><RefundBadge status={r.status} /></TableCell>
                  <TableCell className="max-w-40 truncate text-xs" title={r.apply_reason}>{r.apply_reason}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtTime(r.created_at)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setOpenId(r.id)}>
                      {["PENDING", "APPROVED"].includes(r.status) || (r.status === "PROCESSING" && r.refund_split.offline_qr > 0 && !r.refund_split.offline_done_at) ? "审核" : "详情"}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows?.length && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">{rows ? "没有退款申请" : error || "加载中…"}</TableCell>
              </TableRow>
            )}
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
