// 我的兑换 CI6（文档F；状态筛选 + 分页 + 实物确认收货）
import { useCallback, useEffect, useState } from "react";
import { call, newIdem } from "../api";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { CartLoading } from "../components/CartLoading";
import { oneLine } from "../components/AddressFields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  COIN_ITEM_TYPE_TEXT, REDEMPTION_STATUS_TEXT, coinText,
  type CoinRedemptionPage, type CoinRedemptionRow,
} from "../coins";
import { COUPON_STATUS_TEXT, fmtDate, fmtTime, shopErr } from "../trade";

const TABS: string[] = ["", "REDEEMED", "PENDING_SHIP", "SHIPPED", "RECEIVED", "REVOKED"];
const BADGE: Record<string, "default" | "secondary" | "outline"> = {
  REDEEMED: "default", PENDING_SHIP: "secondary", SHIPPED: "secondary", RECEIVED: "outline", REVOKED: "outline",
};

function Cover({ url, alt }: { url: string | undefined; alt: string }) {
  const { t } = useSite();
  if (!url) return <span className="grid size-full place-items-center bg-muted text-xs text-muted-foreground">{t("coin.no_image", "无图")}</span>;
  return <img src={url} alt={alt} className="size-full object-cover" loading="lazy" />;
}

function RedemptionRow({ r, onConfirm, busyId }: { r: CoinRedemptionRow; onConfirm: (id: string) => void; busyId: string }) {
  const { t } = useSite();
  return (
    <li className="flex gap-3 border-b border-border/70 py-3">
      <div className="size-16 shrink-0 overflow-hidden border border-border/70"><Cover url={r.image_urls[0]} alt={r.title_snapshot} /></div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <b className="truncate text-sm">{r.title_snapshot}</b>
          <Badge variant="outline">{t("coin.kind." + r.item_type, COIN_ITEM_TYPE_TEXT[r.item_type] ?? r.item_type)}</Badge>
          <Badge variant={BADGE[r.status] ?? "outline"}>{t("coin.redeem.status." + r.status, REDEMPTION_STATUS_TEXT[r.status] ?? r.status)}</Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          {t("coin.spent", "消耗")} <span className="text-primary">{coinText(r.coin_amount)} {t("coin.unit", "金币")}</span> · {fmtTime(r.created_at)}
        </p>

        {r.item_type === "coupon" && (
          <p className="text-xs text-muted-foreground">
            {t("coin.coupon_status_label", "券状态：")}{r.coupon_status ? t("coin.coupon_status." + r.coupon_status, COUPON_STATUS_TEXT[r.coupon_status] ?? r.coupon_status) : "—"}
            {" · "}<Link to="/coupons" className="text-primary underline">{t("coin.view_in_coupons", "去券包查看")}</Link>
          </p>
        )}
        {r.item_type === "vip" && (
          <p className="text-xs text-muted-foreground">
            {t("coin.vip_expire_prefix", "会员有效期至：")}{r.vip_expire_at ? fmtDate(r.vip_expire_at) : "—"}
            {" · "}<Link to="/me/vip" className="text-primary underline">{t("coin.view_in_vip", "去会员页查看")}</Link>
          </p>
        )}
        {r.item_type === "virtual" && r.virtual_snapshot && (
          <p className="break-all rounded-none border border-dashed bg-muted/40 px-2 py-1 text-xs">{t("coin.benefit_prefix", "权益内容：")}{r.virtual_snapshot}</p>
        )}
        {r.item_type === "physical" && (
          <>
            {r.address_snapshot && <p className="truncate text-xs text-muted-foreground">{t("coin.recv_prefix", "收货：")}{oneLine(r.address_snapshot)}</p>}
            {r.status === "SHIPPED" && <p className="text-xs text-muted-foreground">{t("order.logistics_prefix", "物流：")}{r.ship_company} {r.ship_no}</p>}
            {r.status === "PENDING_SHIP" && <p className="text-xs text-muted-foreground">{t("coin.ship_pending_note", "已提交发货，等待后台处理。")}</p>}
            {r.status === "SHIPPED" && (
              <Button size="sm" className="self-start" disabled={busyId === r.id} onClick={() => onConfirm(r.id)}>
                {busyId === r.id ? t("common.processing", "处理中…") : t("order.confirm_receipt", "确认收货")}
              </Button>
            )}
          </>
        )}
        {r.status === "REVOKED" && <p className="text-xs text-destructive">{t("coin.revoked_note", "该兑换已撤销，金币已退回。")}</p>}
      </div>
    </li>
  );
}

export function CoinRedemptionsPage() {
  const { user, config, ready, t } = useSite();
  const [status, setStatus] = useState("");
  const [pages, setPages] = useState<CoinRedemptionPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const enabled = config?.switches?.coins === true;

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    setError("");
    const offset = reset ? 0 : (pages[pages.length - 1]?.next_offset ?? 0);
    try {
      const r = await call<CoinRedemptionPage>("coin/redemptions", { token: "user", query: { status: status || undefined, offset } });
      setPages((prev) => (reset || !prev.length ? [r] : [...prev, r]));
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setLoading(false);
    }
  }, [status, pages]);

  useEffect(() => { if (ready && user && enabled) void load(true); }, [ready, user, enabled, status]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("coin.my_redemptions_loading", "正在加载我的兑换…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;
  if (!enabled) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-16 text-center">
        <p className="text-muted-foreground">{t("coin.disabled", "金币功能当前未开启。")}</p>
        <Link to="/me" className="text-sm text-primary underline">{t("common.back_to_me", "返回我的")}</Link>
      </div>
    );
  }

  async function confirm(id: string) {
    setBusyId(id);
    setError("");
    try {
      await call("coin/redemption/confirm", { method: "POST", token: "user", idem: newIdem(), body: { redemption_id: id } });
      void load(true);
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setBusyId("");
    }
  }

  const items = pages.flatMap((p) => p.items);
  const hasMore = pages.some((p) => p.has_more);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">{t("coin.my_redemptions", "我的兑换")}</h1>
        <div className="flex gap-3 text-sm">
          <Link to="/coins" className="text-primary underline">{t("me.link_coins", "金币中心")}</Link>
          <Link to="/me" className="text-muted-foreground underline">{t("common.back_to_me", "返回我的")}</Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => { setStatus(key); setPages([]); }}
            className={"border px-4 py-1 transition " + (status === key ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}
          >
            {key === "" ? t("common.all", "全部") : t("coin.redeem.status." + key, REDEMPTION_STATUS_TEXT[key])}
          </button>
        ))}
      </div>

      {error && <p className="border-y border-border/70 px-1 py-3 text-sm text-destructive">{error}</p>}
      {loading && !items.length && <div className="grid place-items-center py-16"><CartLoading label={t("coin.my_redemptions_loading", "正在加载我的兑换…")} /></div>}
      {!loading && !error && !items.length && (
        <div className="flex flex-col items-center gap-3 border border-border/70 py-14 text-center">
          <p className="text-sm text-muted-foreground">{t("coin.no_redemptions", "还没有兑换记录。")}</p>
          <Link to="/coins" className="border border-primary px-5 py-1.5 text-sm font-medium text-primary">{t("coin.go_redeem", "去金币中心兑换")}</Link>
        </div>
      )}

      {!!items.length && (
        <ul className="flex flex-col">
          {items.map((r) => <RedemptionRow key={r.id} r={r} onConfirm={(id) => void confirm(id)} busyId={busyId} />)}
        </ul>
      )}

      {hasMore && (
        <Button variant="outline" className="self-center" disabled={loading} onClick={() => void load(false)}>
          {loading ? t("common.loading", "加载中…") : t("common.loading_more", "加载更多")}
        </Button>
      )}
    </div>
  );
}
