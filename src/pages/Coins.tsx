// 金币中心（文档F；购物端 CI1 概览 + CI2 签到 + CI3/CI4/CI5 兑换专区）
// 版式沿用会员/钱包页的扁平直角：分区靠细分隔线，兑换走轻量弹层；实物兑换在本机选收货地址
import { useCallback, useEffect, useState } from "react";
import { call, newIdem } from "../api";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { text } from "../i18n";
import { dataText } from "../data-text";
import { formatBase, pickLocalized } from "../const";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { oneLine } from "../components/AddressFields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  REDEEM_BLOCKED_TEXT, COIN_ITEM_TYPE_TEXT, COIN_TXN_TEXT, bonusScheduleText, coinText, orderRewardText,
  type CheckinResult, type CoinItemCard, type CoinItemDetail, type CoinOverview, type RedeemResult,
} from "../coins";
import { fmtDate, lazyTick, rateText, shopErr, type AddressRow } from "../trade";

const TYPE_TABS: string[] = ["", "coupon", "vip", "physical"];

function CoinCover({ url, alt }: { url: string | undefined; alt: string }) {
  if (!url) {
    return (
      <span className="grid size-full place-items-center bg-muted text-muted-foreground/40" aria-hidden>
        <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="8" /><path d="M12 8v8M9.5 10.5h3a1.5 1.5 0 0 1 0 3h-3" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return <img src={url} alt={alt} className="size-full object-cover" loading="lazy" />;
}

function ItemTile({ item, onOpen }: { item: CoinItemCard; onOpen: () => void }) {
  const { t, tf, lang } = useSite();
  const stockNote = item.stock_mode === "unlimited"
    ? t("coin.unlimited", "不限量")
    : tf("coin.left_n", { n: coinText(item.stock_available ?? 0) }, "剩 {n} 件");
  const title = pickLocalized(item.title_i18n, item.title, lang);
  return (
    <div className="flex flex-col border border-border/70">
      <button type="button" onClick={onOpen} className="relative block aspect-square overflow-hidden bg-muted text-left">
        <CoinCover url={item.image_urls[0]} alt={title} />
        <span className="absolute left-0 top-0 bg-foreground/75 px-1.5 py-0.5 text-[11px] text-background">{t("coin.kind." + item.item_type, COIN_ITEM_TYPE_TEXT[item.item_type] ?? item.item_type)}</span>
      </button>
      <div className="flex flex-1 flex-col gap-1 p-2">
        <p className="line-clamp-2 min-h-[2.5em] text-sm font-medium leading-tight">{title}</p>
        <p className="flex items-baseline gap-1 text-primary"><b className="text-base tabular-nums">{coinText(item.coin_price)}</b><span className="text-xs">{t("coin.unit", "金币")}</span></p>
        <p className="text-[11px] text-muted-foreground">{stockNote}{item.per_user_limit > 0 ? tf("coin.per_user_limit", { n: item.per_user_limit }, " · 每人限 {n}") : ""}</p>
        <Button size="sm" className="mt-1" disabled={!item.can_redeem} onClick={onOpen}>
          {item.can_redeem ? t("coin.redeem", "兑换") : t("coin.blocked." + (item.blocked_reason ?? ""), REDEEM_BLOCKED_TEXT[item.blocked_reason ?? ""] ?? t("coin.not_redeemable", "不可兑换"))}
        </Button>
      </div>
    </div>
  );
}

function RedeemDialog({ itemId, onClose, onDone }: { itemId: string; onClose: () => void; onDone: (r: RedeemResult) => void }) {
  const { t, tf, lang } = useSite();
  const [detail, setDetail] = useState<CoinItemDetail | null>(null);
  const [addresses, setAddresses] = useState<AddressRow[]>([

]);
  const [addrId, setAddrId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    call<CoinItemDetail>("coin/item", { token: "user", query: { id: itemId } })
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        if (d.item_type === "physical") {
          call<{ items: AddressRow[] }>("address/list", { token: "user" })
            .then((a) => {
              if (!alive) return;
              setAddresses(a.items);
              const def = a.items.find((x) => x.is_default) ?? a.items[0];
              if (def) setAddrId(def.id);
            })
            .catch(() => { /* 地址拉取失败：下方给出提示并可重试兑换 */ });
        }
      })
      .catch((e: unknown) => { if (alive) setError(shopErr(e)); });
    return () => { alive = false; };
  }, [itemId]);

  async function redeem() {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const r = await call<RedeemResult>("coin/redeem", {
        method: "POST", token: "user", idem: newIdem(),
        body: { item_id: detail.id, ...(detail.item_type === "physical" ? { address_id: addrId } : {}) },
      });
      onDone(r);
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setBusy(false);
    }
  }

  const needAddr = detail?.item_type === "physical";
  // 权益项若回读不到套餐（套餐被删），兑换必然在 CI5 报配置错误 ⇒ 直接不给点
  const vipPlanGone = detail?.item_type === "vip" && !detail.vip;
  const confirmDisabled = !detail || !detail.can_redeem || busy || vipPlanGone || (needAddr && !addrId);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal>
      <div className="flex max-h-[86vh] w-full max-w-md flex-col overflow-y-auto border border-border/70 bg-background" onClick={(e) => e.stopPropagation()}>
        {!detail && !error && <div className="grid place-items-center py-16"><CartLoading label={t("coin.detail_loading", "加载兑换详情…")} /></div>}
        {error && !detail && <p className="px-4 py-6 text-sm text-destructive">{error}</p>}
        {detail && (
          <>
            <div className="relative aspect-video w-full overflow-hidden bg-muted">
              <CoinCover url={detail.image_urls[0]} alt={pickLocalized(detail.title_i18n, detail.title, lang)} />
            </div>
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2">
                    <b className="truncate text-base">{pickLocalized(detail.title_i18n, detail.title, lang)}</b>
                    <Badge variant="secondary">{t("coin.kind." + detail.item_type, COIN_ITEM_TYPE_TEXT[detail.item_type] ?? detail.item_type)}</Badge>
                  </p>
                  {detail.description && <p className="mt-1 text-xs text-muted-foreground">{detail.description}</p>}
                </div>
                <span className="shrink-0 text-right text-primary"><b className="text-lg tabular-nums">{coinText(detail.coin_price)}</b><br /><span className="text-[11px]">{t("coin.unit", "金币")}</span></span>
              </div>

              {detail.item_type === "coupon" && detail.coupon && (
                <div className="border-t border-dashed pt-3 text-sm">
                  <p className="font-medium">{pickLocalized(detail.coupon.name_i18n, detail.coupon.name, lang) || t("coupon.withdrawn", "券已下架")}</p>
                  <p className="text-xs text-muted-foreground">
                    {detail.coupon.coupon_type === "threshold" ? tf("status.coupon_rule.threshold", { a: formatBase(detail.coupon.threshold_amount_base), b: formatBase(detail.coupon.discount_amount_base) }, "满 {a} 减 {b}") : tf("status.coupon_rule.direct", { b: formatBase(detail.coupon.discount_amount_base) }, "立减 {b}")}
                    {" · "}
                    {detail.coupon.valid_days > 0
                      ? tf("coin.valid_days", { n: detail.coupon.valid_days }, "领取后 {n} 天内有效")
                      : detail.coupon.valid_until
                        ? tf("coin.valid_until", { date: fmtDate(detail.coupon.valid_until) }, "有效期至 {date}")
                        : t("coin.valid_long", "长期有效")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{t("coin.coupon_to_pack", "兑换成功后自动放入「我的券包」。")}</p>
                </div>
              )}
              {detail.item_type === "vip" && (
                <div className="border-t border-dashed pt-3 text-sm">
                  <p className="font-medium">{detail.vip
                    ? pickLocalized(detail.vip.name_i18n, detail.vip.name, lang)
                    : t("coin.vip_plan_missing", "该权益关联的会员套餐已不可用")}</p>
                  {detail.vip && (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {tf("coin.vip_days", { n: detail.vip_duration_days ?? 0 }, "兑换即发放 {n} 天会员")}
                        {" · "}{rateText(detail.vip.discount_rate)}
                      </p>
                      {!!detail.vip.benefits.length && (
                        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                          {detail.vip.benefits.map((b) => <li key={b}>· {b}</li>)}
                        </ul>
                      )}
                    </>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">{t("coin.vip_after_redeem", "权益立即生效；已在会员期内则从原到期日顺延。会员时长发放后不可撤销。")}</p>
                </div>
              )}
              {needAddr && (
                <div className="flex flex-col gap-2 border-t border-dashed pt-3">
                  <p className="text-sm font-medium">{t("checkout.address", "收货地址")}</p>
                  {!addresses.length && <p className="text-xs text-muted-foreground">{t("coin.no_address", "还没有收货地址，请先在结算页添加后再来兑换。")}</p>}
                  {addresses.map((a) => (
                    <label key={a.id} className="flex cursor-pointer items-start gap-2 text-sm">
                      <input type="radio" name="coin-addr" className="mt-1 accent-[var(--primary)]" checked={addrId === a.id} onChange={() => setAddrId(a.id)} />
                      <span className={oneLine(a) + (addrId === a.id ? " text-primary" : "")}>{oneLine(a)}{a.is_default ? t("coin.default_tag", "（默认）") : ""}</span>
                    </label>
                  ))}
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {tf("coin.redeemed_n", { n: detail.redeemed_count_by_user }, "已兑 {n}")}{detail.per_user_limit > 0 ? tf("coin.limit_n", { n: detail.per_user_limit }, " / 限 {n}") : ""}
                {detail.stock_mode === "limited" ? " · " + tf("coin.stock_n", { n: coinText(detail.stock_available ?? 0) }, "库存 {n}") : " · " + t("coin.unlimited", "不限量")}
              </p>
              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="mt-1 flex gap-2">
                <Button variant="outline" className="flex-1" onClick={onClose} disabled={busy}>{t("common.close", "关闭")}</Button>
                <Button className="flex-1" disabled={confirmDisabled} onClick={() => void redeem()}>
                  {busy ? t("coin.redeeming", "兑换中…") : vipPlanGone ? t("coin.vip_unavailable", "暂不可兑换") : detail.can_redeem ? tf("coin.confirm_spend", { n: coinText(detail.coin_price) }, "确认消耗 {n} 金币") : t("coin.blocked." + (detail.blocked_reason ?? ""), REDEEM_BLOCKED_TEXT[detail.blocked_reason ?? ""] ?? t("coin.not_redeemable", "不可兑换"))}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function CoinsPage() {
  const { user, config, ready, t, tf } = useSite();
  const [type, setType] = useState("");
  const [overview, setOverview] = useState<CoinOverview | null>(null);
  const [items, setItems] = useState<CoinItemCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [openItem, setOpenItem] = useState("");

  const enabled = config?.switches?.coins === true;

  const load = useCallback(async (itemType: string) => {
    setLoading(true);
    try {
      const [ov, it] = await Promise.all([
        call<CoinOverview>("coin/overview", { token: "user" }),
        call<{ items: CoinItemCard[] }>("coin/items", { token: "user", query: { item_type: itemType || undefined } }),
      ]);
      setOverview(ov);
      setItems(it.items);
      setError("");
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void lazyTick("user"); }, []);
  useEffect(() => { if (ready && user && enabled) void load(type); }, [ready, user, enabled, type, load]);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("coin.loading", "正在加载金币中心…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;
  if (!enabled) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        <SubHeader title={t("me.link_coins", "金币中心")} />
        <p className="text-center text-muted-foreground">{t("coin.disabled", "金币功能当前未开启。")}</p>
      </div>
    );
  }

  async function checkin() {
    setCheckinBusy(true);
    setNotice("");
    setError("");
    try {
      const r = await call<CheckinResult>("coin/checkin", { method: "POST", token: "user", idem: newIdem(), body: {} });
      setNotice(tf("coin.checkin_ok", { streak: r.streak_days, amount: coinText(r.reward_amount) }, "签到成功：连续第 {streak} 天，+{amount} 金币") + (r.bonus_amount > 0 ? tf("coin.checkin_bonus", { amount: coinText(r.bonus_amount) }, "（含连签加成 {amount}）") : ""));
      await load(type);
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setCheckinBusy(false);
    }
  }

  const bonusText = bonusScheduleText(overview?.rules.bonus_schedule);
  const orderText = overview?.rules.order_reward_enabled ? orderRewardText(overview.rules.order_reward_rate_bp) : "";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
      <SubHeader
        title={t("me.link_coins", "金币中心")}
        extra={<Link to="/coins/redemptions" className="text-primary underline">{t("coin.my_redemptions", "我的兑换")}</Link>}
      />

      {error && <p className="border-y border-border/70 px-1 py-3 text-sm text-destructive">{error}</p>}

      {/* 余额带：品牌绿整幅，不套圆角卡片 */}
      <section className="brand-gradient flex flex-col gap-1 px-5 py-5 text-white">
        <span className="text-xs opacity-90">{t("coin.my_coins", "我的金币")}</span>
        <span className="text-3xl font-bold tabular-nums">{overview ? coinText(overview.balance) : "—"}</span>
        <span className="text-xs opacity-85">{tf("coin.total_earned_spent", { earned: overview ? coinText(overview.total_earned) : "—", spent: overview ? coinText(overview.total_spent) : "—" }, "累计获得 {earned} · 累计消耗 {spent}")}</span>
      </section>

      {/* 签到 */}
      <section className="flex flex-col gap-2 border-b border-border/70 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{t("coin.type.checkin", "每日签到")}</p>
          {overview?.checked_in_today ? (
            <span className="text-sm text-muted-foreground">{tf("coin.checked_in_today", { amount: coinText(overview.today_reward_base) }, "今日已签到 +{amount} 金币")}</span>
          ) : (
            <Button size="sm" disabled={checkinBusy || loading} onClick={() => void checkin()}>{checkinBusy ? t("coin.checking_in", "签到中…") : t("coin.checkin_now", "立即签到")}</Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("coin.streak_label", "连续签到")} <b className="text-primary">{overview ? coinText(overview.streak_days) : "0"}</b> {t("coin.streak_unit", "天")}{bonusText ? ` · ${bonusText}` : ""}</p>
        {orderText && <p className="text-xs text-muted-foreground">{orderText}{t("coin.order_reward_suffix", "（完成订单后自动到账）")}</p>}
        {notice && <p className="text-sm text-primary">{notice}</p>}
      </section>

      {/* 兑换专区 */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2 text-sm">
          {TYPE_TABS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => { setType(key); setNotice(""); }}
              className={"border px-4 py-1 transition " + (type === key ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}
            >
              {key === "" ? t("common.all", "全部") : t("coin.kind." + key, COIN_ITEM_TYPE_TEXT[key])}
            </button>
          ))}
        </div>

        {loading && !items.length && <div className="grid place-items-center py-14"><CartLoading label={t("coin.store_loading", "正在加载兑换专区…")} /></div>}
        {!loading && !items.length && (
          <div className="flex flex-col items-center gap-2 border border-border/70 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("coin.store_empty", "兑换专区还没有可售项。")}</p>
          </div>
        )}
        {!!items.length && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((item) => <ItemTile key={item.id} item={item} onOpen={() => setOpenItem(item.id)} />)}
          </div>
        )}
      </section>

      {/* 金币流水 */}
      {!!overview?.items.length && (
        <section className="flex flex-col gap-2 border-t border-border/70 pt-4">
          <p className="text-sm font-medium">{t("coin.detail_title", "金币明细")}</p>
          <ul className="flex flex-col divide-y">
            {overview.items.slice(0, 8).map((txn) => (
              <li key={txn.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="w-20 shrink-0">{t("coin.type." + txn.txn_type, COIN_TXN_TEXT[txn.txn_type] ?? txn.txn_type)}</span>
                <span className={(txn.amount >= 0 ? "text-primary" : "text-destructive") + " w-24 shrink-0 font-medium tabular-nums"}>
                  {txn.amount >= 0 ? "+" : ""}{coinText(txn.amount)}
                </span>
                <span className="flex-1 truncate text-xs text-muted-foreground" title={dataText(txn.remark, text)}>{dataText(txn.remark, text)}</span>
                <span className="text-xs text-muted-foreground">{t("wallet.balance_prefix", "余 ")}{coinText(txn.balance_after)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {openItem && (
        <RedeemDialog
          itemId={openItem}
          onClose={() => setOpenItem("")}
          onDone={(r) => {
            setOpenItem("");
            setNotice(
              r.item_type === "coupon" ? t("coin.redeemed_coupon", "兑换成功，优惠券已放入「我的券包」。")
                : r.item_type === "vip" ? tf("coin.redeemed_vip", { date: r.vip_expire_at ? fmtDate(r.vip_expire_at) : "—" }, "兑换成功，会员权益已到账，有效期至 {date}。")
                  : t("coin.redeemed_physical", "兑换成功，已提交发货，可在「我的兑换」查看进度。"),
            );
            void load(type);
          }}
        />
      )}
    </div>
  );
}
