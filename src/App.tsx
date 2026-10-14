import { type CSSProperties } from "react";
import { usePath, Link } from "./router";
import { useKeyboardInset } from "./viewport";
import { SiteProvider, useSite } from "./site";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";
import { TabBar } from "./components/TabBar";
import { FaviconSync, useAssetUrl } from "./components/BrandMark";
import { HomePage, MaintenanceNotice } from "./pages/Home";
import { LoginPage, RegisterPage } from "./pages/Auth";
import { MePage } from "./pages/Me";
import { ProfileEditPage } from "./pages/ProfileEdit";
import { ChangePasswordPage } from "./pages/ChangePassword";
import { PaymentPasswordPage } from "./pages/PaymentPassword";
import { LanguageSettingPage } from "./pages/LanguageSetting";
import { InvitePage } from "./pages/Invite";
import { MessagesPage } from "./pages/Messages";
import { AddressesPage } from "./pages/Addresses";
import { WishlistPage } from "./pages/Wishlist";
import { InvoicesPage } from "./pages/Invoices";
import { PageView } from "./pages/Page";
import { SupportPage } from "./pages/Support";
import { VipPage } from "./pages/Vip";
import { CategoryPage } from "./pages/Category";
import { SearchPage } from "./pages/Search";
import { ProductPage } from "./pages/Product";
import { CartPage } from "./pages/Cart";
import { CheckoutPage } from "./pages/Checkout";
import { OrdersPage } from "./pages/Orders";
import { OrderDetailPage } from "./pages/OrderDetail";
import { CouponsPage } from "./pages/Coupons";
import { CouponCenterPage } from "./pages/CouponCenter";
import { WalletPage } from "./pages/Wallet";
import { CoinsPage } from "./pages/Coins";
import { CoinRedemptionsPage } from "./pages/CoinRedemptions";
import { InstallmentPage, InstallmentMyPage } from "./pages/Installment";
import { SecondFloorPage } from "./pages/SecondFloor";
import { Splash } from "./pages/Splash";
import AdminApp from "./admin/AdminApp";

/** 整页活动背景：campaign.posters.page_bg_key 生效时铺在内容背后，未配置则不渲染 */
function PageBackdrop() {
  const { campaign } = useSite();
  const url = useAssetUrl(campaign?.posters?.page_bg_key);
  if (!url) return null;
  return <div aria-hidden className="fixed inset-0 -z-10 bg-cover bg-center" style={{ backgroundImage: `url(${url})` }} />;
}

function Frontend() {
  const path = usePath();
  const { failed, ready, t } = useSite();
  const page = (() => {
    switch (path) {
      case "/": return <HomePage />;
      case "/login": return <LoginPage />;
      case "/register": return <RegisterPage />;
      case "/me": return <MePage />;
      case "/me/profile": return <ProfileEditPage />;
      case "/me/password": return <ChangePasswordPage />;
      case "/me/payment-password": return <PaymentPasswordPage />;
      case "/me/language": return <LanguageSettingPage />;
      case "/me/invite": return <InvitePage />;
      case "/me/messages": return <MessagesPage />;
      case "/me/addresses": return <AddressesPage />;
      case "/me/wishlist": return <WishlistPage />;
      case "/me/invoices": return <InvoicesPage />;
      case "/me/support": return <SupportPage />;
      case "/me/vip": return <VipPage />;
      case "/category": return <CategoryPage />;
      case "/search": return <SearchPage />;
      case "/page": return <PageView />;
      case "/product": return <ProductPage />;
      case "/cart": return <CartPage />;
      case "/checkout": return <CheckoutPage />;
      case "/orders": return <OrdersPage />;
      case "/order": return <OrderDetailPage />;
      case "/coupons": return <CouponsPage />;
      case "/coupons/center": return <CouponCenterPage />;
      case "/wallet": return <WalletPage />;
      case "/coins": return <CoinsPage />;
      case "/coins/redemptions": return <CoinRedemptionsPage />;
      case "/installment": return <InstallmentPage />;
      case "/installment/my": return <InstallmentMyPage />;
      case "/activity": return <SecondFloorPage />;
      default:
        return (
          <div className="grid place-items-center gap-3 py-16 text-center">
            <p className="text-muted-foreground">{t("app.not_found", "页面不存在")}</p>
            <Link to="/" className="rounded-md brand-gradient px-5 py-1.5 text-sm font-medium text-white shadow-md shadow-primary/40">{t("common.back_home", "返回首页")}</Link>
          </div>
        );
    }
  })();
  const authPage = path === "/login" || path === "/register";
  // 客服中心是整页会话框：占满可视高度、消息区内部滚动、输入框贴底，底部 Tab 与页脚都不渲染（桌面端同样）
  const chatPage = path === "/me/support";
  // 手机键盘弹出时把会话框整体压矮，输入框贴着键盘上沿；桌面端算出来恒为 0，不参与
  const kbInset = useKeyboardInset(chatPage);
  return (
    <div
      className={"flex flex-col " + (chatPage ? "h-[calc(100dvh_-_var(--kb,0px))] overflow-hidden" : "min-h-dvh pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0")}
      style={chatPage ? ({ "--kb": `${kbInset}px`, "--safe-b": kbInset > 0 ? "0px" : "env(safe-area-inset-bottom)" } as CSSProperties) : undefined}
    >
      <FaviconSync />
      <PageBackdrop />
      <Splash />
      {/* 登录/注册是专注页：顶栏（Logo/搜索/账号入口）整块不渲染，品牌与语言入口由页面自己给 */}
      {!authPage && <SiteHeader />}
      <MaintenanceNotice />
      {ready && failed && (
        <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground">
          {t("app.backend_unreachable", "后端不可达：本地预览仅含前端界面，接口需在已发布站点的同源 /functions/v1/app 下验证。")}
        </div>
      )}
      <main className={chatPage ? "flex min-h-0 flex-1 flex-col" : "flex-1"}>{page}</main>
      {!chatPage && <SiteFooter />}
      {!chatPage && <TabBar />}
    </div>
  );
}

export default function App() {
  const path = usePath();
  if (path === "/admin" || path.startsWith("/admin/")) {
    return (
      <SiteProvider>
        <FaviconSync />
        <AdminApp />
      </SiteProvider>
    );
  }
  return (
    <SiteProvider>
      <Frontend />
    </SiteProvider>
  );
}
