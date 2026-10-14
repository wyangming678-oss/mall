// 领券中心 CP3/CP4（A2）：浏览可自助领取的券模板并领取，领取后进「我的券包」
import { useCallback, useEffect, useState } from "react";
import { call, newIdem } from "../api";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { formatBase, pickLocalized } from "../const";
import { CartLoading } from "../components/CartLoading";
import { Button } from "@/components/ui/button";
import {
  COUPON_SCOPE_TEXT, COUPON_TYPE_TEXT, couponRuleText, fmtDate, shopErr,
  type CouponCenterItem, type CouponCenterResult,
} from "../trade";

type TFunc = (key: string, fallback?: string) => string;
type TfFunc = (key: string, vars: Record<string, string | number>, fallback?: string) => string;

function validText(tpl: CouponCenterItem, tf: TfFunc): string {
  if (tpl.valid_days > 0) return tf("coupon.valid_days", { n: tpl.valid_days }, "领取后 {n} 天内有效");
  if (tpl.valid_until) {
    return tpl.valid_from
      ? tf("coupon.valid_between", { from: fmtDate(tpl.valid_from), to: fmtDate(tpl.valid_until) }, "{from} 起，{to} 前有效")
      : tf("coupon.valid_until", { date: fmtDate(tpl.valid_until) }, "有效期至 {date}");
  }
  return tf("coupon.valid_long", {}, "长期有效");
}

function claimState(tpl: CouponCenterItem, t: TFunc): { label: string; disabled: boolean } {
  if (tpl.sold_out) return { label: t("coupon.sold_out", "已领完"), disabled: true };
  if (tpl.my_held >= tpl.per_user_limit) return { label: t("status.coupon_reason.quota_reached", "已达领取上限"), disabled: true };
  return { label: t("coupon.claim_now", "立即领取"), disabled: false };
}

export function CouponCenterPage() {
  const { user, ready, t, tf, lang } = useSite();
  const [items, setItems] = useState<CouponCenterItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    setError("");
    call<CouponCenterResult>("coupon/center", { token: "user" })
      .then((r) => setItems(r.items))
      .catch((e: unknown) => { setError(shopErr(e)); setItems([]); });
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, load]);

  async function claim(tpl: CouponCenterItem) {
    if (busy) return;
    setBusy(tpl.template_id);
    setNotice("");
    try {
      const r = await call<{ granted: boolean; duplicated: boolean }>("coupon/claim", {
        method: "POST", token: "user", idem: newIdem(), body: { template_id: tpl.template_id },
      });
      setNotice(r.granted ? tf("coupon.claimed_ok", { name: pickLocalized(tpl.name_i18n, tpl.name, lang) }, "已领取「{name}」，可在我的券包查看") : t("coupon.claimed_dup", "该券此前已领取"));
      load();
    } catch (e: unknown) {
      setNotice(shopErr(e));
    } finally {
      setBusy(null);
    }
  }

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("coupon.center_loading", "正在加载领券中心…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  return (
    <div className="mx-auto flex max-w-4xl flex-col px-4 py-6">
      <div className="flex items-center justify-between border-b border-border/70 pb-3">
        <h1 className="text-lg font-bold">{t("home.nav_coupon_center", "领券中心")}</h1>
        <div className="flex gap-3 text-sm">
          <Link to="/coupons" className="text-primary underline">{t("me.link_coupons", "我的券包")}</Link>
          <Link to="/me" className="text-muted-foreground underline">{t("common.account_center", "账户中心")}</Link>
        </div>
      </div>

      {notice && (
        <p className="mt-3 border-l-2 border-primary bg-primary/10 px-3 py-2 text-sm text-foreground">{notice}</p>
      )}

      {error && <p className="mt-3 py-6 text-center text-sm text-destructive">{error}</p>}
      {!error && items === null && (
        <div className="grid place-items-center py-16"><CartLoading label={t("coupon.center_loading", "正在加载领券中心…")} /></div>
      )}
      {!error && items && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 border-b border-border/70 py-16 text-center">
          <p className="text-sm text-muted-foreground">{t("coupon.center_empty", "当前没有可领取的优惠券")}</p>
          <p className="max-w-md text-xs text-muted-foreground">{t("coupon.center_empty_hint", "优惠券由平台活动或后台发放，可领取的券会出现在这里。")}<Link to="/category" className="text-primary underline">{t("orders.browse", "去逛逛商品")}</Link></p>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="divide-y divide-border/70">
          {items.map((tpl) => {
            const st = claimState(tpl, t);
            return (
              <li key={tpl.template_id} className="flex items-center gap-4 py-4">
                <div className="flex w-24 shrink-0 flex-col items-center border-r border-dashed border-border/70 pr-4 text-center">
                  <span className="text-[11px] text-muted-foreground">{t("status.coupon_type." + tpl.coupon_type, COUPON_TYPE_TEXT[tpl.coupon_type])}</span>
                  <span className="mt-0.5 text-xl font-bold tabular-nums text-primary">{formatBase(tpl.discount_amount_base)}</span>
                  {tpl.coupon_type === "threshold" && (
                    <span className="text-[11px] text-muted-foreground">{tf("coupon.min_spend", { amt: formatBase(tpl.threshold_amount_base) }, "满 {amt}")}</span>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-bold">{pickLocalized(tpl.name_i18n, tpl.name, lang)}</span>
                  <p className="text-xs text-muted-foreground">
                    {t("status.scope." + tpl.scope, COUPON_SCOPE_TEXT[tpl.scope])} · {tf("status.coupon_rule." + tpl.coupon_type, { a: formatBase(tpl.threshold_amount_base), b: formatBase(tpl.discount_amount_base) }, couponRuleText(tpl))} · {validText(tpl, tf)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {tpl.unlimited ? t("coupon.unlimited", "不限量发放") : tf("coupon.quota_left", { left: tpl.remaining_quota ?? 0, total: tpl.total_quota ?? 0 }, "剩余 {left} / 共 {total}")}
                    {tpl.per_user_limit > 1 ? tf("coupon.per_user_multi", { n: tpl.per_user_limit, m: tpl.my_held }, " · 每人限领 {n} 张（已领 {m}）") : tpl.my_held ? t("coupon.per_user_one_taken", " · 每人限领 1 张（已领）") : t("coupon.per_user_one", " · 每人限领 1 张")}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="w-24 shrink-0"
                  variant={st.disabled ? "outline" : "default"}
                  disabled={st.disabled || busy === tpl.template_id}
                  onClick={() => void claim(tpl)}
                >
                  {busy === tpl.template_id ? t("coupon.claiming", "领取中…") : st.label}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
