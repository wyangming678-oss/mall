// 钱包：W1 余额与账本 + W2 扫码充值 + Y5 充值分项凭证
import { useCallback, useEffect, useState } from "react";
import { ApiError, call, newIdem } from "../api";
import { text } from "../i18n";
import { dataText } from "../data-text";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { baseUnit, formatBase } from "../const";
import { CartLoading } from "../components/CartLoading";
import { ProofUploadForm, QrTicketCard, type QrTicket } from "../components/PayFlow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PAYMENT_ROW_TEXT, channelLabel, fmtTime, lazyTick, manualChannels, methodLabel, money, shopErr, symbolOf, usableCurrencyCode,
  yuanToCents, type PaymentRow,
} from "../trade";
import { AMT_UNLIMITED, WD_METHODS, WD_NETS, pickPayout, payoutIssue, payoutLabel, wdErrText, wdMethod, wdMethodName, type WdPayoutEntry } from "../withdraw";

interface WalletOverview {
  balance: number;
  currency_code: string;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: Array<{
    id: string; txn_type: string; amount: number; balance_before: number; balance_after: number;
    ref_type: string | null; ref_id: string | null; remark: string | null; created_at: string;
  }>;
}

interface WithdrawCfg {
  enabled: boolean; min_amount_base: number; max_amount_base: number; daily_limit: number;
}
interface WithdrawRow {
  id: string; amount_base: number; currency_code: string; fee_base: number | null;
  method: string | null; payout_account: string; payout?: WdPayoutEntry[]; status: string;
  review_note: string | null; reviewed_at: string | null; payout_ref: string | null; created_at: string; updated_at: string;
}
const WITHDRAW_TEXT: Record<string, string> = { /* i18n-fallback */
  PENDING: "待审核", COMPLETED: "已到账", REJECTED: "已驳回/已撤销",
};

export function WalletPage() {
  const { user, currencies, config, ready, t, tf, refresh: refreshSite } = useSite();
  const [overview, setOverview] = useState<WalletOverview | null>(null);
  const [recharges, setRecharges] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [amountYuan, setAmountYuan] = useState("");
  const [method, setMethod] = useState("");
  const [ticket, setTicket] = useState<QrTicket | null>(null);
  const [coinIdx, setCoinIdx] = useState(0);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  // 提现：门槛来自 wallet/withdraw/list 回带；拉取失败只隐藏入口，不打断钱包页
  const [wdCfg, setWdCfg] = useState<WithdrawCfg | null>(null);
  const [withdraws, setWithdraws] = useState<WithdrawRow[]>([]);
  const [wdPage, setWdPage] = useState<{ has_more: boolean; next_offset: number | null }>({ has_more: false, next_offset: null });
  const [wdAmountYuan, setWdAmountYuan] = useState("");
  const [wdMethodCode, setWdMethodCode] = useState(WD_METHODS[0].code);
  const [wdValues, setWdValues] = useState<Record<string, string>>({});
  const [wdBusy, setWdBusy] = useState(false);
  const [wdError, setWdError] = useState("");
  const [wdNotice, setWdNotice] = useState("");

  const load = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    try {
      const [w, p] = await Promise.all([
        call<WalletOverview>("wallet/overview", { token: "user", query: { offset } }),
        call<{ items: PaymentRow[] }>("pay/list", { token: "user" }),
      ]);
      setOverview((prev) => (append && prev ? { ...prev, items: [...prev.items, ...w.items], has_more: w.has_more, next_offset: w.next_offset } : w));
      setRecharges(p.items.filter((it) => it.payment_type === "WALLET_RECHARGE"));
      setError("");
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(0, false); }, [load]);
  useEffect(() => { void lazyTick("user"); }, []);

  const loadWithdraws = useCallback(async (offset: number, append: boolean) => {
    try {
      const r = await call<{ items: WithdrawRow[]; withdraw: WithdrawCfg; has_more: boolean; next_offset: number | null }>(
        "wallet/withdraw/list", { token: "user", query: { offset } },
      );
      setWdCfg(r.withdraw);
      setWithdraws((prev) => (append ? [...prev, ...r.items] : r.items));
      setWdPage({ has_more: r.has_more, next_offset: r.next_offset });
    } catch {
      /* 提现为可选能力：读失败保持入口隐藏，不影响余额/充值主流程 */
    }
  }, []);
  useEffect(() => { void loadWithdraws(0, false); }, [loadWithdraws]);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("wallet.loading", "正在加载钱包…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  // 账号币种已下架时回落站点本位币，与充值端点的解析口径一致
  const currencyCode = usableCurrencyCode(currencies, user.currency_code);
  const symbol = symbolOf(currencies, currencyCode);
  const rate = currencies.find((c) => c.code === currencyCode)?.rate_scaled ?? 1_000_000;
  const shown = (base: number) => money(Math.round((base * rate) / 1e6), symbol);
  const channels = manualChannels(config?.pay_channels);
  // 选中项失效（未选/渠道被删）时回落到首个可用渠道，select 与提交都用这个生效值
  const chosenMethod = channels.some((c) => c.method === method) ? method : (channels[0]?.method ?? "");
  const nextOffset = overview?.next_offset ?? null;
  // 提现走固定的四种收款方式（决策 4），与后台开启的收款渠道无关
  const wdChosen = wdMethod(wdMethodCode);
  const wdMaxText = !wdCfg ? "" : wdCfg.max_amount_base >= AMT_UNLIMITED ? t("withdraw.no_limit", "不限") : shown(wdCfg.max_amount_base);
  const withdrawable = overview?.balance ?? user.balance;
  const wdNextOffset = wdPage.next_offset ?? null;

  async function recharge() {
    const cents = yuanToCents(amountYuan);
    if (!cents || cents < 100) { setActionError(tf("wallet.min_amount", { unit: baseUnit() }, "充值金额最少 {unit}1")); return; }
    setBusy(true);
    setActionError("");
    try {
      const r = await call<QrTicket>("wallet/recharge", {
        method: "POST", token: "user", idem: newIdem(),
        body: { method: chosenMethod, amount_base: cents, chain_index: coinIdx },
      });
      setTicket(r);
      setAmountYuan("");
      await Promise.all([load(0, false), refreshSite()]);
    } catch (e) {
      setActionError(shopErr(e));
    } finally {
      setBusy(false);
    }
  }

  // 后端提现业务码有对位译文就按当前语言出，未收录的码仍回落后端原文
  const wdFail = (e: unknown) => setWdError(e instanceof ApiError ? wdErrText(e.code, t) || shopErr(e) : shopErr(e));

  async function withdraw() {
    const cents = yuanToCents(wdAmountYuan);
    if (!wdCfg) return;
    // 空金额不静默返回：真人只看到「点了没反应」，与低于最低额同一条提示
    if (!cents || cents < wdCfg.min_amount_base) { setWdError(tf("withdraw.min_amount", { amt: shown(wdCfg.min_amount_base) }, "提现金额最少 {amt}")); return; }
    if (wdCfg.max_amount_base < AMT_UNLIMITED && cents > wdCfg.max_amount_base) { setWdError(tf("withdraw.max_amount", { amt: shown(wdCfg.max_amount_base) }, "单笔提现最多 {amt}")); return; }
    if (cents > withdrawable) { setWdError(tf("withdraw.over_balance", { amt: shown(withdrawable) }, "提现金额不能超过可提现余额 {amt}")); return; }
    const issue = payoutIssue(wdChosen, wdValues, t, tf);
    if (issue) { setWdError(issue); return; }
    setWdBusy(true);
    setWdError("");
    setWdNotice("");
    try {
      await call("wallet/withdraw/apply", {
        method: "POST", token: "user", idem: newIdem(),
        body: { amount_base: cents, method: wdChosen.code, payout: pickPayout(wdChosen, wdValues) },
      });
      setWdAmountYuan("");
      setWdValues({});
      setWdNotice(t("withdraw.applied_ok", "提现申请已提交，余额已冻结扣除，客服打款后会通知你"));
      await Promise.all([loadWithdraws(0, false), load(0, false), refreshSite()]);
    } catch (e) {
      wdFail(e);
    } finally {
      setWdBusy(false);
    }
  }

  async function cancelWithdraw(id: string) {
    setWdBusy(true);
    setWdError("");
    try {
      await call("wallet/withdraw/cancel", { method: "POST", token: "user", idem: newIdem(), body: { id } });
      setWdNotice(t("withdraw.cancel_ok", "提现已撤销，金额已退回余额"));
      await Promise.all([loadWithdraws(0, false), load(0, false), refreshSite()]);
    } catch (e) {
      wdFail(e);
    } finally {
      setWdBusy(false);
    }
  }

  if (loading && !overview) return <div className="grid place-items-center py-16"><CartLoading label={t("wallet.loading", "正在加载钱包…")} /></div>;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{t("wallet.title", "我的钱包")}</h1>
        <Link to="/orders" className="text-sm text-primary underline">{t("wallet.orders_link", "我的订单")}</Link>
      </div>
      {error && <p className="rounded-xl border bg-card px-4 py-3 text-sm text-destructive">{error}</p>}

      <section className="flex flex-col gap-1 rounded-2xl brand-gradient p-5 text-white shadow-md shadow-primary/40">
        <span className="text-xs opacity-90">{tf("wallet.balance", { code: currencyCode }, "账户余额（{code}）")}</span>
        <span className="text-3xl font-bold">{overview ? shown(overview.balance) : formatBase(user.balance)}</span>
        <span className="text-xs opacity-80">{tf("wallet.basis_recharge_note", { amt: formatBase(user.balance) }, "计价基准 {amt} · 充值需扫码转账并由后台确认到账")}</span>
      </section>

      {config?.switches?.coins && (
        <Link to="/coins" className="flex items-center justify-between border-b border-border/70 px-1 py-3 text-sm">
          <span className="text-muted-foreground">{t("wallet.coins_entry", "金币中心 · 签到攒币、兑换专区好物")}</span>
          <span className="text-primary">{t("common.go", "前往")} ›</span>
        </Link>
      )}

      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
        <p className="text-sm font-medium">{t("wallet.recharge_title", "余额充值")}</p>
        <div className="flex flex-wrap items-end gap-3">
          <span className="flex flex-col gap-1">
            <Label htmlFor="wa-amount">{tf("wallet.amount_label", { unit: baseUnit() }, "金额（{unit}）")}</Label>
            <Input id="wa-amount" className="w-28" value={amountYuan} onChange={(e) => setAmountYuan(e.target.value)} placeholder="100" disabled={busy} />
          </span>
          <span className="flex flex-col gap-1">
            <Label>{t("wallet.arrival_currency", "到账币种")}</Label>
            <span className="flex h-9 items-center rounded-md border bg-muted/40 px-2 text-sm text-muted-foreground">
              {currencyCode}
            </span>
          </span>
          <span className="flex flex-col gap-1">
            <Label htmlFor="wa-method">{t("wallet.channel_label", "转账渠道")}</Label>
            <select id="wa-method" className="h-9 rounded-md border bg-background px-2 text-sm" value={chosenMethod} onChange={(e) => setMethod(e.target.value)}>
              {channels.length
                ? channels.map((c) => <option key={c.method} value={c.method}>{channelLabel(c.method, c.display_name, t)}</option>)
                : <option value="">{t("wallet.no_channel", "后台未开启收款渠道")}</option>}
            </select>
          </span>
          <Button size="sm" onClick={() => void recharge()} disabled={busy || !channels.length}>
            {busy ? t("common.processing", "处理中…") : t("wallet.gen_qr", "生成充值收款码")}
          </Button>
        </div>
        {actionError && <p className="text-sm text-destructive">{actionError}</p>}
        {ticket && <QrTicketCard ticket={ticket} coinIdx={coinIdx} onCoinIdx={setCoinIdx} />}
      </section>

      {wdCfg?.enabled && (
        <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <p className="text-sm font-medium">{t("withdraw.title", "余额提现")}</p>
          <p className="text-xs text-muted-foreground">
            {tf("withdraw.intro", { min: shown(wdCfg.min_amount_base), max: wdMaxText, n: String(wdCfg.daily_limit) }, "单笔 {min} ~ {max}，每日最多 {n} 次；提交后先扣余额，客服线下打款到账")}
          </p>
          <p className="text-xs text-muted-foreground">{tf("withdraw.available", { amt: shown(withdrawable) }, "可提现余额 {amt}")}</p>
          <div className="flex flex-wrap items-end gap-3">
            <span className="flex flex-col gap-1">
              <Label htmlFor="wd-amount">{tf("withdraw.amount_label", { unit: baseUnit() }, "提现金额（{unit}）")}</Label>
              <Input id="wd-amount" className="w-28" value={wdAmountYuan} onChange={(e) => setWdAmountYuan(e.target.value)} placeholder="100" disabled={wdBusy} />
            </span>
            <span className="flex flex-col gap-1">
              <Label htmlFor="wd-method">{t("withdraw.method_label", "收款方式")}</Label>
              <select
                id="wd-method"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={wdChosen.code}
                onChange={(e) => { setWdMethodCode(e.target.value); setWdValues((p) => ({ network: "TRC20", ...p })); }}
                disabled={wdBusy}
              >
                {WD_METHODS.map((m) => <option key={m.code} value={m.code}>{wdMethodName(m.code, t)}</option>)}
              </select>
            </span>
            {wdChosen.fields.map((f) => (
              <span key={f.name} className={"flex flex-col gap-1" + (f.key === "ADDRESS" ? "min-w-48 flex-1" : "")}>
                <Label htmlFor={"wd-" + f.name}>{t(f.labelKey, f.zh)}</Label>
                {f.kind === "select" ? (
                  <select
                    id={"wd-" + f.name}
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={wdValues[f.name] ?? ""}
                    onChange={(e) => setWdValues((p) => ({ ...p, [f.name]: e.target.value }))}
                    disabled={wdBusy}
                  >
                    {WD_NETS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                ) : (
                  <Input
                    id={"wd-" + f.name}
                    className={f.key === "CARD_NO" ? "w-44" : undefined}
                    value={wdValues[f.name] ?? ""}
                    onChange={(e) => setWdValues((p) => ({ ...p, [f.name]: e.target.value }))}
                    maxLength={f.max}
                    inputMode={f.kind === "numeric" ? "numeric" : f.kind === "email" ? "email" : "text"}
                    placeholder={f.key === "CARD_NO" ? "6222021234567890" : f.key === "ADDRESS" ? "T... / 0x..." : undefined}
                    disabled={wdBusy}
                  />
                )}
              </span>
            ))}
            <Button size="sm" onClick={() => void withdraw()} disabled={wdBusy}>
              {wdBusy ? t("common.processing", "处理中…") : t("withdraw.apply", "申请提现")}
            </Button>
          </div>
          {wdError && <p className="text-sm text-destructive">{wdError}</p>}
          {wdNotice && <p className="text-sm text-primary">{wdNotice}</p>}
        </section>
      )}

      {!!withdraws.length && (
        <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
          <p className="text-sm font-medium">{t("withdraw.records_title", "提现记录")}</p>
          <ul className="flex flex-col gap-2">
            {withdraws.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <b>{wdMethodName(r.method ?? "", t)}</b>
                  <Badge variant={r.status === "COMPLETED" ? "default" : r.status === "REJECTED" ? "outline" : "secondary"}>
                    {t("status.withdraw." + r.status, WITHDRAW_TEXT[r.status] ?? r.status)}
                  </Badge>
                  <span className="ml-auto font-medium text-destructive">-{shown(r.amount_base)}</span>
                  <span className="text-xs text-muted-foreground">{fmtTime(r.created_at)}</span>
                </div>
                <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {(r.payout ?? [{ key: "RAW", value: r.payout_account }] as WdPayoutEntry[]).map((e) => {
                    const label = payoutLabel(e.key, t);
                    return <span key={e.key} className="break-all">{label ? <span className="opacity-70">{label} </span> : null}{e.value}</span>;
                  })}
                </span>
                {r.status === "COMPLETED" && r.payout_ref && <p className="break-all text-xs text-muted-foreground">{t("withdraw.payout_ref", "打款凭证：")}{r.payout_ref}</p>}
                {r.review_note && <p className="text-xs text-destructive">{t("withdraw.note", "备注：")}{r.review_note}</p>}
                {r.status === "PENDING" && (
                  <Button variant="outline" size="sm" className="self-start" disabled={wdBusy} onClick={() => void cancelWithdraw(r.id)}>
                    {t("withdraw.cancel", "撤销申请")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {wdPage.has_more && wdNextOffset !== null && (
            <Button variant="outline" size="sm" className="self-center" disabled={wdBusy} onClick={() => void loadWithdraws(wdNextOffset, true)}>
              {t("withdraw.records_more", "加载更多提现记录")}
            </Button>
          )}
        </section>
      )}

      {!!recharges.length && (
        <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
          <p className="text-sm font-medium">{t("wallet.split_title", "充值分项")}</p>
          <ul className="flex flex-col gap-2">
            {recharges.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <b>{methodLabel(config?.pay_channels, p.method, t)}</b>
                  <Badge variant={p.status === "CONFIRMED" ? "default" : p.status === "REJECTED" || p.status === "EXPIRED" ? "outline" : "secondary"}>
                    {t("status.pay_row." + p.status, PAYMENT_ROW_TEXT[p.status] ?? p.status)}
                  </Badge>
                  <span className="ml-auto font-medium">{money(p.amount_currency, symbolOf(currencies, p.currency_code))}</span>
                  <span className="text-xs text-muted-foreground">{fmtTime(p.created_at)}</span>
                </div>
                {p.reject_reason && <p className="text-xs text-destructive">{t("wallet.reject_reason", "驳回原因：")}{p.reject_reason}</p>}
                {["PENDING_SUBMIT", "REJECTED"].includes(p.status) && (
                  <ProofUploadForm payment={p} chainIndex={coinIdx} onDone={() => { setTicket(null); void load(0, false); }} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
        <p className="text-sm font-medium">{t("wallet.txn_title", "余额流水")}</p>
        <ul className="flex flex-col divide-y">
          {(overview?.items ?? []).map((txn) => (
            <li key={txn.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="w-24 shrink-0">{t("status.txn." + txn.txn_type, txn.txn_type)}</span>
              <span className={(txn.amount >= 0 ? "font-medium text-primary" : "font-medium text-destructive") + " w-28 shrink-0"}>
                {txn.amount >= 0 ? "+" : ""}{shown(txn.amount)}
              </span>
              <span className="flex-1 truncate text-xs text-muted-foreground" title={dataText(txn.remark, text)}>{dataText(txn.remark, text)}</span>
              <span className="text-xs text-muted-foreground">{t("wallet.balance_prefix", "余 ")}{shown(txn.balance_after)}</span>
              <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">{fmtTime(txn.created_at)}</span>
            </li>
          ))}
          {!overview?.items.length && <li className="py-4 text-center text-sm text-muted-foreground">{t("wallet.txn_empty", "暂无余额变动")}</li>}
        </ul>
        {overview?.has_more && nextOffset !== null && (
          <Button variant="outline" size="sm" className="self-center" disabled={loading} onClick={() => void load(nextOffset, true)}>
            {loading ? t("common.loading", "加载中…") : t("wallet.txn_more", "加载更多流水")}
          </Button>
        )}
      </section>
    </div>
  );
}
