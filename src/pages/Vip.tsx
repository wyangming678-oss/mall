// 会员中心（整体逻辑 §一：/me/vip；文档C V1 vip/plans + V2 vip/purchase）
// 扫码开通复用订单的凭证链：V2 只建 VIP_PURCHASE 分项，权益等后台 PF3 过审后按当时套餐快照落库
import { useEffect, useState } from "react";
import { call, newIdem } from "../api";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { baseUnit, formatBase } from "../const";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { ProofUploadForm, QrTicketCard, type QrTicket } from "../components/PayFlow";
import { Button } from "@/components/ui/button";
import {
  PAYMENT_ROW_TEXT, channelLabel, fmtDate, lazyTick, manualChannels, methodLabel, money, rateText, shopErr, symbolOf, usableCurrencyCode,
  useLoader, vipDaysLeft,
  type MeResult, type PaymentRow, type VipPlan, type VipPurchase,
} from "../trade";

interface VipData {
  plans: VipPlan[];
  me: MeResult;
  vipPayments: PaymentRow[];
}

function planName(plan: VipPlan, lang: string): string {
  return plan.name_i18n?.[lang] ?? plan.name;
}

/** 折后价示例：100 元商品按会员折扣后应付多少 */
function sampleAfter(priceBase: number, rate: number): string {
  return formatBase(Math.floor((priceBase * rate) / 10000));
}

export function VipPage() {
  const { user, currencies, config, lang, ready, refresh: refreshSite, t, tf } = useSite();
  const { data, loading, error, refresh } = useLoader<VipData>(async () => {
    const [plans, me, pays] = await Promise.all([
      call<{ items: VipPlan[] }>("vip/plans", { token: "user" }),
      call<MeResult>("auth/me", { token: "user" }),
      call<{ items: PaymentRow[] }>("pay/list", { token: "user" }),
    ]);
    return {
      plans: plans.items,
      me,
      vipPayments: pays.items.filter((p) => p.payment_type === "VIP_PURCHASE"),
    };
  }, [user?.id]);

  const qrChannels = manualChannels(config?.pay_channels);
  const [payMethod, setPayMethod] = useState<"BALANCE" | "QR">("BALANCE");
  const [channel, setChannel] = useState("");
  // 选中项失效（未选/渠道被删）时回落到首个可用渠道
  const chosenChannel = qrChannels.some((c) => c.method === channel) ? channel : (qrChannels[0]?.method ?? "");
  const [busyPlan, setBusyPlan] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [ticket, setTicket] = useState<QrTicket | null>(null);
  const [coinIdx, setCoinIdx] = useState(0);

  useEffect(() => { void lazyTick("user"); }, []);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("vip.loading", "正在加载会员…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  const vip = data?.me.vip ?? null;
  const myPlan = data?.plans.find((p) => p.plan_id === vip?.plan_id) ?? null;
  const settleCode = usableCurrencyCode(currencies, user.currency_code);
  const symbol = symbolOf(currencies, settleCode);
  // 刚下单生成的分项在下方「开通方式」里带凭证上传，列表里先排除，避免同一分项出现两个上传表单
  const pending = (data?.vipPayments ?? []).filter((p) => ["PENDING_SUBMIT", "PENDING_REVIEW", "REJECTED"].includes(p.status) && p.id !== ticket?.payment_id);
  const stackOn = config?.switches?.vip_coupon_stack !== false;

  async function buy(plan: VipPlan) {
    setBusyPlan(plan.plan_id);
    setFormError("");
    setNotice("");
    try {
      const r = await call<VipPurchase>("vip/purchase", {
        method: "POST", token: "user", idem: newIdem(),
        body: {
          plan_id: plan.plan_id,
          pay_method: payMethod,
          ...(payMethod === "QR" ? { channel: chosenChannel, chain_index: coinIdx } : {}),
        },
      });
      if (r.pay_method === "BALANCE") {
        setTicket(null);
        setNotice(tf("vip.joined_notice", { plan: planName(plan, lang), date: fmtDate(r.vip.expire_at), balance: money(r.balance_after, symbol) }, "{plan} 已开通，有效期至 {date}，余额还剩 {balance}"));
        // 余额是站点上下文里的数，不刷新的话「现余额」会一直停在扣款前
        void refreshSite();
      } else {
        setTicket({
          payment_id: r.payment_id,
          amount_base: r.amount_base,
          amount_currency: r.amount_currency,
          currency_code: r.currency_code,
          channel: r.channel,
          transfer_reference: r.transfer_reference,
        });
        setNotice(t("vip.qr_created_notice", "已生成会员开通待付分项：按下方金额与备注转账后上传凭证，后台确认到账才开通。"));
      }
      refresh();
    } catch (e) {
      setFormError(shopErr(e));
    } finally {
      setBusyPlan("");
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
      <SubHeader title={t("vip.title", "会员中心")} />

      {error && <p className="border-y border-border/70 px-1 py-3 text-sm text-destructive">{error}</p>}
      {loading && !data && <div className="grid place-items-center py-14"><CartLoading label={t("vip.loading", "正在加载会员…")} /></div>}

      <section className="flex flex-col gap-2 border-b border-border/70 pb-4">
        <p className="text-sm font-medium">{t("vip.my_membership", "我的会员")}</p>
        {vip ? (
          <div className="flex flex-col gap-1 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <b className="text-base">{myPlan ? planName(myPlan, lang) : t("me.vip", "会员")}</b>
              <span className="text-primary">{rateText(vip.discount_rate)}</span>
              <span className="text-xs text-muted-foreground">{tf("vip.active_days", { n: vipDaysLeft(vip.expire_at) }, "生效中 · 剩余 {n} 天")}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {tf("vip.date_range", { from: fmtDate(vip.start_at), to: fmtDate(vip.expire_at) }, "{from} 起 → {to} 止")} ·{" "}
              {t("vip.deal_price", "成交价")} {vip.purchase_price_base === 0 ? t("vip.gifted", "后台赠送") : formatBase(vip.purchase_price_base)}
            </p>
            {!!vip.benefits_snapshot.length && (
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {vip.benefits_snapshot.map((b, i) => <li key={i}>· {b}</li>)}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              {t("vip.snapshot_note", "折扣按开通那一刻的套餐快照计算，后台改价或下架都不回溯本权益。")}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("vip.none_note", "当前不是会员：开通后下单自动享会员折扣，续费在原到期日之后顺延。")}</p>
        )}
      </section>

      {!!pending.length && (
        <section className="flex flex-col gap-3 border-b border-border/70 pb-4">
          <p className="text-sm font-medium">{t("vip.pending_title", "待处理的开通申请")}</p>
          {pending.map((p) => (
            <div key={p.id} className="flex flex-col gap-2">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{methodLabel(config?.pay_channels, p.method, t)}</span>
                <b>{money(p.amount_currency, symbolOf(currencies, p.currency_code))}</b>
                <span className="text-xs">{t("status.pay_row." + p.status, PAYMENT_ROW_TEXT[p.status] ?? p.status)}</span>
              </p>
              {p.status === "REJECTED" && <p className="text-xs text-destructive">{t("vip.proof_rejected", "凭证被驳回：")}{p.reject_reason || t("vip.reject_hint", "请核对金额与流水号后重新上传")}</p>}
              {p.status === "PENDING_REVIEW" && <p className="text-xs text-muted-foreground">{t("vip.reviewing_note", "后台正在核对流水，通过后才写入会员权益。")}</p>}
              {["PENDING_SUBMIT", "REJECTED"].includes(p.status) && (
                <ProofUploadForm
                  payment={p}
                  chainIndex={coinIdx}
                  onDone={() => { setNotice(t("vip.proof_submitted", "凭证已提交，等待后台确认到账。")); refresh(); }}
                />
              )}
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <p className="text-sm font-medium">{t("vip.method_title", "开通方式")}</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => setPayMethod("BALANCE")}
            className={"border px-3 py-1.5 text-sm transition " + (payMethod === "BALANCE" ? "border-primary bg-primary text-primary-foreground" : "hover:border-primary")}
          >
            {tf("vip.pay_by_balance", { amt: money(user.balance, symbol) }, "余额支付（即时开通 · 现余额 {amt}）")}
          </button>
          {qrChannels.length > 0 && (
            <button
              type="button"
              onClick={() => setPayMethod("QR")}
              className={"border px-3 py-1.5 text-sm transition " + (payMethod === "QR" ? "border-primary bg-primary text-primary-foreground" : "hover:border-primary")}
            >
              {t("vip.pay_by_qr", "扫码转账（后台确认后开通）")}
            </button>
          )}
        </div>
        {payMethod === "QR" && qrChannels.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("wallet.channel_label", "转账渠道")}</span>
            <select className="h-8 rounded-md border bg-background px-2 text-sm" value={chosenChannel} onChange={(e) => setChannel(e.target.value)}>
              {qrChannels.map((c) => <option key={c.method} value={c.method}>{channelLabel(c.method, c.display_name, t)}</option>)}
            </select>
          </div>
        )}
        {!qrChannels.length && payMethod === "BALANCE" && (
          <p className="text-xs text-muted-foreground">{t("vip.no_qr_channel", "后台未开通扫码收款渠道，只能用余额支付。")}</p>
        )}
      </section>

      {ticket && (
        <section className="flex flex-col gap-3">
          <QrTicketCard ticket={ticket} coinIdx={coinIdx} onCoinIdx={setCoinIdx} />
          <ProofUploadForm
            payment={{ id: ticket.payment_id, currency_code: ticket.currency_code, amount_currency: ticket.amount_currency }}
            chainIndex={coinIdx}
            onDone={() => { setNotice(t("vip.proof_submitted", "凭证已提交，等待后台确认到账。")); setTicket(null); refresh(); }}
          />
        </section>
      )}

      {notice && <p className="border-y border-border/70 px-1 py-3 text-sm text-primary">{notice}</p>}
      {formError && <p className="border-y border-border/70 px-1 py-3 text-sm text-destructive">{formError}</p>}

      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t("vip.plans_title", "会员套餐")}</p>
        {!data?.plans.length && <p className="text-sm text-muted-foreground">{t("vip.plans_empty", "暂无可售套餐：后台上架后这里会自动出现。")}</p>}
        {data?.plans.map((plan) => {
          const displayPrice = plan.prices?.[settleCode] ?? plan.price_base;
          const enough = user.balance >= plan.price_base;
          return (
            <div key={plan.plan_id} className="flex flex-wrap items-center gap-3 border-b border-border/70 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-baseline gap-2">
                  <b className="text-base">{planName(plan, lang)}</b>
                  <span className="text-sm text-primary">{rateText(plan.discount_rate)}</span>
                  <span className="text-xs text-muted-foreground">{tf("vip.plan_days_sample", { days: plan.duration_days, unit: baseUnit(), amt: sampleAfter(10000, plan.discount_rate) }, "{days} 天 · 买 {unit}100 商品约 {amt}")}</span>
                </span>
                {!!plan.benefits.length && (
                  <span className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                    {plan.benefits.map((b, i) => <span key={i}>· {b}</span>)}
                  </span>
                )}
                {payMethod === "BALANCE" && !enough && (
                  <Link to="/wallet" className="text-xs text-destructive underline">{t("vip.balance_low", "余额不足，去充值")}</Link>
                )}
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <b className="text-primary">{money(displayPrice, symbol)}</b>
                <Button
                  size="sm"
                  disabled={busyPlan === plan.plan_id || (payMethod === "BALANCE" && !enough) || config?.switches?.order_open === false}
                  onClick={() => void buy(plan)}
                >
                  {busyPlan === plan.plan_id ? t("common.processing", "处理中…") : payMethod === "BALANCE" ? t("vip.join_by_balance", "余额开通") : t("vip.join_by_qr", "扫码开通")}
                </Button>
              </span>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          {stackOn
            ? t("vip.stack_on_note", "会员折扣在券之前计算：先按会员折后金额判定优惠券门槛，两者可叠加。")
            : t("vip.stack_off_note", "后台已关闭「会员折扣 + 优惠券叠加」：选券的本单只用券，不选券仍享会员折扣。")}
        </p>
      </section>
    </div>
  );
}
