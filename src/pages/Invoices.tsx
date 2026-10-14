// 我的发票 IN1（A9）：浏览发票申请与开具状态
import { useCallback, useEffect, useState } from "react";
import { call } from "../api";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { formatBase } from "../const";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { fmtDate, INVOICE_STATUS_TEXT, INVOICE_TYPE_TEXT, shopErr, type Invoice, type InvoiceListResult } from "../trade";

const STATUS_CLASS: Record<string, string> = {
  pending: "border border-amber-500/60 text-amber-700",
  issued: "border border-primary text-primary",
  void: "border border-muted-foreground/40 text-muted-foreground",
};

export function InvoicesPage() {
  const { user, ready, t, tf } = useSite();
  const [items, setItems] = useState<Invoice[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (nextOffset: number, append: boolean) => {
    setLoading(true);
    setError("");
    try {
      const r = await call<InvoiceListResult>("invoice/list", { query: { offset: nextOffset }, token: "user" });
      setItems((prev) => (append ? [...(prev ?? []), ...r.items] : r.items));
      setOffset(r.next_offset ?? nextOffset + r.items.length);
      setHasMore(r.has_more);
    } catch (e: unknown) {
      setError(shopErr(e));
      if (!append) setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void load(0, false);
  }, [user, load]);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("invoice.loading", "正在加载发票…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  return (
    <div className="mx-auto flex max-w-4xl flex-col px-4 py-6">
      <SubHeader
        title={t("me.link_invoices", "我的发票")}
        extra={<Link to="/orders" className="text-primary underline">{t("orders.title", "我的订单")}</Link>}
      />

      <p className="mt-3 text-xs text-muted-foreground">{t("invoice.page_hint", "在订单详情页对已支付订单申请发票；后台开具后状态变为「已开具」，电子发票会同时发到你的接收邮箱。")}</p>

      {error && <p className="mt-3 py-6 text-center text-sm text-destructive">{error}</p>}
      {!error && items === null && (
        <div className="grid place-items-center py-16"><CartLoading label={t("invoice.loading", "正在加载发票…")} /></div>
      )}
      {!error && items && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 border-b border-border/70 py-16 text-center">
          <p className="text-sm text-muted-foreground">{t("invoice.empty", "还没有发票申请")}</p>
          <p className="max-w-md text-xs text-muted-foreground">{t("invoice.empty_hint", "对已支付订单，可在订单详情页点「申请发票」开具。")}<Link to="/orders" className="text-primary underline">{t("invoice.go_orders", "去订单列表")}</Link></p>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="divide-y divide-border/70">
          {items.map((it) => (
            <li key={it.invoice_id} className="flex flex-col gap-1.5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/order?id=${it.order_id}`} className="font-mono text-sm text-primary underline">{it.order_no ?? it.order_id}</Link>
                <span className={"px-1.5 text-xs " + (STATUS_CLASS[it.status] ?? "border border-muted-foreground/40 text-muted-foreground")}>
                  {t("status.invoice." + it.status, INVOICE_STATUS_TEXT[it.status] ?? it.status)}
                </span>
                <span className="ml-auto text-sm font-bold text-primary">{formatBase(it.amount_base)}</span>
              </div>
              <p className="text-sm">
                <span className="text-muted-foreground">{t("status.invoice_type." + it.invoice_type, INVOICE_TYPE_TEXT[it.invoice_type] ?? it.invoice_type)}{t("order.invoice_head", "抬头：")}</span>
                {it.title}
                {it.tax_no && <span className="ml-2 text-xs text-muted-foreground">{tf("invoice.tax_no", { no: it.tax_no }, "税号 {no}")}</span>}
              </p>
              <p className="text-xs text-muted-foreground">{t("order.invoice_email_label", "接收邮箱：")}{it.email}</p>
              {it.remark && <p className="text-xs text-muted-foreground">{t("order.remark_prefix", "备注：")}{it.remark}</p>}
              <p className="text-xs text-muted-foreground">
                {t("order.invoice_applied_at", "申请于 ")}{fmtDate(it.created_at)}
                {it.status === "issued" && it.issued_at && <>{t("order.invoice_issued_at", " · 开具于 ")}{fmtDate(it.issued_at)}</>}
                {it.status === "void" && it.void_reason && <>{t("order.invoice_void_reason", " · 作废原因：")}{it.void_reason}</>}
              </p>
            </li>
          ))}
        </ul>
      )}

      {items && items.length > 0 && hasMore && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(offset, true)}
          className="mt-2 w-full border-t border-border/70 py-3 text-sm text-primary disabled:opacity-60"
        >{loading ? t("common.loading", "加载中…") : t("common.loading_more", "加载更多")}</button>
      )}
    </div>
  );
}
