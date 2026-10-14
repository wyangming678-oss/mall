// 金币兑换商城共享类型 / 文案（文档F；接口 CI1–CI6，functions/coins.mjs 回显）
// 金币=完全独立激励货币：无币种、不接算价/退款链，展示只做千分位整数。
import { text } from "./i18n";
import type { AddressRow } from "./trade";

/** 千分位整数 + 「金币」单位（金币是无量纲整数，不走 formatBase） */
export function coinText(n: number): string {
  return `${Math.trunc(Number(n) || 0).toLocaleString("en-US")}`;
}

// —— CI1 概览 / 流水 ——
export interface CoinTxn {
  id: string;
  user_id: string;
  txn_type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  ref_type: string | null;
  ref_id: string | null;
  remark: string | null;
  created_at: string;
}
export interface CoinCheckinBonusStep { streak: number; bonus: number }
export interface CoinOverview {
  balance: number;
  total_earned: number;
  total_spent: number;
  checked_in_today: boolean;
  streak_days: number;
  today_reward_base: number;
  rules: {
    checkin_base: number;
    bonus_schedule: CoinCheckinBonusStep[];
    order_reward_enabled: boolean;
    order_reward_rate_bp: number;
  };
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: CoinTxn[];
}

// —— CI2 签到 ——
export interface CheckinResult {
  checkin_id: string;
  checkin_date: string;
  streak_days: number;
  base_amount: number;
  bonus_amount: number;
  reward_amount: number;
  balance: number;
}

// —— CI3/CI4 兑换项 ——
export interface CoinCouponKey {
  name: string;
  name_i18n: Record<string, string>;
  coupon_type: string;
  threshold_amount_base: number;
  discount_amount_base: number;
  scope: string;
  valid_days: number;
  valid_until: string | null;
}
export interface CoinItemCard {
  id: string;
  item_type: string;
  title: string;
  title_i18n: Record<string, string> | null;
  description: string;
  images: string[];
  coin_price: number;
  stock_mode: string;
  stock_available: number | null;
  per_user_limit: number;
  redeemed_count: number;
  status: string;
  sort_order: number;
  coupon_template_id: string | null;
  sku_id: string | null;
  vip_plan_id: string | null;
  vip_duration_days: number | null;
  need_address: boolean;
  created_at: string;
  updated_at: string;
  redeemed_count_by_user: number;
  can_redeem: boolean;
  blocked_reason: string | null;
  image_urls: string[];
}
/** CI4 权益项带出的会员套餐快照（三档共用同一套餐，只差时长） */
export interface CoinVipKey {
  name: string;
  name_i18n: Record<string, string>;
  discount_rate: number;
  benefits: string[];
}
export interface CoinItemDetail extends CoinItemCard {
  coupon: CoinCouponKey | null;
  vip: CoinVipKey | null;
}

// —— CI5 兑换结果 ——
export interface RedeemResult {
  redemption_id: string;
  status: string;
  item_type: string;
  coin_amount: number;
  balance: number;
  coupon_instance_id: string | null;
  user_vip_id: string | null;
  vip_expire_at: string | null;
  need_ship: boolean;
}

// —— CI6 我的兑换 ——
export interface CoinRedemptionRow {
  id: string;
  user_id: string;
  coin_item_id: string;
  item_type: string;
  title_snapshot: string;
  coin_amount: number;
  status: string;
  coupon_instance_id: string | null;
  virtual_snapshot: string | null;
  user_vip_id: string | null;
  vip_status: string | null;
  vip_expire_at: string | null;
  address_snapshot: AddressRow | null;
  ship_company: string | null;
  ship_no: string | null;
  created_at: string;
  updated_at: string;
  image_urls: string[];
  coupon_status: string | null;
}
export interface CoinRedemptionPage {
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: CoinRedemptionRow[];
}

// —— 文案表 ——
export const COIN_TXN_TEXT: Record<string, string> = { /* i18n-fallback */
  checkin: "每日签到",
  checkin_bonus: "连签加成",
  order_reward: "收货返币",
  invite_reward: "邀请返币",
  redeem_coupon: "兑换优惠券",
  redeem_item: "兑换商品",
  admin_adjust: "后台调整",
  revoke: "兑换撤销退回",
};

export const COIN_ITEM_TYPE_TEXT: Record<string, string> = { /* i18n-fallback */
  coupon: "优惠券",
  vip: "会员权益",
  physical: "实物商品",
  virtual: "虚拟权益", // 历史项（文档P §2 已停售），只为旧兑换单/流水留标签，不进录入选项
};

export const REDEMPTION_STATUS_TEXT: Record<string, string> = { /* i18n-fallback */
  REDEEMED: "已兑换",
  PENDING_SHIP: "待发货",
  SHIPPED: "已发货",
  RECEIVED: "已收货",
  REVOKED: "已撤销",
};

/** 兑换按钮不可用原因（CI3/CI4 的 blocked_reason） */
export const REDEEM_BLOCKED_TEXT: Record<string, string> = { /* i18n-fallback */
  item_offline: "已下架",
  out_of_stock: "已兑完",
  redeem_limit_reached: "已达上限",
  insufficient_coins: "金币不足",
};

/** 连续签到阶梯文案：按 streak 升序拼「连签 N 天 +M」 */
export function bonusScheduleText(schedule: CoinCheckinBonusStep[] | undefined): string {
  const list = (schedule ?? []).filter((s) => Number(s.bonus) > 0).sort((a, b) => a.streak - b.streak);
  if (!list.length) return "";
  return list.map((s) => text("coins.bonus_step", "连签 {n} 天 +{c}", { n: s.streak, c: coinText(s.bonus) })).join(" · ");
}

/** 下单返币比例文案：万分比 → 「实付 x% 返币」 */
export function orderRewardText(rateBp: number): string {
  const pct = Number(rateBp) / 100;
  if (!(pct > 0)) return "";
  return text("coins.order_reward", "完成订单按实付 {pct}% 返金币", { pct: Number(pct.toFixed(2)) });
}
