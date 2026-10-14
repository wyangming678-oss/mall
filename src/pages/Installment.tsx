// 分期专区（文档N D6：独立 /installment 专区，开关 config.switches.installment）+ 我的分期账单栏（IB2）
// 版式沿用金币/钱包页扁平直角：细分隔线分区，进度条实色，逾期用破坏色。
import { useCallback, useEffect, useState } from "react";
import { call } from "../api";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { formatBase } from "../const";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { ProductCard } from "../components/ProductCard";
import { Button } from "@/components/ui/button";
import { useCatalogProducts } from "../catalog";
import { fmtDate, fmtTime, shopErr } from "../trade";
import type { InstallmentMyItem } from "../installments";

interface MyPage { items: InstallmentMyItem[]; has_more: boolean; next_offset: number | null }

function Progress({ paid, n }: { paid: number; n: number }) {
  const pct = n > 0 ? Math.round((paid / n) * 100) : 0;
  return (
    <div className="h-1.5 w-full bg-muted" role="progressbar" aria-valuenow={paid} aria-valuemin={0} aria-valuemax={n}>
      <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function InstallmentPage() {
  const { config, ready, t } = useSite();
  const enabled = config?.switches?.installment === true;
  const { items, loading, error, hasMore, loadMore } = useCatalogProducts({ installment: true });

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("installment.loading", "正在加载…")} /></div>;
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <SubHeader
        title={t("installment.zone_title", "分期专区")}
        back="/"
        extra={<Link to="/installment/my" className="text-primary underline">{t("installment.my_title", "我的分期")}</Link>}
      />
      {!enabled ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("installment.zone_disabled", "分期功能当前未开启。")}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("installment.zone_note", "支持分期的商品可选 2/3/6/9/12 期，首付 30% 到账即发货，尾款按月支付、0 利息。")}</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {loading && !items.length && <div className="grid place-items-center py-14"><CartLoading label={t("installment.store_loading", "正在加载分期商品…")} /></div>}
          {!loading && !items.length && (
            <div className="flex flex-col items-center gap-2 border border-border/70 py-12 text-center">
              <p className="text-sm text-muted-foreground">{t("installment.store_empty", "分期专区还没有可分期的商品。")}</p>
            </div>
          )}
          {!!items.length && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {items.map((it) => <ProductCard key={it.id} item={it} />)}
              </div>
              {hasMore && (
                <div className="grid place-items-center py-2">
                  <Button variant="outline" size="sm" onClick={loadMore}>{t("common.load_more", "加载更多")}</Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export function InstallmentMyPage() {
  const { user, config, ready, t, tf } = useSite();
  const [rows, setRows] = useState<InstallmentMyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [next, setNext] = useState<number | null>(null);

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const r = await call<MyPage>("installment/my", { token: "user", query: { offset } });
      setRows((prev) => (offset === 0 ? r.items : [...prev, ...r.items]));
      setNext(r.next_offset);
      setError("");
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (ready && user) void load(0); }, [ready, user, load]);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("installment.loading", "正在加载…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;
  const enabled = config?.switches?.installment === true;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <SubHeader
        title={t("installment.my_title", "我的分期")}
        back="/orders"
        extra={enabled ? <Link to="/installment" className="text-primary underline">{t("installment.zone_title", "分期专区")}</Link> : undefined}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && !rows.length && <div className="grid place-items-center py-14"><CartLoading label={t("installment.my_loading", "正在加载分期订单…")} /></div>}
      {!loading && !rows.length && (
        <div className="flex flex-col items-center gap-2 border border-border/70 py-12 text-center">
          <p className="text-sm text-muted-foreground">{t("installment.my_empty", "还没有分期订单。")}</p>
          {enabled && <Link to="/installment" className="text-sm text-primary underline">{t("installment.go_zone", "去分期专区看看")}</Link>}
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map((r) => {
          const overdue = r.overdue_indexes.length > 0;
          const settled = r.fully_paid || r.status_payment === "PAID";
          return (
            <li key={r.id} className="flex flex-col gap-2 border border-border/70 p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono">{r.order_no}</span>
                <span className="text-xs text-muted-foreground">{fmtTime(r.created_at)}</span>
                <span className="ml-auto text-xs">
                  {settled
                    ? <b className="text-primary">{t("installment.settled", "已结清")}</b>
                    : overdue
                      ? <b className="text-destructive">{tf("installment.overdue_n", { n: r.overdue_indexes.length }, "逾期 {n} 期")}</b>
                      : <span className="text-muted-foreground">{tf("installment.active", { paid: r.paid_count, n: r.n }, "进行中 {paid}/{n} 期")}</span>}
                </span>
              </div>
              <Progress paid={r.paid_count} n={r.n} />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{tf("installment.paid_of", { paid: formatBase(r.paid_base), total: formatBase(r.paid_base + r.remaining_base) }, "已付 {paid} / 共 {total}")}</span>
                {!settled && <span>{tf("installment.remaining", { amt: formatBase(r.remaining_base) }, "待付 {amt}")}</span>}
              </div>
              {!settled && r.next_due_date && (
                <p className={"text-xs " + (overdue ? "text-destructive" : "text-muted-foreground")}>
                  {tf("installment.next_due", { date: fmtDate(r.next_due_date) }, "下期到期 {date}")}
                </p>
              )}
              <div className="flex justify-end">
                <Link to={`/order?id=${r.id}`} className="text-sm text-primary underline">{t("installment.view_bill", "查看账单 / 付款")}</Link>
              </div>
            </li>
          );
        })}
      </ul>
      {!!rows.length && next !== null && (
        <div className="grid place-items-center py-2">
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(next)}>{loading ? t("common.loading", "加载中…") : t("common.load_more", "加载更多")}</Button>
        </div>
      )}
    </div>
  );
}
