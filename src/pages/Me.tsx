import { useEffect, useState, type ReactNode } from "react";
import { call, newIdem, tokenStore } from "../api";
import { Link, navigate, RedirectTo } from "../router";
import { useSite } from "../site";
import { displayAmount } from "../const";
import { rateText, usableCurrencyCode, type MeResult, type VipView } from "../trade";
import { CartLoading } from "../components/CartLoading";
import { useAssetUrl } from "../components/BrandMark";
import { useUnreadTick } from "../notify";
import { Button } from "@/components/ui/button";

// —— 线性图标（currentColor 描边，随主题配色；命名保持通用不绑定品牌） ——
const ICON_PATH: Record<string, string> = {
  order: "M6 3h9l3 3v15H6Z M9 8h6 M9 12h6 M9 16h4",
  address: "M12 21S6 15.3 6 11a6 6 0 1 1 12 0c0 4.3-6 10-6 10Z M12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  coupon: "M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z M9 6v12",
  heart: "M12 20S5 15.4 5 10.5A3.5 3.5 0 0 1 12 8a3.5 3.5 0 0 1 7 2.5C19 15.4 12 20 12 20Z",
  invoice: "M7 3h7l4 4v14H7Z M14 3v4h4 M9 12h6 M9 16h6",
  coin: "M12 7c-3 0-5 1-5 2.5S9 12 12 12s5-1 5-2.5S15 7 12 7Z M7 9.5v4C7 15 9 16 12 16s5-1 5-2.5v-4",
  support: "M4 5h16v11H9l-5 4Z M8 10h8",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M5 21a7 7 0 0 1 14 0",
  lock: "M7 11V8a5 5 0 0 1 10 0v3 M6 11h12v9H6Z M12 15v2",
  shield: "M12 3l7 3v6c0 4-3 7.2-7 9-4-1.8-7-5-7-9V6Z M9.5 12h5",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18",
  pay: "M3 7h18v10H3Z M3 11h18 M6 14h4",
  package: "M4 8h16v12H4Z M4 8l8-4 8 4 M12 4v16 M4 12h16",
  truck: "M3 7h11v9H3Z M14 10h4l3 3v3h-7 M7 19a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 7 19Z M17 19a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 17 19Z",
  crown: "M4 8l4 3 4-6 4 6 4-3-1.5 10h-13Z",
  gift: "M4 11h16v9H4Z M4 7h16v4H4Z M12 7v13 M12 7a2.5 2.5 0 1 0-2-4c1 0 2 1 2 4Z M12 7a2.5 2.5 0 1 1 2-4c-1 0-2 1-2 4Z",
};

function Icon({ name, className = "size-5" }: { name: keyof typeof ICON_PATH; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICON_PATH[name]} />
    </svg>
  );
}

// —— 扁平分组外壳：方形、发丝分隔线，无边角阴影 ——
function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="border bg-card">
      {title && <h2 className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

// 跳转行（图标 + 标签 + 可选徽标/提示 + 箭头）：账户设置里每一项都指向自己的二级页
function RowLink({ icon, label, to, hint, badge }: {
  icon: keyof typeof ICON_PATH; label: string; to: string; hint?: string; badge?: number;
}) {
  return (
    <Link to={to} className="relative flex items-center gap-3 border-b border-border/70 px-4 py-3 text-sm last:border-b-0 hover:bg-accent">
      <span className="shrink-0 text-primary"><Icon name={icon} /></span>
      <span className="min-w-0 flex-1">{label}</span>
      {hint && <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>}
      <span className="shrink-0 text-muted-foreground" aria-hidden>›</span>
      {badge ? (
        <span className="absolute right-6 top-1/2 grid min-w-4 -translate-y-1/2 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </Link>
  );
}

// 服务宫格磁贴
function ServiceTile({ to, icon, label, badge }: { to: string; icon: keyof typeof ICON_PATH; label: string; badge?: number }) {
  return (
    <Link to={to} className="relative flex flex-col items-center gap-1.5 border-b border-r border-border/70 px-2 py-4 text-center text-xs hover:bg-accent">
      <span className="text-primary"><Icon name={icon} className="size-6" /></span>
      <span>{label}</span>
      {badge ? (
        <span className="absolute right-3 top-2 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </Link>
  );
}

export function MePage() {
  const { user, currencies, config, ready, refresh, t, tf } = useSite();
  const [vip, setVip] = useState<VipView | null>(null);
  const [chatUnread, setChatUnread] = useState(0);
  const [orderCounts, setOrderCounts] = useState<Record<string, number>>({});
  const avatarPreviewUrl = useAssetUrl(user?.avatar_key ?? null);

  // A4 一次带回会员快照与两类未读数；客服红点随轮询广播刷新
  const unreadTick = useUnreadTick();
  useEffect(() => {
    if (!user) {
      setVip(null);
      setChatUnread(0);
      return;
    }
    call<MeResult>("auth/me", { token: "user" })
      .then((r) => { setVip(r.vip); setChatUnread(r.unread?.chat ?? 0); })
      .catch(() => { setVip(null); setChatUnread(0); });
  }, [user, unreadTick]);

  // 一次 order/list 带回各状态计数，给「我的订单」状态宫格挂角标；失败静默（不阻塞主功能）
  useEffect(() => {
    if (!user) { setOrderCounts({}); return; }
    call<{ counts_by_status?: Record<string, number> }>("order/list", { token: "user", query: { tab: "all", limit: 1 } })
      .then((r) => setOrderCounts(r.counts_by_status ?? {}))
      .catch(() => setOrderCounts({}));
  }, [user]);

  if (!ready) return <div className="grid place-items-center py-14"><CartLoading label={t("me.loading", "正在加载账户信息…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  // 结算币种：账号币种已下架时回落站点本位币，不再假设人民币存在
  const settleCode = usableCurrencyCode(currencies, user.currency_code);
  const currency = currencies.find((c) => c.code === settleCode) ?? null;
  const balanceText = currency ? displayAmount(user.balance, currency.rate_scaled, currency.symbol) : tf("me.raw_cents", { n: user.balance }, "{n} 分");

  async function logout() {
    try {
      await call("auth/logout", { method: "POST", token: "user", idem: newIdem(), body: {} });
    } catch {
      /* 会话可能已过期，本地清理照常 */
    }
    tokenStore.user.set(null);
    await refresh();
    navigate("/");
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-5">
      {/* —— 头部：居中海报式身份 + 资产三格条 —— */}
      <div className="border bg-card">
        <div className="flex flex-col items-center gap-1.5 px-4 pt-7 pb-5 text-center">
          <button
            type="button"
            onClick={() => navigate("/me/profile")}
            aria-label={t("me.edit_title", "编辑资料")}
            className="relative grid size-20 place-items-center overflow-hidden border bg-muted hover:opacity-90"
          >
            {avatarPreviewUrl ? (
              <img src={avatarPreviewUrl} alt="" className="size-full object-cover" />
            ) : (
              <span className="text-3xl font-black text-primary">{(user.nickname || user.username).charAt(0)}</span>
            )}
            <span className="absolute inset-x-0 bottom-0 bg-black/45 py-0.5 text-[10px] text-white">{t("me.avatar_edit", "换头像")}</span>
          </button>
          <div className="mt-1 flex items-center gap-2">
            <p className="text-lg font-semibold">{user.nickname || user.username}</p>
            <span className="shrink-0 border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {user.status === "active" ? t("me.status_active", "正常") : t("me.status_disabled", "已禁用")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">@{user.username}</p>
          <p className="text-xs text-muted-foreground">
            {user.email || t("me.email_unset", "邮箱未填")} · {user.phone || t("me.phone_unset", "手机号未填")}
          </p>
        </div>
        <div className="grid grid-cols-3 divide-x border-t">
          <Link to="/wallet" className="flex flex-col items-center gap-0.5 px-2 py-3 text-center hover:bg-accent">
            <span className="text-base font-semibold text-primary">{balanceText}</span>
            <span className="text-xs text-muted-foreground">{t("me.wallet_balance", "钱包余额")}</span>
          </Link>
          <div className="flex flex-col items-center gap-0.5 px-2 py-3 text-center">
            <span className="text-base font-semibold">{settleCode}</span>
            <span className="text-xs text-muted-foreground">{t("me.settle_currency", "结算币种")}</span>
          </div>
          <Link to="/me/vip" className="flex flex-col items-center gap-0.5 px-2 py-3 text-center hover:bg-accent">
            <span className="truncate text-base font-semibold">
              {vip ? rateText(vip.discount_rate) : t("me.vip_none", "未开通")}
            </span>
            <span className="text-xs text-muted-foreground">{t("me.vip", "会员")}</span>
          </Link>
        </div>
      </div>

      {/* —— 我的订单：状态宫格 + 计数角标 + 深链 —— */}
      <Section title={t("me.section_orders", "我的订单")}>
        <div className="grid grid-cols-3 sm:grid-cols-6">
          <ServiceTile to="/orders?tab=pending_payment" icon="pay" label={t("me.link_orders_pending", "待付款")} badge={orderCounts.PENDING_PAYMENT} />
          <ServiceTile to="/orders?tab=unshipped" icon="package" label={t("me.link_orders_unshipped", "待发货")} badge={orderCounts.PAID} />
          <ServiceTile to="/orders?tab=shipped" icon="truck" label={t("me.link_orders_shipped", "待收货")} badge={orderCounts.SHIPPED} />
          <ServiceTile to="/orders" icon="order" label={t("me.link_orders_all", "全部订单")} />
          <ServiceTile to="/me/wishlist" icon="heart" label={t("me.link_wishlist", "我的收藏")} />
          <ServiceTile to="/me/support" icon="support" label={t("me.link_support", "客服中心")} badge={chatUnread} />
        </div>
      </Section>

      {/* —— 账户设置：每一项都是独立二级页 —— */}
      <Section title={t("me.section_account", "账户设置")}>
        <RowLink icon="profile" label={t("me.edit_title", "编辑资料")} to="/me/profile" />
        <RowLink icon="lock" label={t("me.change_pw_title", "修改密码")} to="/me/password" />
        <RowLink icon="shield" label={t("me.pay_pw_title", "支付密码")} to="/me/payment-password"
          hint={user.has_payment_password ? t("me.pay_pw_on", "已设置") : t("me.pay_pw_off", "未设置")} />
        <RowLink icon="globe" label={t("me.language", "界面语言")} to="/me/language" />
        <RowLink icon="address" label={t("me.link_addresses", "收货地址")} to="/me/addresses" />
        <RowLink icon="coupon" label={t("me.link_coupons", "我的券包")} to="/coupons" />
        <RowLink icon="invoice" label={t("me.link_invoices", "我的发票")} to="/me/invoices" />
        {config?.switches?.coins && <RowLink icon="coin" label={t("me.link_coins", "金币中心")} to="/coins" />}
        <RowLink icon="crown" label={t("me.vip", "会员")} to="/me/vip" hint={vip ? rateText(vip.discount_rate) : t("me.vip_none", "未开通")} />
        <RowLink icon="gift" label={t("me.invite_title", "我的邀请")} to="/me/invite" />
      </Section>

      <Button variant="destructive" className="w-full" onClick={() => void logout()}>{t("me.logout", "退出登录")}</Button>
    </div>
  );
}
