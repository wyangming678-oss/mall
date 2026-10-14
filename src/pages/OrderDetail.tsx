// 订单详情 O3 + 支付动作 Y1/Y2/Y3/Y4 + 取消 O4 / 确认收货 O5 + 退款申请 R1/R2
import { useCallback, useEffect, useState } from "react";
import { call, newIdem } from "../api";
import { Link, navigate, RedirectTo, useQuery } from "../router";
import { useSite } from "../site";
import { baseUnit, formatBase, getBaseSymbol, pickLocalized } from "../const";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { ProductCover } from "../components/ProductCard";
import { oneLine } from "../components/AddressFields";
import { ProofUploadForm, QrTicketCard, type QrTicket } from "../components/PayFlow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DISPLAY_TEXT, ORDER_STATUS_TEXT, PAYMENT_ROW_TEXT, REFUND_METHOD_TEXT, REFUND_STATUS_TEXT, assignedBase, couponRuleText,
  fmtDate, fmtTime, channelLabel, isQrPayment, lazyTick, manualChannels, methodLabel, money, rateText, shopErr, symbolOf, useDeadline, yuanToCents,
  INVOICE_STATUS_TEXT, INVOICE_TYPE_TEXT,
  type AllowedActions, type InvoiceStatusResult, type OrderLine, type OrderRow, type PaymentRow, type RefundStatusResult,
} from "../trade";
import type { InstallmentBill } from "../installments";

interface O3Result {
  order: OrderRow & { status_display: string; expired: boolean };
  items: OrderLine[];
  payments: PaymentRow[];
  allowed_actions: AllowedActions;
  lazy_cancel?: { cancelled: boolean; released: boolean };
}

function PaymentList({ payments }: { payments: PaymentRow[] }) {
  const { currencies, config, t } = useSite();
  if (!payments.length) return <p className="text-sm text-muted-foreground">{t("order.no_payments", "尚无支付分项")}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {payments.map((p) => (
        <li key={p.id} className="flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <b>{methodLabel(config?.pay_channels, p.method, t)}</b>
            <Badge variant={p.status === "CONFIRMED" ? "default" : p.status === "REJECTED" || p.status === "EXPIRED" ? "outline" : "secondary"}>
              {(() => { const v = PAYMENT_ROW_TEXT[p.status]; return v === undefined ? p.status : t("status.pay_row." + p.status, v); })()}
            </Badge>
            <span className="ml-auto font-medium">{money(p.amount_currency, symbolOf(currencies, p.currency_code))}</span>
          </div>
          {p.reject_reason && <p className="text-xs text-destructive">{t("order.reject_reason", "驳回原因：")}{p.reject_reason}</p>}
          {p.proofs.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground">
              <span>{t("order.serial", "流水号")} {f.transaction_no ?? "—"}</span>
              <span>{t("order.declared", "申报")} {money(f.amount_declared, symbolOf(currencies, p.currency_code))}</span>
              <span>{f.review_status === "approved" ? t("order.proof_approved", "凭证已通过") : f.review_status === "rejected" ? t("order.proof_rejected", "凭证被驳回") : t("order.proof_reviewing", "凭证在审")}</span>
              {f.image_url && <a href={f.image_url} target="_blank" rel="noreferrer" className="text-primary underline">{t("order.view_screenshot", "查看截图")}</a>}
              <span className="ml-auto">{f.created_at.slice(0, 16).replace("T", " ")}</span>
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

function OrderTimeline({ order, payments }: {
  order: OrderRow & { status_display: string; expired: boolean };
  payments: PaymentRow[];
}) {
  const { t } = useSite();
  const paidAt = payments
    .filter((p) => p.status === "CONFIRMED")
    .map((p) => p.reviewed_at ?? p.created_at)
    .sort()
    .pop() ?? null;
  const shipped = !!order.shipped_at || order.status_shipping !== "NOT_SHIPPED";
  const done = order.status_order === "COMPLETED";
  const cancelled = order.status_order === "CANCELLED" || order.status_order === "REFUNDED";
  const carrier = order.extra?.carrier;
  const trackingNo = order.extra?.tracking_no;

  const nodes = cancelled
    ? [
      { label: t("order.timeline_submit", "提交订单"), at: order.created_at, reached: true },
      { label: paidAt ? t("order.timeline_paid_close", "已付款后关闭") : t("order.timeline_closed", "订单已关闭"), at: order.cancelled_at ?? order.updated_at, reached: true, terminal: true },
    ]
    : [
      { label: t("order.timeline_submit", "提交订单"), at: order.created_at, reached: true },
      { label: t("order.timeline_pay", "完成付款"), at: paidAt, reached: !!paidAt },
      { label: t("order.timeline_ship", "商家发货"), at: order.shipped_at, reached: shipped, note: shipped && carrier ? `${carrier} ${trackingNo ?? ""}`.trim() : null },
      { label: t("order.timeline_done", "交易完成"), at: done ? order.updated_at : null, reached: done },
    ];

  return (
    <ol className="flex flex-col">
      {nodes.map((n, i) => (
        <li key={n.label} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className={"mt-1 size-2.5 shrink-0 rounded-full " + (n.reached ? "bg-primary" : "border border-muted-foreground/50 bg-transparent")} aria-hidden />
            {i < nodes.length - 1 && <span className={"my-0.5 w-px flex-1 " + (n.reached ? "bg-primary/50" : "bg-border")} />}
          </div>
          <div className="flex-1 pb-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className={"text-sm " + (n.reached ? "font-medium" : "text-muted-foreground")}>{n.label}</span>
              {n.at && <time className="text-xs text-muted-foreground">{fmtTime(n.at)}</time>}
            </div>
            {"note" in n && n.note && <p className="mt-0.5 font-mono text-xs text-muted-foreground">{n.note}</p>}
            {!n.reached && !cancelled && <p className="mt-0.5 text-xs text-muted-foreground">{t("common.pending", "待处理")}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function OrderDetailPage() {
  const query = useQuery();
  const { user, currencies, config, ready, t, tf, lang, refresh: refreshSite } = useSite();
  const id = query.id ?? "";
  const [detail, setDetail] = useState<O3Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  const [partYuan, setPartYuan] = useState("");
  const [payPin, setPayPin] = useState("");
  const [qrMethod, setQrMethod] = useState("");
  const [ticket, setTicket] = useState<QrTicket | null>(null);
  const [coinIdx, setCoinIdx] = useState(0);
  const [cancelReason, setCancelReason] = useState("");
  const [refv, setRefv] = useState<RefundStatusResult | null>(null);
  const [bill, setBill] = useState<InstallmentBill | null>(null);
  // —— A9 发票申请 ——
  const [invc, setInvc] = useState<InvoiceStatusResult | null>(null);
  const [invApplying, setInvApplying] = useState(false);
  const [invType, setInvType] = useState<"personal" | "enterprise">("personal");
  const [invTitle, setInvTitle] = useState("");
  const [invTax, setInvTax] = useState("");
  const [invEmail, setInvEmail] = useState("");
  const [invRemark, setInvRemark] = useState("");
  const order = detail?.order ?? null;

  const load = useCallback(async () => {
    if (!id) { setError(t("order.missing_id", "缺少订单编号")); setLoading(false); return; }
    setLoading(true);
    try {
      const d = await call<O3Result>("order/detail", { token: "user", query: { id } });
      setDetail(d);
      setError("");
      // 分期账单是附属面板：仅分期单（≥2 期）拉取，失败不影响订单主体展示
      setBill(Number(d.order.installment_count ?? 0) >= 2
        ? await call<InstallmentBill>("installment/bill", { token: "user", query: { order_id: id } }).catch(() => null)
        : null);
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setLoading(false);
    }
    // 退款进度是附属面板：单独取，失败不影响订单主体展示
    setRefv(await call<RefundStatusResult>("refund/status", { token: "user", query: { order_id: id } }).catch(() => null));
    // 发票状态同样是附属面板
    setInvc(await call<InvoiceStatusResult>("invoice/status", { token: "user", query: { order_id: id } }).catch(() => null));
  }, [id]);

  const { text: deadlineText, left } = useDeadline(order?.payment_deadline ?? null, order?.expired === true);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void lazyTick("user"); }, []);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("order.loading", "正在加载订单…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;
  if (loading && !detail) return <div className="grid place-items-center py-16"><CartLoading label={t("order.loading", "正在加载订单…")} /></div>;
  if (!detail || !order) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        <SubHeader title={t("order.detail_title", "订单详情")} back="/orders" />
        <div className="grid place-items-center gap-3 py-12 text-center">
          <p className="text-sm text-destructive">{error || t("order.not_found", "订单不存在")}</p>
          <Link to="/orders" className="rounded-md brand-gradient px-5 py-1.5 text-sm font-medium text-white">{t("order.my_orders", "我的订单")}</Link>
        </div>
      </div>
    );
  }

  const { items, payments, allowed_actions: acts } = detail;
  const symbol = symbolOf(currencies, order.currency_code);
  const isInstallment = Number(order.installment_count ?? 0) >= 2;
  const remaining = Number(order.actual_paid_amount_base) - assignedBase(payments);
  const channels = manualChannels(config?.pay_channels);
  // 选中项失效（未选/渠道被删）时回落到首个可用渠道，select 与提交都用这个生效值
  const chosenQr = channels.some((c) => c.method === qrMethod) ? qrMethod : (channels[0]?.method ?? "");

  // 分期面板以不可变下单快照 installment_config 为主干（首付未付时 order_installments 账单行尚未生成），
  // 再用只读端点 installment/bill 的实时期次状态（PAID / 逾期）叠加。
  const cfg = order.installment_config ?? null;
  const schedule = cfg?.periods ?? [];
  const livePeriod = (idx: number) => bill?.periods.find((p) => p.installment_index === idx) ?? null;
  const periodPaid = (idx: number) => livePeriod(idx)?.status === "PAID";
  const instTotal = cfg?.total_base ?? schedule.reduce((s, p) => s + Number(p.amount_base), 0);
  const instPaidBase = schedule.filter((p) => periodPaid(p.index)).reduce((s, p) => s + Number(p.amount_base), 0);
  const instRemaining = Math.max(0, instTotal - instPaidBase);
  const instPaidCount = schedule.filter((p) => periodPaid(p.index)).length;
  const instOverdueCount = schedule.filter((p => { const bp = livePeriod(p.index); return bp?.overdue && p.index !== 1; })).length;
  const instSettled = schedule.length > 0 && instPaidCount === schedule.length;

  async function post(path: string, body: Record<string, unknown>, label: string) {
    setBusy(label);
    setActionError("");
    try {
      const r = await call<Record<string, unknown>>(path, { method: "POST", token: "user", idem: newIdem(), body });
      // 出票响应（pay/qrcode 与 installment 扫码两支同形：channel + transfer_reference）都落成票据
      if (r && typeof r === "object" && "channel" in r && "transfer_reference" in r) setTicket(r as unknown as QrTicket);
      await Promise.all([load(), refreshSite()]);
      return r;
    } catch (e) {
      setActionError(shopErr(e));
      return null;
    } finally {
      setBusy("");
    }
  }

  // 余额支付（Y1/Y2）：买家自行设置过支付密码就必须随请求带上（口径同 functions/payments.mjs assertPaymentPassword）；
  // 未设置则不拦，也不传该字段。
  function withPayPin(body: Record<string, unknown>): Record<string, unknown> | null {
    if (!user?.has_payment_password) return body;
    if (!/^\d{6,20}$/.test(payPin)) {
      setActionError(t("order.pay_pw_need", "请输入支付密码（6–20 位数字）"));
      return null;
    }
    return { ...body, payment_password: payPin };
  }

  // —— R1 退款申请（#279）：不再自助提交，改为跳转客服中心并带上订单，由人工客服受理、后台审批 ——
  function gotoRefundCs() {
    if (!order) return;
    navigate(`/me/support?refund=${order.id}`);
  }

  // —— IN3 发票申请：抬头/税号/邮箱，金额与币种由后端按订单实付快照核定 ——
  async function submitInvoice() {
    if (!order) return;
    if (invTitle.trim().length < 2) { setActionError(t("order.invoice_need_title", "请填写发票抬头（至少 2 个字）")); return; }
    if (invType === "enterprise" && invTax.trim().length < 4) { setActionError(t("order.invoice_need_tax", "企业抬头需填写纳税人识别号（至少 4 位）")); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invEmail.trim())) { setActionError(t("order.invoice_need_email", "请填写正确的接收邮箱")); return; }
    setBusy("apply_invoice");
    setActionError("");
    try {
      await call("invoice/apply", {
        method: "POST", token: "user", idem: newIdem(),
        body: {
          order_id: order.id, invoice_type: invType, title: invTitle.trim(),
          tax_no: invType === "enterprise" ? invTax.trim() : undefined,
          email: invEmail.trim(), remark: invRemark.trim() || undefined,
        },
      });
      setInvApplying(false);
      setInvTitle(""); setInvTax(""); setInvRemark("");
      await load();
    } catch (e) {
      setActionError(shopErr(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      {/* 左上角 ← 回到订单列表 */}
      <SubHeader title={t("order.detail_title", "订单详情")} back="/orders" />
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-4">
        <Badge variant={order.status_display === "completed" ? "outline" : order.status_display === "pending_review" ? "secondary" : "default"}>
          {(() => { const d = DISPLAY_TEXT[order.status_display]; if (d !== undefined) return t("status.disp." + order.status_display, d); const o = ORDER_STATUS_TEXT[order.status_order]; return o !== undefined ? t("status.order." + order.status_order, o) : t("nav.orders", "订单"); })()}
        </Badge>
        <span className="font-mono text-sm">{order.order_no}</span>
        <span className="text-xs text-muted-foreground">{fmtTime(order.created_at)}</span>
        {left && <span className="ml-auto text-sm font-medium text-destructive">{deadlineText}</span>}
      </div>

      {query.created === "1" && (
        <p className="rounded-xl border bg-accent px-4 py-2 text-sm text-accent-foreground">{t("order.created_note", "订单已创建，请在支付时限内完成付款，逾期系统将自动取消并释放库存。")}</p>
      )}
      {detail.lazy_cancel?.cancelled && (
        <p className="rounded-xl border bg-card px-4 py-2 text-sm text-muted-foreground">{t("order.auto_cancel_note", "该订单已超过支付时限，本次访问已自动取消并释放库存。")}</p>
      )}
      {order.status_display === "pending_review" && (
        <p className="rounded-xl border bg-card px-4 py-2 text-sm text-muted-foreground">{t("order.review_note", "转账凭证正在后台审核，审核期间不可重复支付，也不计入超时。")}</p>
      )}

      <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
        <p className="text-sm font-medium">{t("order.receiver_title", "收货信息")}</p>
        <p className="text-sm text-muted-foreground">{oneLine(order.address_snapshot)}</p>
        {order.buyer_remark && <p className="text-sm text-muted-foreground">{t("order.remark_prefix", "备注：")}{order.buyer_remark}</p>}
        {order.cancel_reason && <p className="text-sm text-destructive">{t("order.cancel_reason_prefix", "取消原因：")}{order.cancel_reason}</p>}
        {order.extra?.carrier && (
          <p className="text-sm text-muted-foreground">{t("order.logistics_prefix", "物流：")}{order.extra.carrier} {order.extra.tracking_no}</p>
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
        <p className="text-sm font-medium">{t("order.progress_title", "订单进度")}</p>
        <OrderTimeline order={order} payments={payments} />
      </section>

      <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
        <p className="text-sm font-medium">{t("order.items_title", "商品明细")}</p>
        <ul className="flex flex-col gap-2">
          {items.map((line) => (
            <li key={line.id} className="flex items-center gap-3 text-sm">
              <span className="size-14 shrink-0 overflow-hidden rounded-lg border bg-muted">
                <ProductCover imageKey={line.image_snapshot?.[0]} alt={line.title_snapshot} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <Link to={`/product?id=${line.product_id}`} className="truncate hover:text-primary">{line.title_snapshot}</Link>
                <span className="text-xs text-muted-foreground">{line.spec_snapshot} · {formatBase(line.price_base_snapshot)} × {line.quantity}</span>
              </span>
              <span className="font-medium">{money(line.currency_price_snapshot, symbol)}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-1 border-t pt-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">{t("order.goods_amount", "商品金额")}</span><span>{money(order.goods_amount_base, symbol)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">{t("order.discount_freight", "优惠 / 运费")}</span><span>{money(order.discount_amount_base, symbol)} / {money(order.freight_amount_base, symbol)}</span></div>
          {!!order.pricing_snapshot?.vip && (
            <div className="flex justify-between text-xs text-primary">
              <span>{tf("order.vip_discount", { rate: rateText(order.pricing_snapshot.vip.discount_rate), date: fmtDate(order.pricing_snapshot.vip.expire_at) }, "会员折扣（{rate}，至 {date}）")}</span>
              <span>−{formatBase(order.pricing_snapshot.vip_discount_amount_base ?? 0)}</span>
            </div>
          )}
          {order.pricing_snapshot?.vip_skipped === "no_stack" && (
            <div className="text-xs text-muted-foreground">{t("order.vip_skipped", "本单用了优惠券，会员折扣按后台设置不叠加。")}</div>
          )}
          {!!order.pricing_snapshot?.coupon && (
            <div className="flex justify-between text-xs text-primary">
              <span>{tf("order.coupon_used", { name: pickLocalized(order.pricing_snapshot.coupon.name_i18n, order.pricing_snapshot.coupon.name, lang) }, "已用优惠券「{name}」")}</span>
              <span>{couponRuleText(order.pricing_snapshot.coupon)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold"><span>{t("order.payable", "应付")}</span><span className="text-primary">{money(order.currency_actual_amount, symbol)}</span></div>
          <div className="text-xs text-muted-foreground">{tf("order.basis_snapshot", { amt: formatBase(order.actual_paid_amount_base), name: order.currency_name_snapshot ?? "" }, "计价基准 {amt} · 币种快照 {name}")}</div>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
        <p className="text-sm font-medium">{t("order.payments_title", "支付分项与凭证")}</p>
        <PaymentList payments={payments} />
      </section>

      {isInstallment && schedule.length > 0 && (
        <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{tf("installment.order_title", { n: schedule.length }, "分期账单（共 {n} 期）")}</p>
            <Badge variant={instSettled ? "default" : order.status_payment === "INSTALLMENT_ACTIVE" ? "secondary" : "outline"}>
              {instSettled ? t("installment.settled", "已结清")
                : order.status_payment === "INSTALLMENT_ACTIVE" ? t("installment.active_badge", "分期进行中")
                : t("installment.awaiting_deposit", "待付首付")}
            </Badge>
            <span className="ml-auto text-xs text-muted-foreground">{tf("installment.progress", { paid: instPaidCount, n: schedule.length }, "已付 {paid}/{n} 期")}</span>
          </div>

          <div className="h-1.5 w-full bg-muted" role="progressbar" aria-valuenow={instPaidCount} aria-valuemin={0} aria-valuemax={schedule.length}>
            <div className="h-full bg-primary" style={{ width: `${Math.round((instPaidCount / schedule.length) * 100)}%` }} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{tf("installment.paid_of", { paid: formatBase(instPaidBase), total: formatBase(instTotal) }, "已付 {paid} / 共 {total}")}</span>
            {!instSettled && <span>{tf("installment.remaining", { amt: formatBase(instRemaining) }, "待付 {amt}")}</span>}
          </div>
          {instOverdueCount > 0 && <p className="text-xs text-destructive">{tf("installment.overdue_n", { n: instOverdueCount }, "逾期 {n} 期")}</p>}

          {ticket && <QrTicketCard ticket={ticket} coinIdx={coinIdx} onCoinIdx={setCoinIdx} />}

          {/* 在途扫码分期分项：待上传或被驳回需补传凭证 */}
          {payments
            .filter((p) => ["PENDING_SUBMIT", "REJECTED"].includes(p.status) && isQrPayment(config?.pay_channels, p.method))
            .map((p) => <ProofUploadForm key={p.id} payment={p} chainIndex={coinIdx} onDone={() => { setTicket(null); void load(); }} />)}

          {user.has_payment_password && (
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-sm text-muted-foreground" htmlFor="inst-pay-pin">{t("order.pay_pw_label", "支付密码")}</Label>
              <Input id="inst-pay-pin" className="h-8 w-40" type="password" inputMode="numeric" autoComplete="off" maxLength={20}
                placeholder={t("order.pay_pw_ph", "6–20 位数字")} value={payPin} onChange={(e) => setPayPin(e.target.value.replace(/[^0-9]/g, ""))} />
              <Link to="/me/payment-password" className="text-xs text-primary hover:underline">{t("order.pay_pw_manage", "管理支付密码")}</Link>
            </div>
          )}

          <ul className="flex flex-col divide-y divide-border/70 border-t">
            {schedule.map((p) => {
              const isDeposit = p.index === 1;
              const live = livePeriod(p.index);
              const paid = periodPaid(p.index);
              const overdue = Boolean(live?.overdue) && !isDeposit;
              const inflight = payments.some((pp) => Number(pp.installment_index) === p.index && ["PENDING_SUBMIT", "PENDING_REVIEW"].includes(pp.status));
              const canDeposit = isDeposit && order.status_order === "PENDING_PAYMENT" && order.expired !== true;
              const canTail = !isDeposit && order.status_payment === "INSTALLMENT_ACTIVE";
              const payable = !paid && !inflight && (canDeposit || canTail);
              return (
                <li key={p.index} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="w-16 shrink-0">{isDeposit ? t("installment.deposit_tag", "首付") : tf("installment.period_tag", { n: p.index }, "第 {n} 期")}</span>
                  <span className="font-medium">{formatBase(p.amount_base)}</span>
                  {p.due_date && <span className="text-xs text-muted-foreground">{tf("installment.due", { date: fmtDate(p.due_date) }, "到期 {date}")}</span>}
                  <span className="ml-auto text-xs">
                    {paid ? <b className="text-primary">{t("installment.period_paid", "已付")}</b>
                      : overdue ? <b className="text-destructive">{t("installment.period_overdue", "逾期")}</b>
                      : inflight ? <span className="text-muted-foreground">{t("installment.period_review", "审核中")}</span>
                      : payable ? <span className="text-muted-foreground">{t("installment.period_due", "待付")}</span>
                      : <span className="text-muted-foreground">{t("installment.period_locked", "未开始")}</span>}
                  </span>
                  {payable && (
                    <div className="flex w-full flex-wrap items-center gap-2 pt-1">
                      <Button size="sm" disabled={busy !== "" || user.balance < p.amount_base}
                        onClick={() => { const b = withPayPin({ order_id: order.id, installment_index: p.index }); if (b) void post("installment/pay", b, `inst_pay_${p.index}`); }}>
                        {t("installment.pay_balance", "余额付本期")}
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy !== "" || !channels.length}
                        onClick={() => { void post("installment/pay", { order_id: order.id, installment_index: p.index, method: chosenQr, chain_index: coinIdx }, `inst_qr_${p.index}`); }}>
                        {t("installment.pay_qr", "扫码付本期")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {order.status_payment === "INSTALLMENT_ACTIVE" && instRemaining > 0 && (
            <div className="flex flex-col gap-2 border-t pt-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t("installment.settle_now", "提前结清")}</span>
                <b className="text-primary">{formatBase(instRemaining)}</b>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label={t("order.qr_channel", "扫码渠道")} className="h-9 rounded-md border bg-background px-2 text-sm" value={chosenQr} onChange={(e) => setQrMethod(e.target.value)}>
                  {channels.length ? channels.map((c) => <option key={c.method} value={c.method}>{channelLabel(c.method, c.display_name, t)}</option>) : <option value="">{t("order.no_channel", "后台未开启收款渠道")}</option>}
                </select>
                <Button size="sm" disabled={busy !== "" || user.balance < instRemaining}
                  onClick={() => { const b = withPayPin({ order_id: order.id }); if (b) void post("installment/settle", b, "inst_settle_bal"); }}>
                  {t("installment.settle_balance", "余额一次性结清")}
                </Button>
                <Button size="sm" variant="outline" disabled={busy !== "" || !channels.length}
                  onClick={() => { void post("installment/settle", { order_id: order.id, method: chosenQr, chain_index: coinIdx }, "inst_settle_qr"); }}>
                  {t("installment.settle_qr", "扫码一次性结清")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("installment.settle_note", "提前结清不收手续费；已付各期不退，只补齐未付期。扫码结清走人工到账确认。")}</p>
            </div>
          )}
        </section>
      )}

      {!isInstallment && (acts.can_pay || payments.some((p) => ["PENDING_SUBMIT", "REJECTED"].includes(p.status) && isQrPayment(config?.pay_channels, p.method))) && (
        <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <p className="text-sm font-medium">{t("order.due_title", "待付差额")} {money(Math.round((remaining * Number(order.currency_rate_scaled)) / 1e6), symbol)}</p>
          {ticket && <QrTicketCard ticket={ticket} coinIdx={coinIdx} onCoinIdx={setCoinIdx} />}
          {payments
            .filter((p) => ["PENDING_SUBMIT", "REJECTED"].includes(p.status) && isQrPayment(config?.pay_channels, p.method))
            .map((p) => <ProofUploadForm key={p.id} payment={p} chainIndex={coinIdx} onDone={() => { setTicket(null); void load(); }} />)}

          {acts.can_pay && (
            <div className="flex flex-col gap-3 border-t pt-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t("order.available_balance", "可用余额")}</span>
                <b className="text-primary">{money(user.balance, symbol)}</b>
                <span className="text-xs text-muted-foreground">{tf("order.balance_basis", { amt: formatBase(user.balance) }, "（{amt} 基准）")}</span>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy !== "" || user.balance < remaining}
                  onClick={() => { const b = withPayPin({ order_id: order.id }); if (b) void post("pay/wallet", b, "pay_balance_full"); }}
                >{t("order.balance_full", "余额全额支付")}</Button>
                {user.balance > 0 && user.balance < remaining && (
                  <span className="flex items-center gap-2">
                    <Input className="h-8 w-24" placeholder={t("order.balance_part_ph", "余额部分")} value={partYuan} onChange={(e) => setPartYuan(e.target.value)} />
                    <Button
                      size="sm" variant="outline" disabled={busy !== ""}
                      onClick={() => {
                        const cents = yuanToCents(partYuan);
                        const cap = Math.min(remaining, user.balance);
                        if (!cents) { setActionError(tf("order.balance_part_need", { unit: baseUnit() }, "请填写余额支付的金额（{unit}）")); return; }
                        if (cents > cap) { setActionError(tf("order.balance_part_max", { amt: money(cap, symbol) }, "余额部分最多 {amt}")); return; }
                        const b = withPayPin({ order_id: order.id, amount_base: cents });
                        if (!b) return;
                        setPartYuan("");
                        setPayPin("");
                        void post("pay/wallet-part", b, "pay_balance_part");
                      }}
                    >{t("order.balance_part", "余额部分支付")}</Button>
                  </span>
                )}
              </div>

              {user.has_payment_password && (
                <div className="flex flex-wrap items-center gap-2">
                  <Label className="text-sm text-muted-foreground" htmlFor="order-pay-pin">{t("order.pay_pw_label", "支付密码")}</Label>
                  <Input
                    id="order-pay-pin" className="h-8 w-40" type="password" inputMode="numeric" autoComplete="off" maxLength={20}
                    placeholder={t("order.pay_pw_ph", "6–20 位数字")}
                    value={payPin} onChange={(e) => setPayPin(e.target.value.replace(/[^0-9]/g, ""))}
                  />
                  <Link to="/me/payment-password" className="text-xs text-primary hover:underline">{t("order.pay_pw_manage", "管理支付密码")}</Link>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label={t("order.qr_channel", "扫码渠道")}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={chosenQr}
                  onChange={(e) => setQrMethod(e.target.value)}
                >
                  {channels.length
                    ? channels.map((c) => <option key={c.method} value={c.method}>{channelLabel(c.method, c.display_name, t)}</option>)
                    : <option value="">{t("order.no_channel", "后台未开启收款渠道")}</option>}
                </select>
                <Button
                  size="sm" variant="outline" disabled={busy !== "" || !channels.length}
                  className="h-auto max-w-full whitespace-normal py-1.5 text-left"
                  onClick={() => {
                    if (remaining <= 0) { setActionError(t("order.qr_no_due", "订单已无未付差额")); return; }
                    void post("pay/qrcode", { order_id: order.id, method: chosenQr, amount_base: remaining, chain_index: coinIdx }, "pay_qr");
                  }}
                >{t("order.gen_qr", "生成收款码（金额需等于差额）")}</Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("order.qr_note", "扫码转账为人工确认：一次转账必须覆盖全部差额，审核通过后整单转「已付款」；驳回则需重新支付，支付时限不重置。")}
              </p>
            </div>
          )}

          {!acts.can_pay && acts.pay_blocked_reason && (
            <p className="text-sm text-destructive">
              {acts.pay_blocked_reason === "in_review" ? t("order.in_review_block", "凭证审核中，暂不可再次支付") : t("order.deadline_block", "支付时限已过，无法继续支付")}
            </p>
          )}
        </section>
      )}

      {!!refv?.refunds?.length && (
        <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{t("order.refund_records", "退款记录")}</p>
            <span className="ml-auto text-xs text-muted-foreground">
              {tf("order.refund_summary", { amt: formatBase(refv.refunded_base), remain: formatBase(refv.remaining_refundable_base), n: refv.refunds.length }, "已退 {amt} · 未退 {remain}（共 {n} 笔）")}
            </span>
          </div>
          <ol className="flex flex-col gap-2">
            {refv.refunds.slice().reverse().map((rf) => (
              <li key={rf.id} className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={rf.status === "COMPLETED" ? "default" : rf.status === "REJECTED" ? "outline" : "secondary"}>
                    {(() => { const v = REFUND_STATUS_TEXT[rf.status]; return v === undefined ? rf.status : t("status.refund." + rf.status, v); })()}
                  </Badge>
                  <span className="font-medium text-primary">{money(rf.amount_currency ?? rf.amount_base, rf.amount_currency === null ? getBaseSymbol() : symbol)}</span>
                  <span className="text-muted-foreground">{(() => { const v = REFUND_METHOD_TEXT[rf.refund_method]; return v === undefined ? rf.refund_method : t("status.refund_method." + rf.refund_method, v); })()}</span>
                  <span className="ml-auto text-muted-foreground">{fmtTime(rf.created_at)}</span>
                </div>
                <p className="text-muted-foreground">{t("order.refund_reason", "原因：")}{rf.apply_reason}</p>
                {rf.lines ? (
                  <p className="text-muted-foreground">
                    {t("order.refund_lines_label", "明细：")}{rf.lines.map((l) => `${l.sku_id?.slice(0, 8) ?? t("order.refund_line_row", "行")} × ${l.quantity}`).join(t("common.list_sep", "、"))}
                  </p>
                ) : (
                  <p className="text-muted-foreground">{t("order.refund_full", "整单退款")}</p>
                )}
                {rf.reject_reason && <p className="text-destructive">{t("order.reject_reason", "驳回原因：")}{rf.reject_reason}</p>}
                {rf.refund_split.balance > 0 && <p className="text-muted-foreground">{tf("order.refund_split_balance", { amt: formatBase(rf.refund_split.balance) }, "· 余额来源退回钱包 {amt} 基准")}</p>}
                {rf.refund_split.offline_qr > 0 && (
                  <p className="text-muted-foreground">
                    {tf("order.refund_split_offline", { amt: formatBase(rf.refund_split.offline_qr) }, "· 扫码来源 {amt} 基准线下原路退回")}
                    {rf.refund_split.offline_done_at ? tf("order.refund_offline_done", { time: fmtTime(rf.refund_split.offline_done_at) }, "（已登记 {time}）") : t("order.refund_offline_pending", "（待后台登记）")}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {invc && (invc.invoice || invc.can_apply || invc.paid) && (
        <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{t("order.invoice_title", "发票")}</p>
            {invc.invoice && (
              <Badge variant={invc.invoice.status === "issued" ? "default" : invc.invoice.status === "void" ? "outline" : "secondary"}>
                {(() => { const v = INVOICE_STATUS_TEXT[invc.invoice!.status]; return v === undefined ? invc.invoice!.status : t("status.invoice." + invc.invoice!.status, v); })()}
              </Badge>
            )}
          </div>
          {invc.invoice ? (
            <div className="flex flex-col gap-1 text-sm text-muted-foreground">
              <p>
                {t("order.invoice_head", "抬头：")}{invc.invoice.title}
                <span className="ml-2">{tf("common.paren", { v: (() => { const v = INVOICE_TYPE_TEXT[invc.invoice!.invoice_type]; return v === undefined ? invc.invoice!.invoice_type : t("status.invoice_type." + invc.invoice!.invoice_type, v); })() }, "（{v}）")}</span>
                {invc.invoice.tax_no && <span className="ml-2">{t("order.invoice_taxno", "税号 ")}{invc.invoice.tax_no}</span>}
              </p>
              <p>{t("order.invoice_email_label", "接收邮箱：")}{invc.invoice.email}</p>
              {invc.invoice.remark && <p>{t("order.remark_prefix", "备注：")}{invc.invoice.remark}</p>}
              <p>{t("order.invoice_amount", "开票金额：")}{formatBase(invc.invoice.amount_base)}{t("order.invoice_basis", " 基准")}</p>
              <p>
                {t("order.invoice_applied_at", "申请于 ")}{fmtTime(invc.invoice.created_at)}
                {invc.invoice.status === "issued" && invc.invoice.issued_at && (t("order.invoice_issued_at", " · 开具于 ") + fmtTime(invc.invoice.issued_at))}
                {invc.invoice.status === "void" && invc.invoice.void_reason && (t("order.invoice_void_reason", " · 作废原因：") + invc.invoice.void_reason)}
              </p>
            </div>
          ) : invc.can_apply ? (
            <p className="text-sm text-muted-foreground">{tf("order.invoice_can_issue", { amt: formatBase(invc.actual_paid_base) }, "本单实付 {amt} 基准，可开具电子发票。")}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("order.invoice_after_paid", "订单支付完成后即可申请发票。")}</p>
          )}
        </section>
      )}

      {invApplying && !invc?.invoice && (
        <section className="flex flex-col gap-3 rounded-2xl border bg-accent/40 p-4">
          <p className="text-sm font-medium">{t("order.apply_invoice", "申请发票")}</p>
          <p className="text-xs text-muted-foreground">{t("order.invoice_apply_note", "开具金额与币种按本单实付快照核定；后台开具后电子发票会发送到下方接收邮箱。")}</p>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-1.5 text-sm">
              <input type="radio" name="inv-type" checked={invType === "personal"} onChange={() => setInvType("personal")} />{t("status.invoice_type.personal", "个人")}
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="radio" name="inv-type" checked={invType === "enterprise"} onChange={() => setInvType("enterprise")} />{t("status.invoice_type.enterprise", "企业单位")}
            </label>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="inv-title">{t("order.invoice_title_label", "发票抬头")}{invType === "enterprise" ? t("order.invoice_head_company", "（单位名称）") : t("order.invoice_head_person", "（姓名）")}</Label>
            <Input id="inv-title" maxLength={100} value={invTitle} onChange={(e) => setInvTitle(e.target.value)} placeholder={invType === "enterprise" ? t("order.invoice_title_ph_ent", "例如：某某科技有限公司") : t("order.invoice_title_ph_per", "例如：张三")} disabled={busy !== ""} />
          </div>
          {invType === "enterprise" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="inv-tax">{t("order.invoice_taxno_label", "纳税人识别号")}</Label>
              <Input id="inv-tax" maxLength={40} value={invTax} onChange={(e) => setInvTax(e.target.value)} placeholder={t("order.invoice_taxno_ph", "15–20 位税号")} disabled={busy !== ""} />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="inv-email">{t("order.invoice_email_field", "接收邮箱")}</Label>
            <Input id="inv-email" type="email" maxLength={120} value={invEmail} onChange={(e) => setInvEmail(e.target.value)} placeholder={t("order.invoice_email_ph", "用于接收电子发票")} disabled={busy !== ""} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="inv-remark">{t("order.invoice_remark_label", "备注（选填）")}</Label>
            <Input id="inv-remark" maxLength={200} value={invRemark} onChange={(e) => setInvRemark(e.target.value)} placeholder={t("order.invoice_remark_ph", "例如：发票内容开“办公用品”")} disabled={busy !== ""} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy !== ""} onClick={() => void submitInvoice()}>{busy === "apply_invoice" ? t("common.submitting", "提交中…") : t("order.invoice_submit", "提交申请")}</Button>
            <Button size="sm" variant="ghost" disabled={busy !== ""} onClick={() => { setInvApplying(false); setInvTitle(""); setInvTax(""); setInvRemark(""); }}>{t("order.refund_not_now", "暂不申请")}</Button>
          </div>
        </section>
      )}

      {actionError && <p className="rounded-xl border bg-card px-4 py-2 text-sm text-destructive">{actionError}</p>}

      <section className="flex flex-wrap items-center gap-2">
        {acts.can_cancel && (
          <span className="flex items-center gap-2">
            <Input className="h-8 w-32" placeholder={t("order.cancel_input_ph", "取消原因（选填）")} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={200} />
            <Button
              size="sm" variant="outline" disabled={busy !== ""}
              onClick={async () => {
                const r = await post("order/cancel", { order_id: order.id, reason: cancelReason || undefined }, "cancel");
                if (r) navigate("/orders?tab=cancelled");
              }}
            >{t("order.cancel_btn", "取消订单")}</Button>
          </span>
        )}
        {acts.can_confirm_receipt && (
          <Button size="sm" disabled={busy !== ""} onClick={() => void post("order/confirm-receipt", { order_id: order.id }, "confirm_receipt")}>{t("order.confirm_receipt", "确认收货")}</Button>
        )}
        {order.status_payment === "PAID"
          && !["CANCELLED", "REFUNDED", "REFUNDING"].includes(order.status_order)
          && (refv?.remaining_refundable_base ?? 0) > 0 && (
          <span className="flex flex-col items-start gap-1">
            <Button size="sm" variant="outline" disabled={busy !== "" || !refv?.can_apply} onClick={gotoRefundCs}>{t("order.apply_refund_cs", "申请退款（转客服）")}</Button>
            {!!refv?.refunds?.length && !refv?.can_apply && (
              <p className="text-xs text-muted-foreground">{t("order.refund_once_only", "一个订单只能退款一次，本单已有退款记录，可在客服中心咨询进度")}</p>
            )}
          </span>
        )}
        {invc?.can_apply && !invApplying && (
          <Button size="sm" variant="outline" disabled={busy !== ""} onClick={() => { setInvApplying(true); if (!invEmail && user.email) setInvEmail(user.email); }}>{t("order.apply_invoice", "申请发票")}</Button>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void load()} disabled={busy !== ""}>{t("common.refresh", "刷新")}</Button>
      </section>
    </div>
  );
}
