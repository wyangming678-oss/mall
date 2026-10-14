// 订单三维状态基元（文档B §1.1/§1.3/§1.4）：常量、合法组合断言、状态轨迹、完结动作、可执行动作计算
import { AppError } from "./errors.mjs";
import { emit } from "./notify.mjs";
import { onOrderCompleted } from "./invite.mjs";
import { coinOrderReward } from "./coins.mjs";
import { nowIso } from "./validate.mjs";

// 文档B §1.4 合法组合矩阵（REFUNDING/REFUNDED 的物流维按实际保留，故用前缀匹配）
const LEGAL = new Set([
  "PENDING_PAYMENT|UNPAID|NOT_SHIPPED",
  "PENDING_PAYMENT|PENDING_REVIEW|NOT_SHIPPED",
  "PENDING_PAYMENT|REJECTED|NOT_SHIPPED",
  "PAID|PAID|NOT_SHIPPED",
  "SHIPPED|PAID|SHIPPED",
  "COMPLETED|PAID|DELIVERED",
  // 分期（文档N D1：首付到账即生效）：status_order 走 PAID/SHIPPED/COMPLETED 正常推进，
  // status_payment 停在 INSTALLMENT_ACTIVE，末期凑满才翻 PAID（复用上面 PAID|PAID 三行）。
  "PAID|INSTALLMENT_ACTIVE|NOT_SHIPPED",
  "SHIPPED|INSTALLMENT_ACTIVE|SHIPPED",
  "COMPLETED|INSTALLMENT_ACTIVE|DELIVERED",
  "CANCELLED|UNPAID|NOT_SHIPPED",
  "CANCELLED|REJECTED|NOT_SHIPPED",
  "REFUNDED|REFUNDED|NOT_SHIPPED",
  "REFUNDED|REFUNDED|SHIPPED",
  "REFUNDED|REFUNDED|DELIVERED",
]);
const FREE_SHIPPING_DIM = new Set(["REFUNDING"]);

export function comboKey(order) {
  return `${order.status_order}|${order.status_payment}|${order.status_shipping}`;
}

// 每次跨维写入后断言；非法组合视为 bug（文档B §1.4）
export function assertLegalCombo(order) {
  if (FREE_SHIPPING_DIM.has(order.status_order)) return true;
  if (!LEGAL.has(comboKey(order))) throw new AppError(500, "internal_error", "订单状态组合非法");
  return true;
}

export async function writeStatusLog(supabase, {
  orderId, dim, fromStatus, toStatus, operatorType, operatorId = null, reason = null,
}) {
  const { error } = await supabase.from("order_status_logs").insert({
    id: crypto.randomUUID(),
    order_id: orderId,
    dim,
    from_status: fromStatus,
    to_status: toStatus,
    operator_type: operatorType,
    operator_id: operatorId,
    reason,
    created_at: nowIso(),
  });
  return !error;
}

export async function readOrder(supabase, orderId) {
  const { data } = await supabase.from("orders")
    .select("id,order_no,user_id,status_order,status_payment,status_shipping,goods_amount_base,discount_amount_base,freight_amount_base,actual_paid_amount_base,currency_code,currency_rate_scaled,currency_actual_amount,currency_name_snapshot,payment_deadline,address_snapshot,pricing_snapshot,coupon_instance_id,pre_refund_status,buyer_remark,cancel_reason,cancelled_at,extra,installment_count,installment_config,shipped_at,created_at,updated_at")
    .eq("id", orderId).maybeSingle();
  return data ?? null;
}

export async function readOrderItems(supabase, orderIds) {
  if (!orderIds.length) return new Map();
  const { data } = await supabase.from("order_items")
    .select("id,order_id,product_id,sku_id,title_snapshot,image_snapshot,spec_snapshot,price_base_snapshot,currency_price_snapshot,quantity,subtotal_base")
    .in("order_id", orderIds).order("created_at", { ascending: true });
  const map = new Map();
  for (const it of data ?? []) {
    if (!map.has(it.order_id)) map.set(it.order_id, []);
    map.get(it.order_id).push(it);
  }
  return map;
}

// 死线判定：PENDING_REVIEW 豁免（文档B §1.5）
export function isExpired(order, nowMs = Date.now()) {
  if (order.status_order !== "PENDING_PAYMENT") return false;
  if (order.status_payment === "PENDING_REVIEW") return false;
  return Date.parse(order.payment_deadline) <= nowMs;
}

// 详情页 allowed_actions（文档C O3）
export function allowedActions(order, nowMs = Date.now()) {
  const pending = order.status_order === "PENDING_PAYMENT";
  const expired = isExpired(order, nowMs);
  const inReview = order.status_payment === "PENDING_REVIEW";
  const installmentActive = order.status_payment === "INSTALLMENT_ACTIVE";
  return {
    can_pay: pending && !expired && !inReview,
    can_cancel: pending,
    can_confirm_receipt: order.status_order === "SHIPPED",
    // 分期进行中的单不做在线退款（只付了首付即放开退款 = 退多于付）；末期凑满翻 PAID 后才走正常退款链路
    can_refund: order.status_order === "PAID" && order.status_payment === "PAID" && order.status_shipping === "NOT_SHIPPED",
    // 首付即生效、未发货前允许改址：status_order=PAID 已覆盖 INSTALLMENT_ACTIVE 与 PAID 两种
    can_change_address: pending || (order.status_order === "PAID" && order.status_shipping === "NOT_SHIPPED"),
    pay_blocked_reason: pending && expired ? "deadline_passed" : (inReview ? "in_review" : null),
    installment_active: installmentActive,
  };
}

// SHIPPED → COMPLETED + DELIVERED（O5 / OD5 / T2 共用；CAS 0 行=已被处理）
export async function settleComplete(supabase, { order, operatorType, operatorId = null, reason = null }) {
  const now = nowIso();
  const { data: cas } = await supabase.from("orders")
    .update({ status_order: "COMPLETED", status_shipping: "DELIVERED", updated_at: now })
    .eq("id", order.id).eq("status_order", "SHIPPED").eq("status_shipping", "SHIPPED")
    .select("id");
  if (!cas?.length) return { completed: false };
  await writeStatusLog(supabase, {
    orderId: order.id, dim: "order", fromStatus: "SHIPPED", toStatus: "COMPLETED", operatorType, operatorId, reason,
  });
  await writeStatusLog(supabase, {
    orderId: order.id, dim: "shipping", fromStatus: "SHIPPED", toStatus: "DELIVERED", operatorType, operatorId, reason,
  });
  const next = { ...order, status_order: "COMPLETED", status_shipping: "DELIVERED" };
  assertLegalCombo(next);
  // §7 first_order（basis=completed 时在此登记；paid 口径已在支付环节登记，UNIQUE 保证只此一次）
  const invited = await onOrderCompleted(supabase, next);
  const notice = operatorType === "system"
    ? "订单已自动确认收货，如需售后请在有效期内联系客服"
    : `订单 ${order.order_no ?? order.id} 已确认收货，交易完成`;
  await emit(supabase, {
    userId: order.user_id, msgType: "order_completed", title: "订单已完成",
    content: notice, refType: "order", refId: order.id,
  });
  // 金币返币（决策 D-2：收货后置发放，幂等 per order；失败不影响订单完结，重放补发）
  let coinReward = null;
  try {
    coinReward = await coinOrderReward(supabase, next);
  } catch { /* 返币异常不阻断主流程 */ }
  return {
    completed: true,
    order: next,
    invite_reward_registered: invited.created === true,
    coin_reward_granted: coinReward?.granted === true,
    coin_reward_amount: coinReward?.reward_amount ?? 0,
  };
}
