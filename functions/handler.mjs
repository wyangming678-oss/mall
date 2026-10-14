// 路由/鉴权/幂等分发（文档C §〇 约定；M1 基建 + M2a 目录 + M2b 交易 + M3a 券 + M3b 邀请 + M3c 退款 + M3d 消息 + M4a VIP + M4b 公告 + M4c 客服）
import { ok, fail, AppError } from "./errors.mjs";
import { readJson } from "./validate.mjs";
import { resolvePrincipal, requirePrincipal, requireAnyPrincipal, requireChatPrincipal } from "./auth.mjs";
import { runIdempotent } from "./idem.mjs";
import { getMergedConfig, getCurrencies, getStrings, pageView } from "./config.mjs";
import * as users from "./users.mjs";
import * as admins from "./admins.mjs";
import * as files from "./files.mjs";
import * as catalog from "./catalog.mjs";
import * as reviews from "./reviews.mjs";
import * as wishlist from "./wishlist.mjs";
import * as invoices from "./invoices.mjs";
import * as address from "./address.mjs";
import * as cart from "./cart.mjs";
import * as orders from "./orders.mjs";
import * as payments from "./payments.mjs";
import * as installments from "./installments.mjs";
import * as wallet from "./wallet.mjs";
import * as adminOrders from "./admin_orders.mjs";
import * as coupons from "./coupons.mjs";
import * as invite from "./invite.mjs";
import * as coins from "./coins.mjs";
import * as refunds from "./refunds.mjs";
import * as withdrawals from "./withdrawals.mjs";
import * as notify from "./notify.mjs";
import * as vip from "./vip.mjs";
import * as announcements from "./announcements.mjs";
import * as chat from "./chat.mjs";
import * as stats from "./stats.mjs";
import * as tasks from "./tasks.mjs";
import * as themes from "./themes.mjs";
import * as security from "./security.mjs";

const ZERO_UUID = "00000000-0000-4000-8000-000000000000";
const LANGS = users.LANGS;

// —— S1/S2 站点公开面（可选登录态：有会话则附带 me）——
async function siteBootstrap({ supabase, request, query }) {
  const principal = await resolvePrincipal(supabase, request);
  const { config, configVersion } = await getMergedConfig(supabase);
  // 运营皮肤：campaign = 当前生效视图（购物端渲染源），config = 默认皮肤（装修编辑器基线）
  // theme_presets / active_theme 属后台内部，绝不下发到公开面
  const campaign = themes.effectiveCampaign(config);
  // 二楼：present 视图随 bootstrap 附带（购物端下拉手势仅在 present=true 挂载）；raw decor:second_floor 仍留在 config 供后台编辑
  const secondFloor = themes.secondFloorView(config, campaign.theme);
  const { theme_presets, active_theme, ...publicConfig } = config;
  const currencies = await getCurrencies(supabase);
  let me = null;
  if (principal?.type === "user") me = { type: "user", ...(await users.publicUser(supabase, principal.id)) };
  else if (principal?.type === "admin") me = { type: "admin", id: principal.id };
  const lang = query.lang ?? me?.language ?? "zh";
  // 首页横幅/弹窗公告走 S1 附带（文档C 无购物端公告读端点，轮询 config_version 时一并刷新即「发布即生效」）
  // catalog_version：商品/分类/SKU 的指纹，前端 60 秒轮询到变化就自动重取目录（不需要刷新页面）
  return ok({
    config: publicConfig, campaign, second_floor: secondFloor, currencies,
    config_version: configVersion, catalog_version: await catalog.catalogFingerprint(supabase),
    server_time: new Date().toISOString(), me,
    announcements: await announcements.visibleAnnouncements(supabase, { lang, userId: me?.type === "user" ? me.id : null }),
  });
}

async function siteStrings({ supabase, request, query }) {
  const principal = await resolvePrincipal(supabase, request);
  let lang = query.lang;
  if (!lang && principal?.type === "user") {
    const { data } = await supabase.from("users").select("language").eq("id", principal.id).maybeSingle();
    lang = data?.language;
  }
  lang = (lang ?? "zh").toLowerCase();
  if (!LANGS.includes(lang)) return fail("invalid_request", "语言不在白名单", { allowed: LANGS });
  return ok({ lang, strings: await getStrings(supabase, lang) });
}

// —— A5 静态内容页读取（公开，site_config "pages"，无迁移）——
async function sitePage({ supabase, request, query }) {
  const slug = (query.slug ?? "").trim();
  if (!slug) return fail("invalid_request", "缺少 slug");
  const principal = await resolvePrincipal(supabase, request);
  let lang = query.lang;
  if (!lang && principal?.type === "user") {
    const { data } = await supabase.from("users").select("language").eq("id", principal.id).maybeSingle();
    lang = data?.language;
  }
  lang = (lang ?? "zh").toLowerCase();
  if (!LANGS.includes(lang)) return fail("invalid_request", "语言不在白名单", { allowed: LANGS });
  const { config } = await getMergedConfig(supabase);
  const page = pageView(config.pages, slug, lang);
  if (!page) return fail("not_found", "页面不存在", { slug }, 404);
  return ok(page);
}

// —— HB1 心跳：惰性到期任务（文档B §12）——
async function tasksTick({ supabase, principal }) {
  return ok(await tasks.tasksTick(supabase, principal));
}

// —— A4 我的：用户 + 当前 VIP 快照 + 未读数（文档C A4；chat 未读随 M4c 客服接入）——
async function authMe({ supabase, principal }) {
  const user = await users.publicUser(supabase, principal.id);
  const vipSnapshot = await vip.activeVip(supabase, principal.id);
  const notifications = await notify.unreadCount(supabase, principal.id);
  const chatUnread = await chat.chatUnread(supabase, principal.id);
  return ok({ user, vip: vipSnapshot ?? null, unread: { notifications, chat: chatUnread } });
}

const ROUTES = {
  "site/bootstrap": { method: "GET", handler: siteBootstrap },
  "site/strings": { method: "GET", handler: siteStrings },
  "site/page": { method: "GET", handler: sitePage },

  // 防滥用：一次性验证题（register/user_login/admin_login 三种 scope，公开领取、服务端留哈希）
  // 题面是 6 位随机数字、与界面语言无关，所以不再收 lang；按 IP 限流所以要把 request 传下去
  "auth/captcha": { method: "GET", handler: ({ supabase, request, query }) => security.issueChallenge(supabase, query.scope, request) },
  "auth/register": { method: "POST", idem: true, handler: ({ supabase, request, body }) => users.register(supabase, body, { ip: security.clientIp(request) }) },
  "auth/login": { method: "POST", handler: ({ supabase, request, body }) => users.login(supabase, body, { ip: security.clientIp(request) }) },
  "auth/logout": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal }) => users.logout(supabase, principal) },
  "auth/me": { method: "GET", auth: "user", handler: authMe },
  "auth/profile": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => users.updateProfile(supabase, principal, body) },
  "auth/change-password": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => users.changePassword(supabase, principal, body) },
  "auth/payment-password": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => users.changePaymentPassword(supabase, principal, body) },
  "invite/summary": { method: "GET", auth: "user", handler: ({ supabase, principal }) => invite.inviteSummary(supabase, principal) },

  // —— 金币兑换商城 CI1–CI6（文档F §五；开关关→410 coins_disabled）——
  "coin/overview": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => coins.coinOverview(supabase, principal, query) },
  "coin/checkin": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal }) => coins.coinCheckin(supabase, principal) },
  "coin/items": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => coins.coinItems(supabase, principal, query) },
  "coin/item": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => coins.coinItemDetail(supabase, principal, query) },
  "coin/redeem": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => coins.coinRedeem(supabase, principal, body) },
  "coin/redemptions": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => coins.coinRedemptions(supabase, principal, query) },
  "coin/redemption/confirm": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => coins.coinRedemptionConfirm(supabase, principal, body) },

  "admin/auth/bootstrap": { method: "POST", bodyLimit: 65536, handler: ({ supabase, body }) => admins.bootstrap(supabase, body) },
  "admin/auth/login": { method: "POST", handler: ({ supabase, request, body }) => admins.adminLogin(supabase, body, { ip: security.clientIp(request) }) },
  "admin/auth/logout": { method: "POST", auth: "admin", handler: ({ supabase, request }) => admins.adminLogout(supabase, request) },
  "admin/auth/me": { method: "GET", auth: "admin", handler: ({ supabase, request }) => admins.adminMe(supabase, request) },
  "admin/account/save": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.saveAccount(supabase, request, body) },
  "admin/account/delete": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.deleteAccount(supabase, request, body) },
  "admin/accounts": { method: "GET", auth: "admin", handler: ({ supabase, request }) => admins.listAccounts(supabase, request) },
  "admin/role/save": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.saveRole(supabase, request, body) },
  "admin/roles": { method: "GET", auth: "admin", handler: ({ supabase, request }) => admins.listRoles(supabase, request) },
  "admin/users": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => admins.listUsers(supabase, request, query) },
  // 文档J §一：替不会注册的顾客开号（免人机验证、不受 register_open 约束，但必须 highRisk 二次确认 + 审计）
  "admin/user/create": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.adminUserCreate(supabase, request, body) },
  "admin/user/status": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.setUserStatus(supabase, request, body) },
  "admin/user/balance-adjust": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.adjustUserBalance(supabase, request, body) },
  "admin/user/password-reset": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.resetUserPassword(supabase, request, body) },
  "admin/user/update": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => admins.updateUserProfile(supabase, request, body) },
  "admin/user/payment-password": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.setUserPaymentPassword(supabase, request, body) },
  "admin/decor/save": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.saveDecor(supabase, request, body) },
  // D1 配置历史（site.decorate）：列表 / 单版本 / 回滚
  "admin/config/history": { method: "GET", auth: "admin", handler: ({ supabase, request }) => admins.listConfigHistoryEndpoint(supabase, request) },
  "admin/config/history/get": { method: "GET", auth: "admin", handler: ({ supabase, request }) => admins.getConfigHistoryEndpoint(supabase, request) },
  "admin/config/rollback": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.rollbackConfigEndpoint(supabase, request, body) },
  // A5 静态内容页（content.manage，site_config "pages"）
  "admin/page/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => admins.adminPageSave(supabase, request, body) },
  // —— M5 运营换肤 TH1–TH4（文档E；site_config jsonb，无迁移）——
  "admin/themes": { method: "GET", auth: "admin", handler: ({ supabase, request }) => themes.adminListThemes(supabase, request) },
  "admin/theme/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => themes.adminSaveTheme(supabase, request, body) },
  "admin/theme/apply": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => themes.adminApplyTheme(supabase, request, body) },
  "admin/theme/delete": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => themes.adminDeleteTheme(supabase, request, body) },
  "admin/pay-channels/save": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.savePayChannels(supabase, request, body) },
  "admin/currency/save": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.saveCurrency(supabase, request, body) },
  "admin/currency/base": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => admins.saveCurrencyBase(supabase, request, body) },
  "admin/string/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => admins.saveUiStrings(supabase, request, body) },
  "admin/audit": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => admins.listAudit(supabase, request, query) },
  "admin/stats": { method: "GET", auth: "admin", handler: ({ supabase, request }) => stats.adminStats(supabase, request) },
  "admin/tasks/health": { method: "GET", auth: "admin", handler: ({ supabase, request }) => stats.tasksHealth(supabase, request) },

  "file/upload": { method: "POST", auth: "any", idem: true, bodyLimit: 8 * 1024 * 1024, handler: ({ supabase, request, body }) => files.fileUpload(supabase, request, body) },
  "file/url": { method: "GET", auth: null, handler: ({ supabase, request, principal }) => files.fileUrl(supabase, request, principal) },
  // F2b 批量取址：一屏图片合并成一次请求（省配额）。只读，不进幂等表。
  "file/url/batch": { method: "POST", auth: null, handler: ({ supabase, request, body, principal }) => files.fileUrlBatch(supabase, request, body, principal) },
  "file/remove": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => files.fileRemove(supabase, request, body) },

  // —— 商品目录（文档C §三 P1–P3 匿名可读；§六.4 PR1–PR4 后台）——
  "catalog/categories": { method: "GET", auth: null, handler: ({ supabase }) => catalog.categoriesList(supabase) },
  "catalog/products": { method: "GET", auth: null, handler: ({ supabase, query }) => catalog.productsList(supabase, query) },
  "catalog/brands": { method: "GET", auth: null, handler: ({ supabase, query }) => catalog.catalogBrands(supabase, query) },
  "catalog/product": { method: "GET", auth: null, handler: ({ supabase, query }) => catalog.productDetail(supabase, query) },

  "admin/categories": { method: "GET", auth: "admin", handler: ({ supabase, request }) => catalog.adminCategories(supabase, request) },
  "admin/category/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => catalog.adminCategorySave(supabase, request, body) },
  "admin/products": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => catalog.adminProducts(supabase, request, query) },
  "admin/product": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => catalog.adminProductDetail(supabase, request, query) },
  "admin/product/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => catalog.adminProductSave(supabase, request, body) },
  "admin/product/bulk": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => catalog.adminProductBulk(supabase, request, body) },
  "admin/product/status": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => catalog.adminProductStatus(supabase, request, body) },
  "admin/stock/adjust": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => catalog.adminStockAdjust(supabase, request, body) },
  "admin/inventory/logs": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => catalog.adminInventoryLogs(supabase, request, query) },

  // —— 商品评价/评分 RV1/RV2 + 后台审核（文档A 新增 product_reviews；A7）——
  "review/list": { method: "GET", auth: null, handler: ({ supabase, principal, query }) => reviews.reviewList(supabase, principal, query) },
  "review/submit": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => reviews.reviewSubmit(supabase, principal, body) },
  "admin/reviews": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => reviews.adminReviews(supabase, request, query) },
  "admin/review/status": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => reviews.adminReviewStatus(supabase, request, body) },

  // —— 收藏/心愿单 WL1/WL2/WL3（文档A 新增 wishlist_items；A8）——
  "wishlist/list": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => wishlist.wishlistList(supabase, principal, query) },
  "wishlist/status": { method: "GET", auth: null, handler: ({ supabase, principal, query }) => wishlist.wishlistStatus(supabase, principal, query) },
  "wishlist/toggle": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => wishlist.wishlistToggle(supabase, principal, body) },

  // —— 发票申请 IN1/IN2/IN3 + 后台队列/开具/作废（文档A 新增 invoices；A9）——
  "invoice/list": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => invoices.invoiceList(supabase, principal, query) },
  "invoice/status": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => invoices.invoiceStatus(supabase, principal, query) },
  "invoice/apply": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => invoices.invoiceApply(supabase, principal, body) },
  "admin/invoices": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => invoices.adminInvoices(supabase, request, query) },
  "admin/invoice/action": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => invoices.adminInvoiceAction(supabase, request, body) },

  // —— 收货地址 AD1（文档C §二）——
  "address/list": { method: "GET", auth: "user", handler: ({ supabase, principal }) => address.addressList(supabase, principal) },
  "address/save": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => address.addressSave(supabase, principal, body) },
  "address/delete": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => address.addressDelete(supabase, principal, body) },

  // —— 站内消息（文档C §四 NT1；M3d）——
  "notify/list": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => notify.notifyList(supabase, principal, query) },
  "notify/read": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => notify.notifyRead(supabase, principal, body) },

  // —— 客服 CH1–CH4（文档C §五；文档B §10 waiting→active→closed，5s 增量轮询；文档J：auth "chat" 允许注册主体与访客主体，
  //      chat/open 额外 anonOk —— 无令牌时由服务端签发 guest 主体，其余三条必须有主体）——
  "chat/open": { method: "POST", auth: "chat", anonOk: true, handler: ({ supabase, request, query, principal }) => chat.chatOpen(supabase, principal, { ip: security.clientIp(request), lang: query.lang }) },
  "chat/poll": { method: "GET", auth: "chat", handler: ({ supabase, principal, query }) => chat.chatPoll(supabase, principal, query) },
  "chat/send": { method: "POST", auth: "chat", idem: true, handler: ({ supabase, principal, body }) => chat.chatSend(supabase, principal, body) },
  "chat/close": { method: "POST", auth: "chat", idem: true, handler: ({ supabase, principal, body }) => chat.chatClose(supabase, principal, body) },

  // —— 购物车 C1–C4（文档C §三）——
  "cart/list": { method: "GET", auth: "user", handler: ({ supabase, principal }) => cart.cartList(supabase, principal) },
  "cart/add": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => cart.cartAdd(supabase, principal, body) },
  "cart/update": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => cart.cartUpdate(supabase, principal, body) },
  "cart/remove": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => cart.cartRemove(supabase, principal, body) },

  // —— 订单 O1–O5（文档C §四；文档B §1.1/§2）——
  "order/create": { method: "POST", auth: "user", idem: true, bodyLimit: 65536, handler: ({ supabase, principal, body }) => orders.createOrder(supabase, principal, body) },
  "order/list": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => orders.orderList(supabase, principal, query) },
  "order/detail": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => orders.orderDetail(supabase, principal, query) },
  "order/cancel": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => orders.orderCancel(supabase, principal, body) },
  "order/confirm-receipt": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => orders.orderConfirmReceipt(supabase, principal, body) },

  // —— 支付 Y1–Y5 / 钱包 W1–W2（文档C §四；文档B §3）——
  "pay/wallet": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => payments.payWithWallet(supabase, principal, body) },
  "pay/wallet-part": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => payments.payWalletPart(supabase, principal, body) },
  "pay/qrcode": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => payments.payQrcode(supabase, principal, body) },
  "pay/proof": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => payments.payProof(supabase, principal, body) },
  "pay/list": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => payments.payList(supabase, principal, query) },
  "wallet/overview": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => wallet.walletOverview(supabase, principal, query) },
  "wallet/recharge": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => payments.walletRecharge(supabase, principal, body) },

  // —— 分期 IN1/IN2/IB1/IB2（文档N D1–D7：首付解锁发货 / 逐期人工收款 / 提前结清）——
  "installment/pay": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => payments.installmentPay(supabase, principal, body) },
  "installment/settle": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => payments.installmentSettleNow(supabase, principal, body) },
  "installment/bill": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => installments.installmentBill(supabase, principal, query) },
  "installment/my": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => installments.myInstallments(supabase, principal, query) },

  // —— 余额提现 WD1–WD3（文档O：无网关⇒人工线下打款；申请即扣余额）——
  "wallet/withdraw/apply": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => withdrawals.withdrawApply(supabase, principal, body) },
  "wallet/withdraw/list": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => withdrawals.withdrawList(supabase, principal, query) },
  "wallet/withdraw/cancel": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => withdrawals.withdrawCancel(supabase, principal, body) },

  // —— 优惠券 CP1/CP2 + 后台 CY1/CY2/AU4（文档C §四/§六.5；文档B §4）——
  "coupon/my": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => coupons.couponMy(supabase, principal, query) },
  "coupon/center": { method: "GET", auth: "user", handler: ({ supabase, principal }) => coupons.couponCenter(supabase, principal) },
  "coupon/claim": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => coupons.couponClaim(supabase, principal, body) },
  "coupon/available-for-cart": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => coupons.couponAvailableForCart(supabase, principal, query) },
  "admin/coupon-templates": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => coupons.adminCouponTemplates(supabase, request, query) },
  "admin/coupon-template/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => coupons.adminCouponTemplateSave(supabase, request, body) },
  "admin/coupon-template/status": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => coupons.adminCouponTemplateStatus(supabase, request, body) },
  "admin/coupon-template/delete": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => coupons.adminCouponTemplateDelete(supabase, request, body) },
  "admin/coupons": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => coupons.adminCoupons(supabase, request, query) },
  "admin/coupon/batch-grant": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => coupons.adminCouponBatchGrant(supabase, request, body) },
  "admin/user/coupon-grant": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => coupons.adminUserCouponGrant(supabase, request, body) },

  // —— VIP 会员 V1/V2 + 后台 VP1/VP2（文档C §四/§六.6；文档B §8 权益快照）——
  "vip/plans": { method: "GET", auth: "user", handler: ({ supabase }) => vip.vipPlans(supabase) },
  "vip/purchase": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => vip.vipPurchase(supabase, principal, body) },
  "admin/vip-plans": { method: "GET", auth: "admin", handler: ({ supabase, request }) => vip.adminVipPlans(supabase, request) },
  "admin/vip-plan/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => vip.adminVipPlanSave(supabase, request, body) },
  "admin/user-vips": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => vip.adminUserVips(supabase, request, query) },
  "admin/user-vip/grant": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => vip.adminUserVipGrant(supabase, request, body) },

  // —— 公告 AN1（文档C §六.6；文档B §9 draft→published→offline + T7）——
  "admin/announcement/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => announcements.adminAnnouncementSave(supabase, request, body) },
  "admin/announcement/publish": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => announcements.adminAnnouncementPublish(supabase, request, body) },
  "admin/announcement/offline": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => announcements.adminAnnouncementOffline(supabase, request, body) },
  "admin/announcements": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => announcements.adminAnnouncements(supabase, request, query) },

  // —— 客服工作台 CS1–CS4（文档C §六.7；权限点 chat.handle，方案 §2 客服角色仅工作台）——
  "admin/chat/queue": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => chat.adminChatQueue(supabase, request, query) },
  "admin/chat/claim": { method: "POST", auth: "admin", handler: ({ supabase, request, body }) => chat.adminChatClaim(supabase, request, body) },
  "admin/chat/reply": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => chat.adminChatReply(supabase, request, body) },
  "admin/chat/poll": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => chat.adminChatPoll(supabase, request, query) },
  "admin/chat/close": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => chat.adminChatClose(supabase, request, body) },

  // —— 邀请返利 CY3/CY4/CY5（文档C §六.6；文档B §7）——
  "admin/invite/rule/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => invite.adminSaveInviteRule(supabase, request, body) },
  "admin/invite/overview": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => invite.adminInviteOverview(supabase, request, query) },
  "admin/invite/revoke-reward": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => invite.adminRevokeReward(supabase, request, body) },

  // —— 金币后台 CO1–CO4（文档F §五；⚠=highRisk confirm）——
  "admin/coin/rules": { method: "GET", auth: "admin", handler: ({ supabase, request }) => coins.adminCoinRules(supabase, request) },
  "admin/coin/rules/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => coins.adminCoinRulesSave(supabase, request, body) },
  "admin/coin-items": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => coins.adminCoinItems(supabase, request, query) },
  "admin/coin-item/save": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => coins.adminCoinItemSave(supabase, request, body) },
  "admin/coin-item/status": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => coins.adminCoinItemStatus(supabase, request, body) },
  "admin/coin-redemptions": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => coins.adminCoinRedemptions(supabase, request, query) },
  "admin/coin-redemption/ship": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => coins.adminCoinRedemptionShip(supabase, request, body) },
  "admin/coin-redemption/revoke": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => coins.adminCoinRedemptionRevoke(supabase, request, body) },
  "admin/user/coin-adjust": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => coins.adminUserCoinAdjust(supabase, request, body) },

  // —— 后台订单 OD1–OD6 / 凭证审核 PF1–PF4（文档C §六.3）——
  "admin/orders": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => adminOrders.adminOrderList(supabase, request, query) },
  "admin/order/detail": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => adminOrders.adminOrderDetail(supabase, request, query) },
  "admin/order/ship": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => adminOrders.adminOrderShip(supabase, request, body) },
  "admin/order/close": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => adminOrders.adminOrderClose(supabase, request, body) },
  "admin/order/complete": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => adminOrders.adminOrderComplete(supabase, request, body) },
  "admin/order/address": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => adminOrders.adminOrderAddress(supabase, request, body) },
  "admin/proof/claim": { method: "POST", auth: "admin", idem: true, handler: ({ supabase, request, body }) => payments.proofClaim(supabase, request, body) },
  "admin/proof/heartbeat": { method: "POST", auth: "admin", handler: ({ supabase, request, body }) => payments.proofHeartbeat(supabase, request, body) },
  "admin/proof/review": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => payments.proofReview(supabase, request, body) },
  "admin/proof/queue": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => payments.proofQueue(supabase, request, query) },

  // —— 退款售后 R1/R2 + RF1/RF2（文档C §四/§六.3；文档B §5 一单一退）——
  "refund/apply": { method: "POST", auth: "user", idem: true, handler: ({ supabase, principal, body }) => refunds.refundApply(supabase, principal, body) },
  "refund/status": { method: "GET", auth: "user", handler: ({ supabase, principal, query }) => refunds.refundStatus(supabase, principal, query) },
  "admin/refunds": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => refunds.adminRefundList(supabase, request, query) },
  "admin/refund/detail": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => refunds.adminRefundDetail(supabase, request, query) },
  "admin/refund/create": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => refunds.adminRefundCreate(supabase, request, body) },
  "admin/refund/review": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => refunds.adminRefundReview(supabase, request, body) },
  "admin/refund/offline-done": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => refunds.adminRefundOfflineDone(supabase, request, body) },

  // —— 后台提现审核 AN-WD1–WD4（withdraw.review；资金流出，done/reject 走 highRisk）——
  "admin/withdraws": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => withdrawals.adminWithdrawList(supabase, request, query) },
  "admin/withdraw/detail": { method: "GET", auth: "admin", handler: ({ supabase, request, query }) => withdrawals.adminWithdrawDetail(supabase, request, query) },
  "admin/withdraw/done": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => withdrawals.adminWithdrawDone(supabase, request, body) },
  "admin/withdraw/reject": { method: "POST", auth: "admin", idem: true, highRisk: true, handler: ({ supabase, request, body }) => withdrawals.adminWithdrawReject(supabase, request, body) },

  "tasks/tick": { method: "POST", auth: "any", handler: tasksTick },
};

// 网关会把 URL 里的逻辑函数名段（app）替换成上游物理名，pathname 前缀不可依赖。
// 路由名恒为路径末尾若干段，取最长命中（/admin/chat/poll 优先于 /chat/poll）。
const ROUTE_KEYS = Object.keys(ROUTES).sort((a, b) => b.length - a.length);

function routeKey(pathname) {
  const path = pathname.replace(/\/+$/, "");
  for (const key of ROUTE_KEYS) {
    if (path.endsWith(`/${key}`)) return key;
  }
  return path.replace(/^\/+/, "");
}

function normalize(result) {
  return result instanceof Response ? result : ok(result ?? {});
}

export async function handleApp({ request, supabase }) {
  const url = new URL(request.url);
  const route = ROUTES[routeKey(url.pathname)];
  if (!route) return fail("not_found", "接口不存在", null, 404);
  if (route.method !== request.method) return fail("method_not_allowed", "", null, 405);
  try {
    const query = Object.fromEntries(url.searchParams);
    let body = null;
    if (route.method === "POST") body = await readJson(request, route.bodyLimit ?? 262144);

    let principal = null;
    if (route.auth === "user") principal = await requirePrincipal(supabase, request, "user");
    else if (route.auth === "admin") principal = await requirePrincipal(supabase, request, "admin");
    else if (route.auth === "any") principal = await requireAnyPrincipal(supabase, request);
    else if (route.auth === "chat") principal = await requireChatPrincipal(supabase, request, { allowAnonymous: route.anonOk === true });
    else principal = await resolvePrincipal(supabase, request);

    if (route.highRisk && body?.confirm !== true) {
      return fail("confirm_required", "高危操作需二次确认", null, 400);
    }

    const ctx = { supabase, request, principal, body, query };
    if (route.idem) {
      const key = request.headers.get("idempotency-key");
      return await runIdempotent(supabase, {
        key,
        principalType: principal?.type ?? "anon",
        principalId: principal?.id ?? ZERO_UUID,
        action: routeKey(url.pathname),
        body,
      }, () => route.handler(ctx)).then(normalize);
    }
    return normalize(await route.handler(ctx));
  } catch (error) {
    if (error instanceof AppError) {
      return fail(error.code, error.message, error.details, error.status);
    }
    return fail("internal_error", "", null, 500);
  }
}
