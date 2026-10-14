// 我的券包 CP1（状态标签 + 计数 + 分页 + HB1 惰性心跳）
import { useEffect, useState } from "react";
import { call } from "../api";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { formatBase, pickLocalized } from "../const";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  COUPON_SCOPE_TEXT, COUPON_STATUS_TEXT, COUPON_TYPE_TEXT, couponRuleText, fmtDate, lazyTick,
  type CouponPage, type CouponRow,
} from "../trade";

const TABS: string[] = ["", "UNUSED", "LOCKED", "USED", "EXPIRED", "REVOKED"];

const BADGE: Record<string, "default" | "secondary" | "outline"> = {
  UNUSED: "default", LOCKED: "secondary", USED: "secondary", EXPIRED: "outline", REVOKED: "outline",
};

function CouponCard({ coupon }: { coupon: CouponRow }) {
  const { t, tf, lang } = useSite();
  const usable = coupon.status === "UNUSED";
  return (
    <li className={
      "flex overflow-hidden rounded-2xl border bg-card transition "
      + (usable ? "border-primary/50" : "opacity-70")
    }>
      <div className={"flex w-28 shrink-0 flex-col items-center justify-center border-r border-dashed px-2 py-4 text-center "
        + (usable ? "border-primary/50 bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
        <span className="text-[11px]">{t("status.coupon_type." + coupon.coupon_type, COUPON_TYPE_TEXT[coupon.coupon_type])}</span>
        <span className="mt-1 text-xl font-bold tabular-nums">{formatBase(coupon.discount_amount_base)}</span>
        {coupon.coupon_type === "threshold" && (
          <span className="text-[11px] opacity-80">{tf("coupon.min_spend", { amt: formatBase(coupon.threshold_amount_base) }, "满 {amt}")}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-bold">{pickLocalized(coupon.name_i18n, coupon.name, lang) || t("coupon.withdrawn", "券已下架")}</span>
          <Badge variant={BADGE[coupon.status] ?? "outline"}>{t("status.coupon." + coupon.status, COUPON_STATUS_TEXT[coupon.status] ?? coupon.status)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{t("status.scope." + coupon.scope, COUPON_SCOPE_TEXT[coupon.scope])} · {tf("status.coupon_rule." + coupon.coupon_type, { a: formatBase(coupon.threshold_amount_base), b: formatBase(coupon.discount_amount_base) }, couponRuleText(coupon))}</p>
        <p className="text-xs text-muted-foreground">{tf("coupon.valid_until", { date: fmtDate(coupon.expire_at) }, "有效期至 {date}")}</p>
        <div className="mt-1 flex items-center gap-3 text-sm">
          {usable && <Link to="/cart" className="font-medium text-primary underline">{t("coupon.use_in_cart", "去购物车使用")}</Link>}
          {coupon.order_id && <Link to={`/order?id=${coupon.order_id}`} className="text-primary underline">{t("coupon.view_order", "查看关联订单")}</Link>}
          <span className="ml-auto text-xs text-muted-foreground">{tf("coupon.received_on", { date: fmtDate(coupon.created_at) }, "领取于 {date}")}</span>
        </div>
      </div>
    </li>
  );
}

export function CouponsPage() {
  const { user, ready, t } = useSite();
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [pages, setPages] = useState<CouponPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void lazyTick("user");
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    call<CouponPage>("coupon/my", { token: "user", query: { status: status || undefined, offset } })
      .then((r) => {
        if (!alive) return;
        setPages((prev) => (offset === 0 ? [r] : [...prev, r]));
      })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error && e.message ? e.message : t("coupon.load_failed", "券包加载失败")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [status, offset]);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("coupon.loading", "正在加载券包…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  const items = pages.flatMap((p) => p.items);
  const counts = pages[0]?.counts_by_status ?? {};
  const hasMore = pages.some((p) => p.has_more);
  const nextOffset = pages.length ? (pages[pages.length - 1].next_offset ?? null) : null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <SubHeader
        title={t("me.link_coupons", "我的券包")}
        extra={<>
          <Link to="/coupons/center" className="text-primary underline">{t("home.nav_coupon_center", "领券中心")}</Link>
          <Link to="/orders" className="text-primary underline">{t("orders.title", "我的订单")}</Link>
        </>}
      />

      <div className="flex flex-wrap gap-2 text-sm">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => { setStatus(key); setOffset(0); setPages([]); }}
            className={"rounded-md border px-4 py-1 transition " + (status === key ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}
          >
            {key ? t("status.coupon." + key, COUPON_STATUS_TEXT[key]) : t("common.all", "全部")}
            {key && counts[key] ? <span className="ml-1 opacity-80">({counts[key]})</span> : null}
          </button>
        ))}
      </div>

      {loading && !items.length && <div className="grid place-items-center py-16"><CartLoading label={t("coupon.loading", "正在加载券包…")} /></div>}
      {error && <p className="rounded-xl border bg-card px-4 py-3 text-sm text-destructive">{error}</p>}
      {!loading && !error && !items.length && (
        <div className="grid place-items-center gap-3 rounded-2xl border bg-card py-14 text-center">
          <CartLoading label={t("coupon.empty", "券包里还没有优惠券")} />
          <p className="text-sm text-muted-foreground">{t("coupon.empty_hint", "优惠券由平台活动或后台发放，领取后会出现在这里。")}</p>
          <div className="flex gap-3">
            <Link to="/coupons/center" className="rounded-md brand-gradient px-5 py-1.5 text-sm font-medium text-white shadow-md shadow-primary/40">{t("coupon.go_center", "去领券中心")}</Link>
            <Link to="/category" className="rounded-md border bg-card px-5 py-1.5 text-sm hover:border-primary">{t("orders.browse", "去逛逛商品")}</Link>
          </div>
        </div>
      )}

      {!!items.length && (
        <ul className="flex flex-col gap-3">
          {items.map((c) => <CouponCard key={c.coupon_id} coupon={c} />)}
        </ul>
      )}

      {hasMore && nextOffset !== null && (
        <Button variant="outline" className="self-center" disabled={loading} onClick={() => setOffset(nextOffset)}>
          {loading ? t("common.loading", "加载中…") : t("common.loading_more", "加载更多")}
        </Button>
      )}
    </div>
  );
}
