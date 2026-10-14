// 我的订单 O2（tab 聚合 + 计数 + 分页 + HB1 惰性心跳）
import { useEffect, useState } from "react";
import { call } from "../api";
import { Link, navigate, RedirectTo, useQuery } from "../router";
import { useSite } from "../site";
import { formatBase, getBaseCode } from "../const";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { ProductCover } from "../components/ProductCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DISPLAY_TEXT, ORDER_STATUS_TEXT, fmtTime, lazyTick, useDeadline, type OrderLine, type OrderRow } from "../trade";

interface OrderPage {
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: Array<OrderRow & { items: OrderLine[]; item_count: number }>;
  counts_by_status: Record<string, number>;
}

// 第 3 位为语言包 key（tab key/后端状态保持不变；orders.tab_* 四语包内已有，不再保留中文兜底）
const TABS: [string, string, string][] = [
  ["all", "", "orders.tab_all"],
  ["pending_payment", "PENDING_PAYMENT", "orders.tab_pending"],
  ["unshipped", "PAID", "orders.tab_unshipped"],
  ["shipped", "SHIPPED", "orders.tab_shipped"],
  ["completed", "COMPLETED", "orders.tab_completed"],
  ["cancelled", "CANCELLED", "orders.tab_cancelled"],
];

function OrderCard({ order }: { order: OrderRow & { items: OrderLine[]; item_count: number } }) {
  const { t, tf } = useSite();
  const pay = order.status_display === "pending_payment";
  const { text } = useDeadline(pay || order.status_display === "payment_rejected" ? order.payment_deadline : null, order.expired === true);
  const badge = order.status_display === "pending_review"
    ? "secondary" : order.status_display === "completed"
      ? "outline" : "default";
  return (
    <li className="flex flex-col gap-3 border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2 border-b pb-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground">{order.order_no}</span>
        <span className="text-xs text-muted-foreground">{fmtTime(order.created_at)}</span>
        {text && <span className="text-xs font-medium text-destructive">{text}</span>}
        <Badge variant={badge as "default" | "secondary" | "outline"} className="ml-auto">{t("status.disp." + (order.status_display ?? ""), DISPLAY_TEXT[order.status_display ?? ""] ?? ORDER_STATUS_TEXT[order.status_order] ?? t("nav.orders", "订单"))}</Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {order.items.map((line) => (
          <li key={line.id} className="flex items-center gap-3">
            <span className="size-12 shrink-0 overflow-hidden border bg-muted">
              <ProductCover imageKey={line.image_snapshot?.[0]} alt={line.title_snapshot} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <Link to={`/product?id=${line.product_id}`} className="truncate text-sm hover:text-primary">{line.title_snapshot}</Link>
              <span className="text-xs text-muted-foreground">{line.spec_snapshot} · ×{line.quantity}</span>
            </span>
            <span className="text-sm">{formatBase(line.price_base_snapshot)}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
        <span className="text-muted-foreground">{tf("orders.item_count", { n: order.item_count }, "共 {n} 种")}</span>
        <span>{t("orders.paid", "实付")} <b className="text-primary">{formatBase(order.actual_paid_amount_base)}</b>
          {order.currency_code !== getBaseCode() ? <span className="ml-1 text-xs text-muted-foreground">{tf("common.paren", { v: order.currency_name_snapshot ?? order.currency_code }, "（{v}）")}</span> : null}
        </span>
        <div className="ml-auto flex gap-2">
          {pay && <Button size="sm" onClick={() => navigate(`/order?id=${order.id}`)}>{t("orders.pay_now", "去支付")}</Button>}
          <Button size="sm" variant="outline" onClick={() => navigate(`/order?id=${order.id}`)}>{t("orders.detail", "详情")}</Button>
        </div>
      </div>
    </li>
  );
}

export function OrdersPage() {
  const { user, ready, t } = useSite();
  const query = useQuery();
  const initialTab = TABS.some((t) => t[0] === query.tab) ? (query.tab as string) : "all";
  const [tab, setTab] = useState(initialTab);
  const [offset, setOffset] = useState(0);
  const [pages, setPages] = useState<OrderPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void lazyTick("user");
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    call<OrderPage>("order/list", { token: "user", query: { tab, offset } })
      .then((r) => {
        if (!alive) return;
        setPages((prev) => (offset === 0 ? [r] : [...prev, r]));
      })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error && e.message ? e.message : t("orders.load_failed", "订单加载失败")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, offset]);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("orders.loading", "正在加载订单…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  const items = pages.flatMap((p) => p.items);
  const counts = pages[0]?.counts_by_status ?? {};
  const hasMore = pages.some((p) => p.has_more);
  const nextOffset = pages.length ? (pages[pages.length - 1].next_offset ?? null) : null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      {/* —— 头部：左上角 ← 返回「我的」+ 标题 + 钱包入口 —— */}
      <SubHeader
        title={t("orders.title", "我的订单")}
        extra={<Link to="/wallet" className="text-primary underline">{t("orders.wallet_link", "钱包与充值")}</Link>}
      />

      {/* —— 状态过滤行（扁平直角，选中态绿色填充）—— */}
      <div className="flex flex-wrap gap-2 text-sm">
        {TABS.map(([key, statusKey, i18nKey]) => (
          <button
            key={key}
            type="button"
            onClick={() => { setTab(key); setOffset(0); setPages([]); }}
            className={"border px-4 py-1.5 transition " + (tab === key ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}
          >
            {t(i18nKey)}
            {statusKey && counts[statusKey] ? <span className="ml-1 opacity-80">({counts[statusKey]})</span> : null}
          </button>
        ))}
      </div>

      {loading && !items.length && <div className="grid place-items-center py-16"><CartLoading label={t("orders.loading", "正在加载订单…")} /></div>}
      {error && <p className="border bg-card px-4 py-3 text-sm text-destructive">{error}</p>}
      {!loading && !error && !items.length && (
        <div className="grid place-items-center gap-3 border bg-card py-14 text-center">
          <CartLoading label={t("orders.empty", "暂无相关订单")} />
          <Link to="/category" className="border border-primary bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground">{t("orders.browse", "去逛逛商品")}</Link>
        </div>
      )}

      {!!items.length && (
        <ul className="flex flex-col gap-3">
          {items.map((o) => <OrderCard key={o.id} order={o} />)}
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
