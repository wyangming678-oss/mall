// 交易域共享类型 / 状态文案 / 惰性心跳（文档C §二~§六，文档B §1.1/§12）
import { useCallback, useEffect, useState } from "react";
import { ApiError, call } from "./api";
import { formatBase, getBaseCode, getBaseSymbol } from "./const";
import { text } from "./i18n";
import type { CurrencyItem } from "./site";
import { NON_METHOD_KEYS } from "./site";
import type { InstallmentProductConfig } from "./installments";

/** 购物端统一错误文案（不暴露原始错误细节） */
export function shopErr(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "network_error") return text("trade.err_network", "网络异常或后端不可达，请稍后重试");
    return e.message || text("trade.op_failed_code", "操作失败（{code}）", { code: e.code });
  }
  return text("common.op_failed", "操作失败");
}

// —— 购物车 C1 ——
export interface CartItem {
  id: string;
  sku_id: string;
  quantity: number;
  selected: boolean;
  created_at: string;
  updated_at: string;
  sku: { id: string; spec_name: string; spec_name_i18n?: Record<string, string> | null; sku_code: string; price_base: number } | null;
  product: { id: string; title: string; title_i18n?: Record<string, string> | null; images: string[]; category_id: string; installment?: InstallmentProductConfig } | null;
  available_stock: number;
  purchasable: boolean;
  reason: "gone" | "off" | "stock" | null;
}
export interface CartResult {
  items: CartItem[];
  summary: { count: number; selected_count: number; selected_amount_base: number };
}

// —— 购物车角标变更广播：加购/移除后 bump，TabBar 据此即时重取计数（count 为条目行数，改数量不触发）——
const CART_EVENT = "mall:cart-change";
export function announceCartChange(): void {
  window.dispatchEvent(new Event(CART_EVENT));
}
export function useCartTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    window.addEventListener(CART_EVENT, fn);
    return () => window.removeEventListener(CART_EVENT, fn);
  }, []);
  return tick;
}

// —— 地址 AD1 ——
export interface AddressRow {
  id: string;
  receiver_name: string;
  phone: string;
  country: string;
  province: string;
  city: string;
  district: string | null;
  detail: string;
  postal_code: string | null;
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
}

/** 分期购买需采集的个人信息，落 orders.extra.installment_profile（零迁移 jsonb） */
export interface InstallmentProfile {
  name: string;
  phone: string;
  email: string;
  address: string;
}

/** 订单 extra jsonb 的已知键；发货写入 carrier/tracking_no，下单写入 installment_profile */
export interface OrderExtra {
  carrier?: string | null;
  tracking_no?: string | null;
  ship_note?: string | null;
  shipped_by?: string | null;
  cart_order_id?: string | null;
  installment_profile?: InstallmentProfile | null;
}

// —— 订单 ——
export interface OrderLine {
  id: string;
  order_id: string;
  product_id: string;
  sku_id: string;
  title_snapshot: string;
  image_snapshot: string[];
  spec_snapshot: string;
  price_base_snapshot: number;
  currency_price_snapshot: number;
  quantity: number;
  subtotal_base: number;
}
export interface OrderRow {
  id: string;
  order_no: string;
  user_id: string;
  status_order: string;
  status_payment: string;
  status_shipping: string;
  status_display?: string;
  expired?: boolean;
  goods_amount_base: number;
  discount_amount_base: number;
  freight_amount_base: number;
  actual_paid_amount_base: number;
  currency_code: string;
  currency_rate_scaled: number;
  currency_actual_amount: number;
  currency_name_snapshot: string | null;
  payment_deadline: string;
  address_snapshot: AddressRow | null;
  pricing_snapshot?: PricingSnapshot | null;
  coupon_instance_id?: string | null;
  buyer_remark: string | null;
  cancel_reason: string | null;
  cancelled_at: string | null;
  shipped_at: string | null;
  extra: OrderExtra | null;
  /** 文档N 分期：下单快照期数 + 不可变还款计划（非分期单为 null/undefined） */
  installment_count?: number | null;
  installment_config?: import("./installments").InstallmentConfig | null;
  created_at: string;
  updated_at: string;
}
export interface ProofView {
  id: string;
  transaction_no: string | null;
  amount_declared: number;
  review_status: string;
  reject_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
  image_url: string | null;
}
export interface PaymentRow {
  id: string;
  payment_type: string;
  target_type: string;
  target_id: string;
  user_id: string;
  method: string;
  amount_base: number;
  amount_currency: number;
  currency_code: string;
  /** 文档L：加密货币出票/凭证当刻的币种快照（应付币数 = coin_units / 10^coin_decimals）；非加密货币分项为 null */
  coin_symbol: string | null;
  /** 同一符号可配多条链（USDT/TRC20 与 USDT/ERC20 是两个地址），审核要靠它分账 */
  coin_network: string | null;
  coin_units: number | null;
  /** decimals 必须同刻快照：店主事后改小数位不能改动历史单的应付币数 */
  coin_decimals: number | null;
  status: string;
  reject_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
  /** 文档N 分期：该分项对应的期序（1=首付）；非分期分项为 null/undefined */
  installment_index?: number | null;
  proofs: ProofView[];
}
export interface AllowedActions {
  can_pay: boolean;
  can_cancel: boolean;
  can_confirm_receipt: boolean;
  can_refund: boolean;
  can_change_address: boolean;
  pay_blocked_reason: "deadline_passed" | "in_review" | null;
  /** 文档N 分期：首付已到账、订单进入分期进行中 */
  installment_active?: boolean;
}

// —— 退款售后 R1/R2 + RF1/RF2（文档C §四/§六.3）——
export interface RefundSplit {
  balance: number;
  offline_qr: number;
  offline_done_at: string | null;
  offline_note: string | null;
}
// 一笔退款包含的明细行（D8 二期）；lines=null 表示历史整单退款
export interface RefundLine {
  item_id: string | null;
  sku_id: string | null;
  quantity: number;
  subtotal_base: number;
}
export interface RefundView {
  id: string;
  order_id: string;
  user_id: string;
  status: string;
  amount_base: number;
  amount_currency: number | null;
  currency_code: string | null;
  refund_split: RefundSplit;
  refund_method: string;
  lines: RefundLine[] | null;
  apply_reason: string;
  reject_reason: string | null;
  reviewer_admin_id: string | null;
  reviewed_at: string | null;
  wallet_txn_id: string | null;
  image_count: number;
  image_urls?: string[];
  created_at: string;
  updated_at: string;
}
// 购物端行级可退明细（R2 回显，用于按行按数量选择退款）
export interface RefundableItem {
  item_id: string;
  sku_id: string;
  product_id: string;
  title_snapshot: string;
  spec_snapshot: string;
  price_base_snapshot: number;
  quantity: number;
  refundable_qty: number;
  refundable_base: number;
}
export interface RefundStatusResult {
  order_id: string;
  order_status: { status_order: string; status_payment: string; status_shipping: string };
  can_apply: boolean;
  actual_paid_base: number;
  refunded_base: number;
  remaining_refundable_base: number;
  refundable_items: RefundableItem[];
  refunds: RefundView[];
  refund: RefundView | null;
}

// —— VIP 会员 V1/V2 + VP1/VP2（文档C §四/§六.6；文档B §8 权益快照）——
export interface VipPlan {
  plan_id: string;
  tier_key: string;
  name: string;
  name_i18n: Record<string, string>;
  discount_rate: number;
  duration_days: number;
  price_base: number;
  currency_prices: Record<string, number>;
  benefits: string[];
  status: string;
  sort_order: number;
  prices?: Record<string, number>;
}
/** 开通瞬间整体复制的权益快照：算价与展示都只吃这个形状，不回查套餐 */
export interface VipView {
  vip_id: string;
  user_id?: string;
  plan_id: string;
  tier_key: string;
  discount_rate: number;
  start_at: string;
  expire_at: string;
  purchase_price_base: number;
  benefits_snapshot: string[];
  payment_id: string | null;
  status: string;
  buyer?: { id: string; username: string; nickname: string } | null;
}
/** CP2 结算预览里的会员折行（按原价算出的权益） */
export type VipQuote = VipView & { discount_amount_base: number; after_base: number };
export interface MeResult {
  user: { id: string; username: string; nickname: string; balance: number; currency_code: string };
  vip: VipView | null;
  unread: { notifications: number; chat: number };
}
interface VipPurchaseBase {
  plan_id: string;
  payment_id: string;
  amount_base: number;
  amount_currency: number;
  currency_code: string;
}
/** V2 余额分支即时落权益；扫码分支只建分项，权益等 PF3 过审 */
export type VipPurchase = VipPurchaseBase & (
  | { pay_method: "BALANCE"; balance_after: number; vip: VipView }
  | {
    pay_method: "QR";
    vip: null;
    channel: {
      method: string; image_url: string | null;
      holder_name?: string; account_no?: string; pay_link?: string; account_note?: string | null;
      account_note_i18n?: Record<string, string> | null;
      chains?: CoinChain[];
    };
    transfer_reference: string;
  }
);

export const VIP_STATUS_TEXT: Record<string, string> = { /* i18n-fallback */
  active: "生效中", expired: "已到期", refunded: "已退回",
};
export const VIP_PLAN_STATUS_TEXT: Record<string, string> = { on: "售卖中", off: "已下架" }; /* i18n-fallback */

/** 万分比折扣 → 本地化折扣串：zh 用「几折」，其余语言用百分比减免 */
export function rateText(discountRate: number): string {
  const zhe = Number(discountRate) / 1000;
  if (!(zhe > 0) || zhe >= 10) return text("trade.no_discount", "无折扣");
  return text("trade.rate_off", "{zhe} 折", { zhe: Number(zhe.toFixed(1)), off: Number(((10 - zhe) * 10).toFixed(1)) });
}

/** 权益剩余天数（向上取整；已到期返回 0） */
export function vipDaysLeft(expireAt: string, nowMs = Date.now()): number {
  const left = Date.parse(expireAt) - nowMs;
  return left <= 0 ? 0 : Math.ceil(left / 86_400_000);
}

// —— 优惠券 CP1/CP2（文档C §二）——
export interface CouponBase {
  coupon_id: string;
  template_id: string;
  order_id: string | null;
  status: string;
  expire_at: string;
  source: string;
  created_at: string;
  name: string;
  name_i18n: Record<string, string>;
  coupon_type: string;
  threshold_amount_base: number;
  discount_amount_base: number;
  scope: string;
  scope_ids: string[];
}
export type CouponRow = CouponBase;
export interface CouponOption extends CouponBase {
  usable: boolean;
  eligible_amount_base: number;
  deduction_amount_base: number;
  reason: string | null;
}
export interface CouponQuote {
  cart_ids: string[];
  line_count: number;
  goods_amount_base: number;
  vip: VipQuote | null;
  vip_coupon_stack: boolean;
  options: CouponOption[];
}
export interface CouponPage {
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: CouponRow[];
  counts_by_status: Record<string, number>;
}
// —— 领券中心 CP3/CP4（A2，自助领取 claimable 模板）——
export interface CouponCenterItem {
  template_id: string;
  name: string;
  name_i18n: Record<string, string>;
  coupon_type: string;
  threshold_amount_base: number;
  discount_amount_base: number;
  scope: string;
  scope_ids: string[];
  valid_days: number;
  valid_from: string | null;
  valid_until: string | null;
  unlimited: boolean;
  total_quota: number | null;
  per_user_limit: number;
  issued_count: number;
  my_held: number;
  remaining_quota: number | null;
  can_claim: boolean;
  sold_out: boolean;
}
export interface CouponCenterResult {
  items: CouponCenterItem[];
}

// —— A7 商品评价/评分（RV1 列表+汇总 / RV2 提交）：与 functions/reviews.mjs 响应对齐 ——
export interface ReviewItem {
  review_id: string;
  product_id: string;
  rating: number;
  content: string;
  images: string[];
  verified: boolean;
  created_at: string;
  updated_at: string;
  user_name: string;
}
export interface ReviewSummary {
  count: number;
  avg_rating: number;
  distribution: Record<string, number>;
}
export interface ReviewListResult {
  product_id: string;
  summary: ReviewSummary;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: ReviewItem[];
  my_review: ReviewItem | null;
}

// —— A8 收藏/心愿单（WL1 列表 / WL2 状态 / WL3 开关）：与 functions/wishlist.mjs 响应对齐 ——
export interface WishlistItem {
  product_id: string;
  added_at: string;
  title: string;
  title_i18n?: Record<string, string> | null;
  subtitle: string | null;
  subtitle_i18n?: Record<string, string> | null;
  images: string[];
  min_price: number | null;
  available: boolean;
}
export interface WishlistListResult {
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: WishlistItem[];
}
export interface WishlistStatusResult {
  product_id: string;
  favorited: boolean;
}

// —— A9 发票申请（IN1 列表 / IN2 订单状态 / IN3 申请 + 后台）：与 functions/invoices.mjs 响应对齐 ——
export type InvoiceType = "personal" | "enterprise";
export type InvoiceStatus = "pending" | "issued" | "void";
export interface Invoice {
  invoice_id: string;
  order_id: string;
  order_no: string | null;
  invoice_type: InvoiceType;
  title: string;
  tax_no: string | null;
  email: string;
  remark: string | null;
  amount_base: number;
  currency_code: string | null;
  status: InvoiceStatus;
  issued_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
}
export interface InvoiceListResult {
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: Invoice[];
}
export interface InvoiceStatusResult {
  order_id: string;
  paid: boolean;
  can_apply: boolean;
  actual_paid_base: number;
  currency_code: string | null;
  invoice: Invoice | null;
}
export const INVOICE_TYPE_TEXT: Record<string, string> = { personal: "个人", enterprise: "企业单位" }; /* i18n-fallback */
export const INVOICE_STATUS_TEXT: Record<string, string> = { pending: "待开具", issued: "已开具", void: "已作废" }; /* i18n-fallback */
export interface PricingCoupon {
  coupon_id: string;
  template_id: string;
  name: string;
  /** 下单时刻定格的券名译文；旧订单快照没有这个键 ⇒ 回落 name */
  name_i18n?: Record<string, string>;
  coupon_type: string;
  threshold_amount_base: number;
  discount_amount_base: number;
  scope: string;
  eligible_amount_base: number;
  expire_at: string;
}
export interface PricingSnapshot {
  mode: string;
  lines: number;
  goods_amount_base: number;
  discount_amount_base: number;
  freight_amount_base: number;
  payment_timeout_hours: number;
  coupon: PricingCoupon | null;
  vip_discount_amount_base?: number;
  coupon_discount_amount_base?: number;
  vip?: { vip_id: string; tier_key: string; discount_rate: number; expire_at: string } | null;
  /** 关闭叠加又选了券：本单会员折扣让位（不静默丢折扣，留痕可查） */
  vip_skipped?: "no_stack" | null;
}

// —— 状态文案 ——
export const DISPLAY_TEXT: Record<string, string> = { /* i18n-fallback */
  pending_payment: "待付款",
  pending_review: "凭证审核中",
  payment_rejected: "付款被驳回",
  unshipped: "待发货",
  installment: "分期进行中",
  shipped: "待收货",
  completed: "已完成",
  cancelled: "已取消",
  refunding: "退款中",
  refunded: "已退款",
};
export const ORDER_STATUS_TEXT: Record<string, string> = { /* i18n-fallback */
  PENDING_PAYMENT: "待付款", PAID: "已付款", SHIPPED: "已发货", COMPLETED: "已完成",
  CANCELLED: "已取消", REFUNDING: "退款中", REFUNDED: "已退款",
};
export const PAY_STATUS_TEXT: Record<string, string> = { /* i18n-fallback */
  UNPAID: "未付款", PENDING_REVIEW: "审核中", PAID: "已付款", REJECTED: "已驳回", REFUNDED: "已退款",
  INSTALLMENT_ACTIVE: "分期进行中",
};
export const SHIP_STATUS_TEXT: Record<string, string> = { /* i18n-fallback */
  NOT_SHIPPED: "未发货", SHIPPED: "已发货", DELIVERED: "已收货",
};
export const PAYMENT_ROW_TEXT: Record<string, string> = { /* i18n-fallback */
  PENDING_SUBMIT: "待提交凭证", PENDING_REVIEW: "凭证审核中", CONFIRMED: "已确认到账",
  REJECTED: "凭证被驳回", EXPIRED: "已失效",
};
export const METHOD_TEXT: Record<string, string> = { /* i18n-fallback */
  BALANCE: "余额支付", WECHAT_QR: "微信转账", ALIPAY_QR: "支付宝转账",
  PAYPAL: "PayPal", APPLE_PAY: "Apple Pay", VISA: "Visa 信用卡",
  MASTERCARD: "Mastercard 信用卡", PAYPAY: "PayPay", KAKAOPAY: "KakaoPay",
  CRYPTO: "CEX支付",
};
export const PAYMENT_TYPE_TEXT: Record<string, string> = { /* i18n-fallback */
  ORDER_PAYMENT: "订单付款", WALLET_RECHARGE: "钱包充值", VIP_PURCHASE: "会员开通",
};
// —— 收款渠道（文档H 通用注册表：从 config.pay_channels 派生，不再写死渠道清单）——
// config.pay_channels 混合数值全局键 payment_timeout_hours 与各 method 渠道条目，读取一律走下列三个纯函数收敛
// 加密货币/多币种收款地址（渠道内可选数组，CEX 支付等渠道用；symbol/address 必填、network/note 选填）
// 文档L：rate_base_per_coin = 1 个该币折多少本位币「分」（店主手填，0=未设）；decimals = 展示小数位；
// image_key = 该币专属收款码，留空回落渠道级码。quote/image_url 只在出票响应里出现（后端按分项金额算好）。
export interface CoinQuote { decimals: number; units: number; amount: string }
export interface CoinChain {
  symbol: string; network?: string; address: string; note?: string; note_i18n?: Record<string, string> | null;
  rate_base_per_coin?: number; decimals?: number; image_key?: string | null;
  quote?: CoinQuote | null; image_url?: string | null;
}
export interface PayChannelView {
  enabled?: boolean; fulfillment?: string; display_name?: string;
  image_key?: string | null; holder_name?: string; account_no?: string;
  pay_link?: string; account_note?: string; account_note_i18n?: Record<string, string> | null;
  provider?: string | null;
  chains?: CoinChain[];
}
export type PayChannelsMap = Record<string, PayChannelView | number | string[] | undefined>;

type Translator = (key: string, fallback?: string) => string;

// 购物端可选的「人工收款」渠道（enabled 且 fulfillment 缺省/manual）。
// display_name 原样透传后台配置，取词一律走 channelLabel，避免在这里就把中文默认写死。
export function manualChannels(pc?: PayChannelsMap): { method: string; display_name: string }[] {
  if (!pc) return [];
  const list: { method: string; display_name: string }[] = [];
  for (const [method, c] of Object.entries(pc)) {
    if (NON_METHOD_KEYS.includes(method) || !c || typeof c !== "object" || Array.isArray(c)) continue;
    if (c.enabled !== true) continue;
    if ((c.fulfillment ?? "manual") !== "manual") continue;
    list.push({ method, display_name: c.display_name ?? "" });
  }
  return list;
}

// 某支付分项是否为需上传凭证、走人工线下退款的收款（BALANCE→否；online→否；未知/已删除渠道→按 manual 处理，可补凭证/可退）
export function isQrPayment(pc: PayChannelsMap | undefined, method: string): boolean {
  if (method === "BALANCE") return false;
  const c = pc?.[method];
  if (!c || typeof c !== "object" || Array.isArray(c)) return true;
  return (c.fulfillment ?? "manual") === "manual";
}

// 渠道展示名三级取词：后台改过的自定义名（原样，全语言通用）> 内置四语词表 > 渠道码。
// 后端的 pay_channels 校验器会把缺省 display_name 回填成渠道码本身，管理员留空保存一次就会把
// WECHAT_QR 这类原始枚举下发到购物端；名称等于渠道码或等于内置中文默认都视为「没改过文案」，
// 此时随界面语言取词（同 #145 导航、#185 楼层标题的回落口径）。
export function channelLabel(method: string, displayName: string | null | undefined, t: Translator): string {
  const builtin = METHOD_TEXT[method];
  const dn = (displayName ?? "").trim();
  if (!dn || dn === method || dn === builtin) return t(`pay.method.${method}`, builtin ?? method);
  return dn;
}

export function methodLabel(pc: PayChannelsMap | undefined, method: string, t: Translator): string {
  const c = pc?.[method];
  const dn = c && typeof c === "object" && !Array.isArray(c) ? c.display_name : undefined;
  return channelLabel(method, dn, t);
}

export const CART_REASON_TEXT: Record<string, string> = { /* i18n-fallback */
  gone: "商品已不存在", off: "商品已下架", stock: "库存不足",
};

// —— 优惠券文案 ——
export const COUPON_STATUS_TEXT: Record<string, string> = { /* i18n-fallback */
  UNUSED: "未使用", LOCKED: "使用中", USED: "已使用", EXPIRED: "已过期", REVOKED: "已作废",
};
export const COUPON_TYPE_TEXT: Record<string, string> = { threshold: "满减券", direct: "立减券" }; /* i18n-fallback */
export const COUPON_SCOPE_TEXT: Record<string, string> = { /* i18n-fallback */
  all: "全场通用", category: "指定分类可用", product: "指定商品可用",
};
/** 不可用原因：CP2 的 reason 与下单 410/409 的 reason 共用一张表 */
export const COUPON_REASON_TEXT: Record<string, string> = { /* i18n-fallback */
  below_threshold: "未达使用门槛",
  scope_empty: "本单没有适用商品",
  locked_other: "已在其他订单使用",
  locked: "已在其他订单使用",
  used: "已使用",
  expired: "已过期",
  revoked: "已作废",
  conflict: "券状态已变化",
  not_found: "优惠券不存在",
  coupon_unavailable: "优惠券当前不可用",
  quota_reached: "已达领取上限",
  not_bound: "券未绑定本单",
  already: "已处理",
};

/** 券面规则文案：满减券带门槛，立减券直接写面额 */
export function couponRuleText(c: Pick<CouponBase, "coupon_type" | "threshold_amount_base" | "discount_amount_base">): string {
  const cut = formatBase(c.discount_amount_base);
  return c.coupon_type === "threshold"
    ? text("trade.coupon_threshold", "满 {th} 减 {cut}", { th: formatBase(c.threshold_amount_base), cut })
    : text("trade.coupon_instant", "立减 {cut}", { cut });
}

// —— 退款文案 ——
export const REFUND_STATUS_TEXT: Record<string, string> = { /* i18n-fallback */
  PENDING: "待后台审核", APPROVED: "已同意", PROCESSING: "退款处理中", COMPLETED: "已退款", REJECTED: "已驳回",
};
export const REFUND_METHOD_TEXT: Record<string, string> = { /* i18n-fallback */
  to_wallet: "退回余额", offline: "线下原路退回", mixed: "余额 + 线下退回",
};

/** 已占用金额（分项里仍会生效的部分）与未付差额：与后端 sumBy 同口径 */
export function assignedBase(payments: PaymentRow[]): number {
  return payments
    .filter((p) => ["CONFIRMED", "PENDING_SUBMIT", "PENDING_REVIEW"].includes(p.status))
    .reduce((sum, p) => sum + Number(p.amount_base), 0);
}

/** 展示币种符号：币种表命中取其符号；本位币取注入符号；其余（含已下架币种的历史快照）回落「码 + 空格」 */
export function symbolOf(currencies: CurrencyItem[], code: string): string {
  return currencies.find((c) => c.code === code)?.symbol
    ?? (code === getBaseCode() ? getBaseSymbol() : `${code} `);
}

/**
 * 账号实际可用的交易币种：账号币种可能已被后台下架（币种表只留 USD/本位币）。
 * 不在已开通表内就回落站点本位币，与函数侧 getCurrencyOrBase 同口径，避免前后端算出两个数。
 */
export function usableCurrencyCode(currencies: CurrencyItem[], code?: string | null): string {
  if (code && currencies.some((c) => c.code === code)) return code;
  return getBaseCode();
}

/** 展示币种金额（分 → 带符号两位小数） */
export function money(cents: number, symbol: string): string {
  return `${symbol}${(Number(cents) / 100).toFixed(2)}`;
}

/**
 * 加密货币快照还原（文档L §2.5）：coin_units 是「币数 × 10^coin_decimals」的整数，
 * 必须配上同刻快照的小数位才读得出来；小数位与后端 coinQuoteOf 的 toFixed 同口径，
 * 保证审核抽屉里的数字和顾客票据上的一模一样。非加密货币分项返回 null（不显示币种行）。
 */
export function coinOf(units: number | null, decimals: number | null): string | null {
  if (units === null || decimals === null) return null;
  const d = Number(decimals) > 0 ? Number(decimals) : 2;
  return (Number(units) / 10 ** d).toFixed(d);
}

export const yuanToCents = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** UTC ISO → 本地「年-月-日 时:分:秒」：直接截取 UTC 串会让非 +0 时区的用户看到差数小时的时刻 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** UTC ISO → 本地「年-月-日」：跨零点的有效期不再按 UTC 截取而错一天；纯日期串（无时间分量，无时区可挪）原样返回 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// —— HB1 惰性心跳：进入交易页时顺带跑到期任务（服务端 60s/主体节流，429 忽略）——
let lastTickAt = 0;
export async function lazyTick(token: "user" | "admin" = "user"): Promise<void> {
  const now = Date.now();
  if (now - lastTickAt < 55_000) return;
  lastTickAt = now;
  try {
    await call("tasks/tick", { method: "POST", token, body: {} });
  } catch {
    /* 节流或离线：展示优先 */
  }
}

/** 支付死线倒计时（PENDING_REVIEW 由后端豁免，expired 字段以服务端为准） */
export function useDeadline(deadline: string | null | undefined, expired: boolean) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  if (!deadline) return { text: "", left: false };
  const leftMs = Date.parse(deadline) - nowMs;
  if (expired || leftMs <= 0) return { text: text("trade.deadline_passed", "支付时限已过"), left: false };
  const s = Math.floor(leftMs / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    text: d > 0
      ? text("trade.deadline_days", "剩 {d} 天 {h}:{m}", { d, h: pad(h), m: pad(m) })
      : text("trade.deadline_hms", "剩 {h}:{m}:{s}", { h: pad(h), m: pad(m), s: pad(sec) }),
    left: true,
  };
}

/** 页面级取数：load/refresh + loading/failed 态（购物端与后台共用，不含加载动画） */
export function useLoader<T>(factory: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    factory()
      .then((r) => { if (alive) setData(r); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error && e.message ? e.message : text("common.load_failed", "加载失败")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // deps 由调用方固定形状，nonce 驱动手动刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, loading, error, refresh };
}
