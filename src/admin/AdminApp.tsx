import { useEffect, useState, type FormEvent } from "react";
import { ApiError, call } from "../api";
import { Link, navigate, usePath, RedirectTo } from "../router";
import { AdminProvider, useAdmin } from "./AdminAuth";
import { formatBase } from "../const";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CaptchaRow, captchaBody, useCaptchaChallenge } from "../components/CaptchaField";
import UsersPage from "./pages/Users";
import AccountsPage from "./pages/Accounts";
import RolesPage from "./pages/Roles";
import DecorPage from "./pages/Decor";
import ProductsPage from "./pages/Products";
import ReviewsPage from "./pages/Reviews";
import OrdersPage from "./pages/Orders";
import ProofsPage from "./pages/Proofs";
import RefundsPage from "./pages/Refunds";
import WithdrawsPage from "./pages/Withdraws";
import InvoicesPage from "./pages/Invoices";
import CouponsPage from "./pages/Coupons";
import VipPage from "./pages/Vip";
import CoinAdminPage from "./pages/Coins";
import AnnouncementsPage from "./pages/Announcements";
import PagesPage from "./pages/Pages";
import SupportWorkbench from "./pages/Support";
import InvitesPage from "./pages/Invites";
import CurrenciesPage from "./pages/Currencies";
import StringsPage from "./pages/Strings";
import AuditPage from "./pages/Audit";
import { useSite } from "../site";

// 一级顶部域 + 域内二级子页；用户/客服/商品/公告按站长要求置于顶层
interface MenuItem { to: string; label: string; perm: string | null }
interface MenuSection { label: string; items: MenuItem[] }
const SECTIONS: MenuSection[] = [
  { label: "概览", items: [{ to: "/admin", label: "经营看板", perm: null }] },
  {
    label: "商品",
    items: [
      { to: "/admin/products", label: "商品管理", perm: "product.read" },
      { to: "/admin/reviews", label: "商品评价", perm: "product.manage" },
    ],
  },
  {
    label: "交易",
    items: [
      { to: "/admin/orders", label: "订单管理", perm: "order.read" },
      { to: "/admin/proofs", label: "凭证审核", perm: "payment.review" },
      { to: "/admin/refunds", label: "售后退款", perm: "refund.review" },
      { to: "/admin/withdraws", label: "余额提现", perm: "withdraw.review" },
      { to: "/admin/invoices", label: "发票管理", perm: "order.read" },
    ],
  },
  {
    label: "用户",
    items: [
      { to: "/admin/users", label: "用户管理", perm: "user.read" },
      { to: "/admin/vip", label: "VIP 会员", perm: "vip.manage" },
      { to: "/admin/invites", label: "邀请返利", perm: "invite.read" },
    ],
  },
  { label: "客服", items: [{ to: "/admin/support", label: "客服工作台", perm: "chat.handle" }] },
  {
    label: "公告",
    items: [
      { to: "/admin/announcements", label: "公告管理", perm: "content.manage" },
      { to: "/admin/pages", label: "内容页面", perm: "content.manage" },
      { to: "/admin/strings", label: "语言文案", perm: "content.manage" },
    ],
  },
  {
    label: "营销",
    items: [
      { to: "/admin/coupons", label: "优惠券", perm: "coupon.manage" },
      { to: "/admin/coins", label: "金币商城", perm: "coin.manage" },
    ],
  },
  {
    label: "站点",
    items: [
      { to: "/admin/decor", label: "站点装修", perm: "site.decorate" },
      { to: "/admin/currencies", label: "币种汇率", perm: "site.currency" },
    ],
  },
  {
    label: "系统",
    items: [
      { to: "/admin/accounts", label: "后台账号", perm: "admin.manage" },
      { to: "/admin/roles", label: "角色权限", perm: "admin.manage" },
      { to: "/admin/audit", label: "审计日志", perm: "audit.read" },
    ],
  },
];

function LoginPage() {
  const { login } = useAdmin();
  const { config } = useSite();
  const [form, setForm] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 后台登录失败 2 次起服务端要求答题（401 details.captcha_required）
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const cap = useCaptchaChallenge("admin_login", needCaptcha);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(form.username, form.password, needCaptcha ? captchaBody(cap) : undefined);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "network_error") setError("本地预览不含后端：请通过已发布站点访问后台功能");
        else setError(err.message || `错误：${err.code}`);
        const d = err.details as { captcha_required?: boolean } | undefined;
        if (d?.captcha_required || err.code === "captcha_required") setNeedCaptcha(true);
        // 提交即消耗题目（哪怕 401 密码错），too_fast 是唯一未消耗的错误 → 其余错误一律换题
        if (err.code !== "captcha_too_fast") void cap.refresh();
      } else setError("操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>{`${config?.brand?.site_name ?? "商城"} · 管理后台`}</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ad-u">用户名</Label>
              <Input id="ad-u" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} required />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ad-p">密码</Label>
              <Input id="ad-p" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required />
            </div>
            {needCaptcha && <CaptchaRow cap={cap} />}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>{busy ? "提交中…" : "登录"}</Button>
          </form>
          <div className="mt-3 flex justify-end text-sm text-muted-foreground">
            <Link to="/" className="underline">返回商城</Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface StatsResp {
  server_time: string;
  gmv: { basis: string; window_days: number; today_base: number; d7_base: number; d30_base: number; total_base: number; confirmed_count: number; truncated: boolean };
  currency_totals_30d: { currency_code: string; amount_currency: number }[];
  order_funnel: { status: string; count: number }[];
  pending: { proofs: number; refunds_open: number; chat_waiting: number; chat_active: number; invite_rewards: number };
  stock_alert: { threshold: number; items: { sku_id: string; product_id: string; product_title: string | null; sku_code: string; spec_name: string | null; available_stock: number }[] };
  totals: { users: number; products_on_sale: number; coupons_unused: number; orders_all: number };
}
interface HealthResp {
  server_time: string;
  tick_min_interval_ms: number;
  last_batch: { ran_at?: string; counts?: Record<string, number>; errors?: Record<string, string> } | null;
  tasks: { code: string; label: string; backlog: number | null; last_count: number | null; last_error: string | null }[];
  recon: { frozen_sku_rows: number; pending_payment_orders: number; orphan_freeze: boolean; refunding_orders: number; live_refunds: number; refund_state_mismatch: boolean };
}

const ORDER_LABELS: Record<string, string> = {
  PENDING_PAYMENT: "待付款", PAID: "已付款", SHIPPED: "已发货", COMPLETED: "已完成",
  CANCELLED: "已取消", REFUNDING: "退款中", REFUNDED: "已退款",
};

function Kpi({ label, value, hint, to }: { label: string; value: string | number; hint?: string; to?: string }) {
  const inner = (
    <div className="border bg-background px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-bold leading-tight tabular-nums max-[340px]:text-sm">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
  return to ? <Link to={to} className="block transition hover:border-primary">{inner}</Link> : inner;
}

function PendingChip({ label, n, to }: { label: string; n: number; to: string }) {
  const hot = n > 0;
  return (
    <Link to={to} className={"flex items-center gap-2 border px-2.5 py-1.5 text-sm transition " + (hot ? "border-primary/60" : "opacity-70 hover:opacity-100")}>
      <span className="text-muted-foreground">{label}</span>
      <span className={"min-w-6 px-1 text-center text-xs font-bold tabular-nums " + (hot ? "bg-red-600 text-white" : "bg-muted text-muted-foreground")}>{n}</span>
    </Link>
  );
}

function DashboardSkeleton({ text }: { text: string }) {
  return <p className="border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

function Overview() {
  const { me, has } = useAdmin();
  const { config } = useSite();
  const canDash = has("dashboard.read");
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [s, h] = await Promise.all([
        call<StatsResp>("admin/stats", { token: "admin" }),
        call<HealthResp>("admin/tasks/health", { token: "admin" }),
      ]);
      setStats(s);
      setHealth(h);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "network_error"
        ? "后端不可达：本地预览仅前端，看板数据需在已发布站点验证"
        : e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (me && canDash) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, canDash]);

  if (!me) return null;
  const visibleSections = SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => i.to !== "/admin" && (!i.perm || has(i.perm))) }))
    .filter((s) => s.items.length);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">你好，{me.admin.nickname}</h1>
        <Badge variant="secondary">{me.roleKeys.join(" / ")}</Badge>
        <span className="text-sm text-muted-foreground">{config?.brand?.site_name ?? "商城"} · {new Date().toLocaleDateString("zh-CN")}</span>
        {canDash && <Button size="sm" variant="outline" className="ml-auto" disabled={loading} onClick={() => void load()}>{loading ? "刷新中…" : "刷新"}</Button>}
      </div>

      {canDash && !stats && !error && <DashboardSkeleton text={loading ? "正在加载经营看板…" : "看板加载中…"} />}
      {canDash && error && (
        <div className="flex flex-wrap items-center gap-3 border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>重试</Button>
        </div>
      )}

      {canDash && stats && (
        <>
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="今日 GMV" value={formatBase(stats.gmv.today_base)} hint="已确认订单支付" />
            <Kpi label="近 7 日 GMV" value={formatBase(stats.gmv.d7_base)} />
            <Kpi label="近 30 日 GMV" value={formatBase(stats.gmv.d30_base)} hint={stats.gmv.truncated ? "样本已达扫描上限" : `确认笔数 ${stats.gmv.confirmed_count}`} />
            <Kpi label="累计 GMV" value={formatBase(stats.gmv.total_base)} hint={`近 ${stats.gmv.window_days} 日窗口`} />
          </section>

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="注册用户" value={stats.totals.users} />
            <Kpi label="在售商品" value={stats.totals.products_on_sale} to="/admin/products" />
            <Kpi label="未使用券" value={stats.totals.coupons_unused} to="/admin/coupons" />
            <Kpi label="订单总数" value={stats.totals.orders_all} to="/admin/orders" />
          </section>

          <section className="flex flex-col gap-2">
            <p className="text-sm font-medium">待处理事项</p>
            <div className="flex flex-wrap gap-2">
              <PendingChip label="凭证待审" n={stats.pending.proofs} to="/admin/proofs" />
              <PendingChip label="在途退款" n={stats.pending.refunds_open} to="/admin/refunds" />
              <PendingChip label="待接入客服" n={stats.pending.chat_waiting} to="/admin/support" />
              <PendingChip label="进行中会话" n={stats.pending.chat_active} to="/admin/support" />
              <PendingChip label="待结算邀请" n={stats.pending.invite_rewards} to="/admin/invites" />
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <p className="text-sm font-medium">订单状态分布</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {stats.order_funnel.map((f) => (
                <div key={f.status} className="border bg-background px-2.5 py-2 text-center">
                  <p className="text-xs text-muted-foreground">{ORDER_LABELS[f.status] ?? f.status}</p>
                  <p className="text-lg font-bold tabular-nums">{f.count}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <p className="text-sm font-medium">
              低库存预警
              <span className="ml-2 text-xs font-normal text-muted-foreground">（阈值 ≤ {stats.stock_alert.threshold}）</span>
            </p>
            {stats.stock_alert.items.length === 0 ? (
              <p className="border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">暂无低库存 SKU。</p>
            ) : (
              <div className="max-h-64 overflow-y-auto border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr><th className="px-3 py-1.5 font-medium">商品</th><th className="px-3 py-1.5 font-medium">规格</th><th className="px-3 py-1.5 text-right font-medium">可用库存</th></tr>
                  </thead>
                  <tbody>
                    {stats.stock_alert.items.map((s) => (
                      <tr key={s.sku_id} className="border-t">
                        <td className="px-3 py-1.5"><Link to={`/admin/products?id=${s.product_id}`} className="text-primary hover:underline">{s.product_title ?? s.product_id}</Link></td>
                        <td className="px-3 py-1.5 text-muted-foreground">{s.spec_name ?? s.sku_code}</td>
                        <td className="px-3 py-1.5 text-right font-bold tabular-nums text-red-600">{s.available_stock}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {canDash && health && (
        <section className="flex flex-col gap-2">
          <p className="text-sm font-medium">
            后台任务健康
            {health.last_batch?.ran_at && <span className="ml-2 text-xs font-normal text-muted-foreground">最近批次 {new Date(health.last_batch.ran_at).toLocaleString("zh-CN")}</span>}
            {!health.last_batch && <span className="ml-2 text-xs font-normal text-muted-foreground">尚无批次记录（待用户/管理员心跳触发）</span>}
          </p>
          <div className="overflow-x-auto border">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr><th className="px-3 py-1.5 font-medium">任务</th><th className="px-3 py-1.5 font-medium">说明</th><th className="px-3 py-1.5 text-right font-medium">待处理存量</th><th className="px-3 py-1.5 text-right font-medium">上批处理</th><th className="px-3 py-1.5 font-medium">状态</th></tr>
              </thead>
              <tbody>
                {health.tasks.map((t) => (
                  <tr key={t.code} className="border-t">
                    <td className="px-3 py-1.5 font-mono text-xs">{t.code}</td>
                    <td className="px-3 py-1.5">{t.label}</td>
                    <td className={"px-3 py-1.5 text-right tabular-nums " + ((t.backlog ?? 0) > 0 ? "font-bold" : "text-muted-foreground")}>{t.backlog ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{t.last_count ?? "—"}</td>
                    <td className="px-3 py-1.5">{t.last_error ? <span className="bg-red-600 px-1.5 py-0.5 text-xs text-white">{t.last_error}</span> : <span className="text-xs text-muted-foreground">正常</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className={"border px-2 py-1 " + (health.recon.orphan_freeze ? "border-amber-500 bg-amber-50 text-amber-900" : "text-muted-foreground")}>
              库存冻结对账：无待付却仍冻结 {health.recon.frozen_sku_rows} 条 {health.recon.orphan_freeze ? "（T3 待清）" : "（一致）"}
            </span>
            <span className={"border px-2 py-1 " + (health.recon.refund_state_mismatch ? "border-amber-500 bg-amber-50 text-amber-900" : "text-muted-foreground")}>
              退款状态对账：REFUNDING {health.recon.refunding_orders} ↔ 在途退款 {health.recon.live_refunds} {health.recon.refund_state_mismatch ? "（差异，请核查）" : "（一致）"}
            </span>
          </div>
        </section>
      )}

      {!canDash && (
        <p className="border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">当前账号缺少「概览看板（dashboard.read）」权限点，仅显示快捷入口。</p>
      )}

      <section className="flex flex-col gap-3">
        <p className="text-sm font-medium">管理入口</p>
        {visibleSections.map((s) => (
          <div key={s.label} className="flex flex-wrap items-center gap-2">
            <span className="w-10 shrink-0 text-xs text-muted-foreground">{s.label}</span>
            {s.items.map((m) => (
              <Link key={m.to} to={m.to} className="border bg-background px-3 py-1.5 text-sm font-medium transition hover:border-primary">{m.label}</Link>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

function Shell() {
  const { me, ready, logout } = useAdmin();
  const path = usePath();
  const { config } = useSite();
  useEffect(() => {
    document.title = (config?.brand?.site_name ?? "商城") + " · 管理后台";
    return () => { document.title = config?.brand?.site_name ?? "商城"; };
  }, [config?.brand?.site_name]);
  if (!ready) return <p className="p-8 text-sm text-muted-foreground">加载后台会话…</p>;
  if (!me) return <LoginPage />;
  const page = (() => {
    switch (path) {
      case "/admin": return <Overview />;
      case "/admin/users": return <UsersPage />;
      case "/admin/products": return <ProductsPage />;
      case "/admin/reviews": return <ReviewsPage />;
      case "/admin/orders": return <OrdersPage />;
      case "/admin/proofs": return <ProofsPage />;
      case "/admin/refunds": return <RefundsPage />;
      case "/admin/withdraws": return <WithdrawsPage />;
      case "/admin/invoices": return <InvoicesPage />;
      case "/admin/coupons": return <CouponsPage />;
      case "/admin/coins": return <CoinAdminPage />;
      case "/admin/vip": return <VipPage />;
      case "/admin/invites": return <InvitesPage />;
      case "/admin/announcements": return <AnnouncementsPage />;
      case "/admin/pages": return <PagesPage />;
      case "/admin/support": return <SupportWorkbench />;
      case "/admin/accounts": return <AccountsPage />;
      case "/admin/roles": return <RolesPage />;
      case "/admin/decor": return <DecorPage />;
      case "/admin/currencies": return <CurrenciesPage />;
      case "/admin/strings": return <StringsPage />;
      case "/admin/audit": return <AuditPage />;
      case "/admin/login": return <RedirectTo to="/admin" />;
      case "/admin/setup": return <RedirectTo to="/admin" />;
      default: return <p className="text-sm text-muted-foreground">页面不存在（后台新功能随里程碑上线）</p>;
    }
  })();
  const canSee = (perm: string | null) => !perm || me.permissions.includes("*") || me.permissions.includes(perm);
  const visibleSections = SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => canSee(i.perm)) }))
    .filter((s) => s.items.length);
  const currentSection = visibleSections.find((s) => s.items.some((i) => i.to === path));
  return (
    <div className="flex min-h-dvh flex-col">
      {/* 窄屏（手机模拟）：顶部下拉按域分组换页，常驻侧栏在 390px 会把内容挤到需要左右拖动 */}
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b bg-muted/30 px-3 py-2 md:hidden">
        <span className="shrink-0 text-sm font-bold">{config?.brand?.site_name ?? "商城"} 后台</span>
        <select
          className="h-8 min-w-0 flex-1 border bg-background px-2 text-sm"
          value={path}
          onChange={(e) => navigate(e.target.value)}
        >
          {!currentSection && <option value={path}>{path}</option>}
          {visibleSections.map((s) => (
            <optgroup key={s.label} label={s.label}>
              {s.items.map((m) => (
                <option key={m.to} value={m.to}>{m.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <button type="button" className="shrink-0 text-xs underline" onClick={() => navigate("/")}>商城</button>
        <button type="button" className="shrink-0 text-xs underline" onClick={() => void logout()}>退出</button>
      </header>
      {/* 宽屏：顶部一级域切换（h-10 + border = 41px，侧栏吸顶偏移与之对齐） */}
      <nav className="sticky top-0 z-30 hidden h-10 items-stretch border-b bg-muted/30 md:flex">
        <span className="flex items-center px-4 text-sm font-bold">{config?.brand?.site_name ?? "商城"} 后台</span>
        {visibleSections.map((s) => {
          const active = currentSection?.label === s.label;
          return (
            <Link
              key={s.label}
              to={s.items[0].to}
              className={"flex items-center px-4 text-sm font-medium transition " + (active ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {s.label}
            </Link>
          );
        })}
        <span className="ml-auto flex items-center gap-3 px-4 text-xs text-muted-foreground">
          <span>{me.admin.username}</span>
          <button type="button" className="underline" onClick={() => navigate("/")}>商城</button>
          <button type="button" className="underline" onClick={() => void logout()}>退出</button>
        </span>
      </nav>
      <div className="flex flex-1 flex-col md:flex-row">
        {currentSection && (
          <aside className="hidden w-52 shrink-0 flex-col border-r bg-muted/30 md:flex" style={{ position: "sticky", top: 41, height: "calc(100dvh - 41px)" }}>
            <div className="border-b px-4 py-3 text-sm font-bold">{currentSection.label}</div>
            <nav className="flex flex-1 flex-col gap-0.5 p-2">
              {currentSection.items.map((m) => (
                <Link
                  key={m.to}
                  to={m.to}
                  className={"rounded-md px-3 py-2 text-sm " + (path === m.to ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
                >
                  {m.label}
                </Link>
              ))}
            </nav>
          </aside>
        )}
        <main className="min-w-0 flex-1 p-4 md:p-6">{page}</main>
      </div>
    </div>
  );
}

export default function AdminApp() {
  return (
    <AdminProvider>
      <Shell />
    </AdminProvider>
  );
}
