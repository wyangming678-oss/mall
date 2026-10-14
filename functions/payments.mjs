// 支付分项 / 转账凭证 / 审核槽（文档B §3、文档C §四 Y1–Y5/W2 与 §六.3 PF1–PF4）
import { AppError } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { getCurrencyOrBase } from "./config.mjs";
import { verifyPassword } from "./crypto.mjs";
import { signedUrlForKey } from "./files.mjs";
import { channelRegistry, coinQuoteOf, coinSnapshot, enabledChannel, fulfillmentOfMethod, pricedChains, toDisplayAmount } from "./channels.mjs";
import { applyStockChange } from "./inventory.mjs";
import { changeBalance, vAmount } from "./wallet.mjs";
import { assertLegalCombo, isExpired, readOrder, writeStatusLog } from "./order_state.mjs";
import { markCouponUsed } from "./coupons.mjs";
import { emit } from "./notify.mjs";
import { onFirstRecharge, onOrderPaid } from "./invite.mjs";
import { grantVipFromPayment } from "./vip.mjs";
import {
  billRowsFromSnapshot, confirmedPeriodsByIndex, isInstallmentOrder, periodAmountOf, snapshotPeriods,
} from "./installments.mjs";
import { nowIso, pageParams, pageResult, vEnum, vInt, vStr, vUuid } from "./validate.mjs";

const OPEN_PAYMENT_STATUS = ["PENDING_SUBMIT", "PENDING_REVIEW", "CONFIRMED", "REJECTED"];
// coin_symbol / coin_network / coin_units / coin_decimals：文档L 加密货币出票当刻的币种快照（所选币种 + 链 + 应付币数 + 当时的小数位）
// installment_index：文档N 分期分项冲抵的期序（1=首付）；NULL=普通全额支付/历史单
const PAYMENT_COLS = "id,payment_type,target_type,target_id,user_id,method,amount_base,amount_currency,currency_code,coin_symbol,coin_network,coin_units,coin_decimals,installment_index,status,reject_reason,reviewed_by,reviewed_at,created_at,updated_at";
const PROOF_COLS = "id,payment_id,image_key,transaction_no,amount_declared,uploaded_by,review_status,reviewer_admin_id,reviewed_at,reject_reason,created_at";
const PROOF_KEY_RE = /^proofs\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
export const REVIEW_SLOT_TTL_MS = 15 * 60 * 1000;

async function paymentsOfOrder(supabase, orderId) {
  const { data } = await supabase.from("payments").select(PAYMENT_COLS)
    .eq("target_type", "order").eq("target_id", orderId).order("created_at", { ascending: true });
  return data ?? [];
}

// 订单分项 + 凭证（O3/OD2 共用；凭证只下发签名 URL，不下发对象键）
export async function paymentsWithProofs(supabase, orderId) {
  const rows = await paymentsOfOrder(supabase, orderId);
  const ids = rows.map((p) => p.id);
  const proofs = ids.length
    ? (await supabase.from("payment_proofs").select(PROOF_COLS).in("payment_id", ids)
      .order("created_at", { ascending: true })).data ?? []
    : [];
  return Promise.all(rows.map(async (p) => ({
    ...p,
    amount_base: Number(p.amount_base),
    amount_currency: Number(p.amount_currency),
    coin_network: p.coin_network || null,
    coin_units: p.coin_units === null ? null : Number(p.coin_units),
    coin_decimals: p.coin_decimals === null ? null : Number(p.coin_decimals),
    proofs: await Promise.all(proofs.filter((f) => f.payment_id === p.id).map(async (f) => ({
      id: f.id, transaction_no: f.transaction_no, amount_declared: Number(f.amount_declared),
      review_status: f.review_status, reject_reason: f.reject_reason,
      reviewed_at: f.reviewed_at, created_at: f.created_at,
      image_url: await signedUrlForKey(f.image_key),
    }))),
  })));
}

const sumBy = (rows, statuses) => rows
  .filter((p) => statuses.includes(p.status))
  .reduce((sum, p) => sum + Number(p.amount_base), 0);

// 余额扣款幂等键的尝试序号：驳回/过期重付会留下历史 BALANCE 行，须与上一次扣款键区分
const attemptOf = (rows) => rows.filter((p) => p.method === "BALANCE").length + 1;

async function setStatus(supabase, paymentId, from, to, patch = {}) {
  const { data } = await supabase.from("payments")
    .update({ status: to, updated_at: nowIso(), ...patch })
    .eq("id", paymentId).eq("status", from).select("id");
  return data?.length === 1;
}

// 审核槽键：订单类按 order_id 互斥（文档A §19 UNIQUE(order_id)）；
// VIP 扫码按 payment_id——套餐 id 是全局的，按 target_id 会让不同买家抢同一份审核位
const slotKeyOf = (payment) => (payment.payment_type === "VIP_PURCHASE" ? payment.id : payment.target_id);

// 用户本单可支付的订单（含归属、状态、死线三重前置）
async function payableOrder(supabase, principal, orderIdValue, field = "order_id") {
  const orderId = vUuid(orderIdValue, field);
  const order = await readOrder(supabase, orderId);
  if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
  if (order.status_order !== "PENDING_PAYMENT") {
    throw new AppError(409, "state_conflict", "订单当前不可支付",
      { order_id: order.id, status_order: order.status_order });
  }
  // 分期单不能走全额支付入口（首付只付 30%、尾款逐期付）；必须用 installment/* 端点
  if (isInstallmentOrder(order)) {
    throw new AppError(409, "state_conflict", "分期订单请从分期入口支付", { order_id: order.id });
  }
  if (isExpired(order)) {
    throw new AppError(410, "deadline_passed", "支付时限已过", { payment_deadline: order.payment_deadline });
  }
  const rows = await paymentsOfOrder(supabase, order.id);
  return { order, rows };
}

const amountOfOrder = (order) => Number(order.actual_paid_amount_base);

// —— 订单生效副作用（非分期全额支付 与 分期首付解锁 共用，一次性）——
// 扣库存 / 核销券 / 登记邀请首单 / 发站内信；订单两维写 status_order=PAID + status_payment=targetPayment。
async function activateOrder(supabase, { order, targetPayment, operatorType, operatorId, reason }) {
  const { data: cas } = await supabase.from("orders")
    .update({ status_order: "PAID", status_payment: targetPayment, updated_at: nowIso() })
    .eq("id", order.id).eq("status_order", "PENDING_PAYMENT").eq("status_payment", order.status_payment).select("id");
  if (!cas?.length) return { activated: false, conflict: true };
  await writeStatusLog(supabase, {
    orderId: order.id, dim: "order", fromStatus: "PENDING_PAYMENT", toStatus: "PAID",
    operatorType, operatorId, reason,
  });
  await writeStatusLog(supabase, {
    orderId: order.id, dim: "payment", fromStatus: order.status_payment, toStatus: targetPayment,
    operatorType, operatorId, reason,
  });
  const { data: items } = await supabase.from("order_items")
    .select("id,sku_id,quantity").eq("order_id", order.id);
  const deductFailures = [];
  for (const it of items ?? []) {
    const res = await applyStockChange(supabase, {
      skuId: it.sku_id, changeType: "deduct", quantity: Number(it.quantity),
      referenceType: "order", referenceId: order.id, operator: operatorId ?? "system", reason: "支付成功扣减",
    });
    if (!res.ok) deductFailures.push({ sku_id: it.sku_id, reason: res.reason });
  }
  assertLegalCombo({ ...order, status_order: "PAID", status_payment: targetPayment });

  // §4 券 USED：随订单生效推进（order_id 绑定，重复调用幂等）
  const { data: locked } = await supabase.from("user_coupons")
    .select("id").eq("order_id", order.id).eq("status", "LOCKED");
  const usedCoupons = [];
  for (const row of locked ?? []) {
    const res = await markCouponUsed(supabase, { couponId: row.id, orderId: order.id });
    usedCoupons.push({ coupon_id: row.id, ...res });
  }

  // §7 first_order 触发登记（basis=paid 时；PENDING，真正到账由惰性结算推进）
  const invited = await onOrderPaid(supabase, { ...order, status_order: "PAID", status_payment: targetPayment });

  return {
    activated: true, deduct_failures: deductFailures,
    used_coupons: usedCoupons, invite_reward_registered: invited.created === true,
  };
}

// 分期首付确认到账 → 建账单（幂等：按期序去重）→ 首付那期标 PAID → 走生效副作用（订单进 INSTALLMENT_ACTIVE）
async function unlockInstallment(supabase, { order, rows, operatorType, operatorId, reason }) {
  const depositBase = Number(order.installment_config?.deposit_amount_base ?? 0);
  const confirmed = sumBy(rows, ["CONFIRMED"]);
  if (confirmed < depositBase) return { advanced: false, confirmed_base: confirmed, deposit_base: depositBase };
  const { data: existing } = await supabase.from("order_installments").select("installment_index").eq("order_id", order.id);
  const existingIdx = new Set((existing ?? []).map((r) => Number(r.installment_index)));
  const billRows = billRowsFromSnapshot(order.id, order.installment_config, existingIdx);
  if (billRows.length) {
    const { error } = await supabase.from("order_installments").insert(billRows);
    if (error) throw new AppError(500, "internal_error");
  }
  const depositPayment = rows.find((p) => p.status === "CONFIRMED" && Number(p.installment_index) === 1);
  const now = nowIso();
  await supabase.from("order_installments")
    .update({ status: "PAID", payment_id: depositPayment?.id ?? null, paid_at: now, updated_at: now })
    .eq("order_id", order.id).eq("installment_index", 1).eq("status", "PENDING");
  const res = await activateOrder(supabase, { order, targetPayment: "INSTALLMENT_ACTIVE", operatorType, operatorId, reason });
  if (!res.activated) return { advanced: false, conflict: true };
  await emit(supabase, {
    userId: order.user_id, msgType: "installment_started", title: "分期已开通",
    content: `订单 ${order.order_no} 首付已确认，我们将尽快发货；请在账单里按期支付尾款`,
    refType: "order", refId: order.id,
  });
  return { ...res, advanced: true, installment: true, status_payment: "INSTALLMENT_ACTIVE" };
}

// —— Σ 判定：非分期全额 CONFIRMED=应付 → PAID + 副作用；分期首付 CONFIRMED≥首付 → 解锁进 INSTALLMENT_ACTIVE ——
async function advanceOrderPaid(supabase, { order, operatorType = "system", operatorId = null, reason = "支付完成" }) {
  if (!order || order.status_order !== "PENDING_PAYMENT") return { advanced: false };
  const rows = await paymentsOfOrder(supabase, order.id);
  const confirmed = sumBy(rows, ["CONFIRMED"]);
  const actual = amountOfOrder(order);
  if (isInstallmentOrder(order)) {
    return unlockInstallment(supabase, { order, rows, operatorType, operatorId, reason });
  }
  if (confirmed !== actual) return { advanced: false, confirmed_base: confirmed, actual_base: actual };
  const res = await activateOrder(supabase, { order, targetPayment: "PAID", operatorType, operatorId, reason });
  if (!res.activated) return { advanced: false, conflict: true };
  await emit(supabase, {
    userId: order.user_id, msgType: "order_paid", title: "支付成功",
    content: `订单 ${order.order_no} 已支付成功，我们会在发货后第一时间通知你`,
    refType: "order", refId: order.id,
  });
  return { ...res, advanced: true, confirmed_base: confirmed };
}

// 账单回填：把「已 CONFIRMED 且带 installment_index」的分项对应期次标 PAID（幂等，可多期共用一笔结清分项）。
// billRows=当前 order_installments 行；confirmedPayments=已 CONFIRMED 分项（升序）。
async function markPaidPeriods(supabase, orderId, billRows, confirmedPayments) {
  const now = nowIso();
  const byIndex = new Map();
  for (const p of confirmedPayments) {
    const idx = Number(p.installment_index);
    if (idx >= 1 && !byIndex.has(idx)) byIndex.set(idx, p);
  }
  for (const [idx, pay] of byIndex) {
    if (!billRows.some((r) => Number(r.installment_index) === idx)) continue;
    await supabase.from("order_installments")
      .update({ status: "PAID", payment_id: pay.id, paid_at: pay.created_at ?? now, updated_at: now })
      .eq("order_id", orderId).eq("installment_index", idx).eq("status", "PENDING");
  }
}

// 分期单：某尾期到账后回填账单，末期凑满 ΣCONFIRMED≥应付 → 只翻状态 INSTALLMENT_ACTIVE→PAID（绝不重跑副作用）
async function settleInstallment(supabase, { order, operatorType = "system", operatorId = null, reason = "尾款到账" }) {
  const rows = await paymentsOfOrder(supabase, order.id);
  const confirmed = sumBy(rows, ["CONFIRMED"]);
  const actual = amountOfOrder(order);
  const { data: billRows } = await supabase.from("order_installments")
    .select("installment_index,status,payment_id,paid_at").eq("order_id", order.id);
  await markPaidPeriods(supabase, order.id, billRows ?? [], rows.filter((p) => p.status === "CONFIRMED"));
  const now = nowIso();
  // 结清时把仍缺期序映射的 PENDING 期（多为提前结清单笔覆盖）统一标 PAID，账本与状态一致
  if (confirmed >= actual) {
    await supabase.from("order_installments")
      .update({ status: "PAID", paid_at: now, updated_at: now })
      .eq("order_id", order.id).eq("status", "PENDING");
  }
  if (confirmed < actual) return { advanced: false, settled: false, confirmed_base: confirmed, actual_base: actual };
  const { data: cas } = await supabase.from("orders")
    .update({ status_payment: "PAID", updated_at: now })
    .eq("id", order.id).eq("status_order", order.status_order).eq("status_payment", "INSTALLMENT_ACTIVE").select("id");
  if (!cas?.length) return { advanced: false, settled: false, conflict: true };
  await writeStatusLog(supabase, {
    orderId: order.id, dim: "payment", fromStatus: "INSTALLMENT_ACTIVE", toStatus: "PAID",
    operatorType, operatorId, reason,
  });
  assertLegalCombo({ ...order, status_payment: "PAID" });
  await emit(supabase, {
    userId: order.user_id, msgType: "installment_settled", title: "分期已结清",
    content: `订单 ${order.order_no} 的全部分期已结清，感谢你的信任`,
    refType: "order", refId: order.id,
  });
  return { advanced: true, settled: true, confirmed_base: confirmed, status_payment: "PAID" };
}

// —— 取消/关单时的分项处置：未确认→EXPIRED，已确认余额分项 refund_in 退还（文档B §3 末行）——
export async function settlePaymentsOnCancel(supabase, { order, reason }) {
  const rows = await paymentsOfOrder(supabase, order.id);
  const reg = await channelRegistry(supabase);
  const expired = [];
  const refunded = [];
  for (const p of rows) {
    if (p.status === "CONFIRMED") {
      // 仅即时到账（站内余额）分项才在取消时原路退回 wallet；扫码/在线仍走人工线下退款
      if (fulfillmentOfMethod(reg, p.method) !== "instant") continue;
      const credit = await changeBalance(supabase, {
        userId: p.user_id, amount: Number(p.amount_base), txnType: "refund_in",
        refType: "order", refId: order.id, idemKey: `refund:balance:${p.id}`, remark: reason,
      });
      if (credit.ok || credit.reason === "duplicated") {
        if (await setStatus(supabase, p.id, "CONFIRMED", "EXPIRED", { reject_reason: reason })) refunded.push(p.id);
      }
      continue;
    }
    if (OPEN_PAYMENT_STATUS.includes(p.status) && p.status !== "CONFIRMED") {
      if (await setStatus(supabase, p.id, p.status, "EXPIRED", { reject_reason: reason })) expired.push(p.id);
    }
    await supabase.from("payment_proofs")
      .update({ review_status: "rejected", reject_reason: reason, reviewed_at: nowIso() })
      .eq("payment_id", p.id).eq("review_status", "pending");
  }
  await releaseSlot(supabase, order.id);
  return { expired_payment_ids: expired, refunded_payment_ids: refunded };
}

// —— 审核槽（文档B §11）——
async function releaseSlot(supabase, slotKey) {
  const { data } = await supabase.from("proof_review_slot")
    .update({ released_at: nowIso() })
    .eq("order_id", slotKey).is("released_at", null).select("id");
  return data?.length ?? 0;
}

async function assertSlotHolder(supabase, slotKey, adminId) {
  const { data } = await supabase.from("proof_review_slot")
    .select("id,reserved_by,reserved_at,released_at").eq("order_id", slotKey).maybeSingle();
  if (!data || data.released_at || data.reserved_by !== adminId) {
    throw new AppError(403, "audit_slot_held", "需要由当前审核人持有该凭证的审核位", null);
  }
  return data;
}

// —— PF1 认领审核位 ——
export async function proofClaim(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "payment.review");
  let payment = null;
  if (body.payment_id) {
    const { data } = await supabase.from("payments").select(PAYMENT_COLS)
      .eq("id", vUuid(body.payment_id, "payment_id")).maybeSingle();
    payment = data;
  } else {
    const orderId = vUuid(body.order_id, "order_id");
    const rows = await paymentsOfOrder(supabase, orderId);
    payment = rows.find((p) => p.status === "PENDING_REVIEW") ?? null;
  }
  if (!payment) throw new AppError(404, "not_found", "没有待审核的支付分项");
  if (payment.status !== "PENDING_REVIEW") {
    throw new AppError(409, "state_conflict", "该分项不在待审核状态", { status: payment.status });
  }
  const slotKey = slotKeyOf(payment);
  const now = nowIso();
  const { error } = await supabase.from("proof_review_slot").insert({
    id: crypto.randomUUID(), order_id: slotKey, payment_id: payment.id,
    reserved_by: actor.id, reserved_at: now, released_at: null,
  });
  const base = { payment_id: payment.id, slot_key: slotKey, reserved_at: now, ttl_ms: REVIEW_SLOT_TTL_MS };
  if (!error) return { claimed: true, ...base };
  if (error.code !== "23505") throw new AppError(500, "internal_error");
  const { data: existing } = await supabase.from("proof_review_slot")
    .select("id,reserved_by,reserved_at,released_at").eq("order_id", slotKey).maybeSingle();
  if (!existing) throw new AppError(409, "claim_conflict", "审核位状态已变化，请重试", null);
  if (existing.reserved_by === actor.id) {
    await supabase.from("proof_review_slot")
      .update({ reserved_at: now, released_at: null, payment_id: payment.id }).eq("id", existing.id);
    return { claimed: true, renewed: true, ...base };
  }
  if (existing.released_at) {
    const { data: taken } = await supabase.from("proof_review_slot")
      .update({ reserved_by: actor.id, reserved_at: now, released_at: null, payment_id: payment.id })
      .eq("id", existing.id).eq("reserved_by", existing.reserved_by).eq("released_at", existing.released_at)
      .select("id");
    if (taken?.length) return { claimed: true, taken_over: true, ...base };
    throw new AppError(409, "claim_conflict", "审核位抢占失败，请重试", null);
  }
  throw new AppError(403, "audit_slot_held", "该凭证正在被其他管理员审核",
    { reserved_at: existing.reserved_at, ttl_ms: REVIEW_SLOT_TTL_MS });
}

// —— PF2 心跳续期 ——
export async function proofHeartbeat(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "payment.review");
  let slotKey = body.order_id ? vUuid(body.order_id, "order_id") : null;
  if (!slotKey) {
    const { data: p } = await supabase.from("payments").select("id,payment_type,target_id")
      .eq("id", vUuid(body.payment_id, "payment_id")).maybeSingle();
    if (!p) throw new AppError(404, "not_found", "支付分项不存在");
    // 订单/充值按 target 互斥，VIP 按分项自身（套餐 id 全局唯一，会跨买家抢位）
    slotKey = slotKeyOf(p);
  }
  const now = nowIso();
  const { data } = await supabase.from("proof_review_slot")
    .update({ reserved_at: now }).eq("order_id", slotKey).eq("reserved_by", actor.id).is("released_at", null)
    .select("id");
  if (!data?.length) throw new AppError(409, "claim_conflict", "审核位已失效或不属于当前管理员", null);
  return { slot_key: slotKey, reserved_at: now, ttl_ms: REVIEW_SLOT_TTL_MS };
}

// —— PF3 审核（⚠ approve → Σ 判定；reject → 必填原因 + 释放位，死线不动）——
export async function proofReview(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "payment.review");
  const paymentId = vUuid(body.payment_id, "payment_id");
  const decision = vEnum(body.decision, "decision", ["approve", "reject"]);
  const rejectReason = decision === "reject"
    ? vStr(body.reject_reason, "reject_reason", { min: 2, max: 200 }) : null;
  const { data: payment } = await supabase.from("payments").select(PAYMENT_COLS).eq("id", paymentId).maybeSingle();
  if (!payment) throw new AppError(404, "not_found", "支付分项不存在");
  const order = payment.payment_type === "ORDER_PAYMENT" ? await readOrder(supabase, payment.target_id) : null;
  await assertSlotHolder(supabase, slotKeyOf(payment), actor.id);
  const to = decision === "approve" ? "CONFIRMED" : "REJECTED";
  const now = nowIso();
  const flipped = await setStatus(supabase, payment.id, "PENDING_REVIEW", to,
    { reviewed_by: actor.id, reviewed_at: now, reject_reason: rejectReason });
  if (!flipped) throw new AppError(409, "state_conflict", "该分项已不在待审核状态", { status: payment.status });
  await supabase.from("payment_proofs")
    .update({
      review_status: decision === "approve" ? "approved" : "rejected",
      reviewer_admin_id: actor.id, reviewed_at: now, reject_reason: rejectReason,
    })
    .eq("payment_id", payment.id).eq("review_status", "pending");
  await releaseSlot(supabase, slotKeyOf(payment));
  let advanced = null;
  let credited = null;
  let granted = null;
  if (decision === "approve") {
    if (payment.payment_type === "ORDER_PAYMENT") {
      // 分期单已进 INSTALLMENT_ACTIVE ⇒ 这是某尾期到账，只回填账单 + 判结清翻状态，绝不重跑生效副作用；
      // 首付/非分期单仍走 advanceOrderPaid（首付那一跳会在内部跳 unlockInstallment 建账单并生效）。
      advanced = order && isInstallmentOrder(order) && order.status_payment === "INSTALLMENT_ACTIVE"
        ? await settleInstallment(supabase, {
          order, operatorType: "admin", operatorId: actor.id, reason: "分期尾款审核通过",
        })
        : await advanceOrderPaid(supabase, {
          order, operatorType: "admin", operatorId: actor.id, reason: "转账凭证审核通过",
        });
    } else if (payment.payment_type === "WALLET_RECHARGE") {
      const res = await changeBalance(supabase, {
        userId: payment.user_id, amount: Number(payment.amount_base), txnType: "recharge",
        refType: "order", refId: payment.id, idemKey: `recharge:${payment.id}`, remark: "扫码充值人工确认到账",
      });
      if (!res.ok && res.reason !== "duplicated") {
        await setStatus(supabase, payment.id, "CONFIRMED", "PENDING_REVIEW", { reviewed_by: null, reviewed_at: null });
        throw new AppError(409, "claim_conflict", "余额入账失败，请重试", { reason: res.reason });
      }
      credited = { balance_after: res.after ?? null };
      // §7 first_recharge：仅首笔入账登记（UNIQUE(relation_id,trigger_type) 挡住后续充值）
      if (res.ok) await onFirstRecharge(supabase, payment);
      if (res.ok) {
        await emit(supabase, {
          userId: payment.user_id, msgType: "recharge_credited", title: "充值已到账",
          content: "你的扫码充值已由客服确认入账，可在钱包查看余额与流水",
          refType: "wallet_txn", refId: res.txn_id ?? null,
        });
      }
    } else if (payment.payment_type === "VIP_PURCHASE") {
      const res = await grantVipFromPayment(supabase, payment);
      if (!res.ok) {
        await setStatus(supabase, payment.id, "CONFIRMED", "PENDING_REVIEW", { reviewed_by: null, reviewed_at: null });
        throw new AppError(409, "claim_conflict", "会员开通落库失败，请重试", { reason: res.reason });
      }
      granted = res.granted;
    } else {
      await setStatus(supabase, payment.id, to, "PENDING_REVIEW", {});
      throw new AppError(409, "state_conflict", "该支付类型暂未开放后台确认", { payment_type: payment.payment_type });
    }
  } else if (order) {
    // 分期单已生效（INSTALLMENT_ACTIVE）后驳回某尾期凭证：只把该分项留在 REJECTED，买家可重传；
    // 绝不能走整单 REJECTED 补偿链（那会把首付/已确认期次的余额分项凭空退掉）。
    if (!(isInstallmentOrder(order) && order.status_payment === "INSTALLMENT_ACTIVE")) {
      await rejectOrderPaymentDim(supabase, { order, payment, actorId: actor.id, reason: rejectReason });
    }
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: `proof.${decision}`, targetType: "payment", targetId: payment.id,
    detail: {
      payment_type: payment.payment_type, amount_base: Number(payment.amount_base),
      order_no: order?.order_no ?? null, reject_reason: rejectReason,
    },
  });
  return {
    payment_id: payment.id, status: to, order_id: order?.id ?? null,
    order_paid: advanced?.advanced === true ? true : undefined,
    order_status_after: advanced?.advanced ? "PAID" : (order?.status_order ?? null),
    order_status_payment_after: advanced?.status_payment ?? (order?.status_payment ?? null),
    installment: advanced?.installment === true ? true : undefined,
    installment_settled: advanced?.settled === true ? true : undefined,
    credited_balance_after: credited?.balance_after ?? null,
    vip_granted: granted ?? undefined,
  };
}

// 扫码分项驳回 → 整单支付维 REJECTED，已确认余额分项补偿退还（文档B §3.5）
async function rejectOrderPaymentDim(supabase, { order, payment, actorId, reason }) {
  const { data } = await supabase.from("orders")
    .update({ status_payment: "REJECTED", updated_at: nowIso() })
    .eq("id", order.id).eq("status_order", "PENDING_PAYMENT").eq("status_payment", "PENDING_REVIEW").select("id");
  if (data?.length) {
    await writeStatusLog(supabase, {
      orderId: order.id, dim: "payment", fromStatus: "PENDING_REVIEW", toStatus: "REJECTED",
      operatorType: "admin", operatorId: actorId, reason,
    });
  }
  const rows = await paymentsOfOrder(supabase, order.id);
  for (const p of rows) {
    if (p.id === payment.id) continue;
    if (p.status === "PENDING_REVIEW") await setStatus(supabase, p.id, "PENDING_REVIEW", "PENDING_SUBMIT");
    if (p.status === "CONFIRMED" && p.method === "BALANCE") {
      const res = await changeBalance(supabase, {
        userId: p.user_id, amount: Number(p.amount_base), txnType: "refund_in",
        refType: "order", refId: order.id, idemKey: `refund:balance:${p.id}`, remark: "扫码分项驳回，余额分项补偿退还",
      });
      if (res.ok || res.reason === "duplicated") {
        await setStatus(supabase, p.id, "CONFIRMED", "EXPIRED", { reject_reason: "扫码分项驳回，整单重新支付" });
      }
    }
  }
  assertLegalCombo({ ...order, status_payment: "REJECTED" });
}

// —— PF4 待审队列（三类 payment_type 共用队列、严格分列）——
export async function proofQueue(supabase, request, query) {
  const { actor } = await adminGuard(supabase, request, "payment.review");
  const { offset, limit } = pageParams(query);
  const { data, error } = await supabase.from("payments").select(PAYMENT_COLS)
    .eq("status", "PENDING_REVIEW").order("created_at", { ascending: true }).range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const paymentIds = rows.map((p) => p.id);
  const proofMap = new Map();
  if (paymentIds.length) {
    const { data: proofs } = await supabase.from("payment_proofs").select(PROOF_COLS)
      .in("payment_id", paymentIds).order("created_at", { ascending: true });
    for (const f of proofs ?? []) {
      if (f.review_status === "pending" || !proofMap.has(f.payment_id)) proofMap.set(f.payment_id, f);
    }
  }
  const slotMap = new Map();
  const keys = [...new Set(rows.map(slotKeyOf))];
  if (keys.length) {
    const { data: slots } = await supabase.from("proof_review_slot").select("id,order_id,payment_id,reserved_by,reserved_at,released_at")
      .in("order_id", keys);
    for (const s of slots ?? []) slotMap.set(s.order_id, s);
  }
  const orderNoMap = new Map();
  const orderIds = rows.filter((p) => p.payment_type === "ORDER_PAYMENT").map((p) => p.target_id);
  if (orderIds.length) {
    const { data: orders } = await supabase.from("orders").select("id,order_no,actual_paid_amount_base,payment_deadline,status_payment")
      .in("id", orderIds);
    for (const o of orders ?? []) orderNoMap.set(o.id, o);
  }
  const items = await Promise.all(rows.map(async (p) => {
    const slot = slotMap.get(slotKeyOf(p)) ?? null;
    const proof = proofMap.get(p.id) ?? null;
    return {
      ...p,
      order: p.payment_type === "ORDER_PAYMENT" ? orderNoMap.get(p.target_id) ?? null : null,
      proof: proof ? {
        id: proof.id, transaction_no: proof.transaction_no, amount_declared: Number(proof.amount_declared),
        review_status: proof.review_status, created_at: proof.created_at,
        image_url: await signedUrlForKey(proof.image_key),
      } : null,
      slot: slot ? {
        held: !slot.released_at,
        mine: !slot.released_at && slot.reserved_by === actor.id,
        reserved_at: slot.reserved_at,
      } : { held: false, mine: false, reserved_at: null },
    };
  }));
  const counts = {};
  for (const it of items) counts[it.payment_type] = (counts[it.payment_type] ?? 0) + 1;
  return { ...pageResult(items, offset, limit), counts_by_type: counts };
}

// —— 支付密码校验：用户自助设置过就必校验，没设置过则不拦（后台 AU7 亦可代设/代清）——
async function assertPaymentPassword(supabase, principal, body) {
  const { data } = await supabase.from("users")
    .select("id,payment_password_hash").eq("id", principal.id).is("deleted_at", null).maybeSingle();
  if (!data?.payment_password_hash) return;
  const pin = typeof body.payment_password === "string" ? body.payment_password.trim() : "";
  if (!pin) throw new AppError(400, "payment_password_required", "余额支付需要输入支付密码", null);
  if (!(await verifyPassword(pin, data.payment_password_hash))) {
    throw new AppError(401, "payment_password_invalid", "支付密码不正确", null);
  }
}

// —— Y1 余额全额支付 ——
export async function payWithWallet(supabase, principal, body) {
  await assertPaymentPassword(supabase, principal, body);
  const { order, rows } = await payableOrder(supabase, principal, body.order_id);
  const inflight = rows.filter((p) => p.status !== "EXPIRED" && p.status !== "REJECTED");
  if (inflight.length) {
    throw new AppError(409, "state_conflict", "该订单已有支付分项，请先完成或取消", {
      payments: inflight.map((p) => ({ method: p.method, status: p.status })),
    });
  }
  const actual = amountOfOrder(order);
  const payment = await createBalancePayment(supabase, {
    order, userId: principal.id, amountBase: actual,
    idemKey: `pay:wallet:full:${order.id}#${attemptOf(rows)}`, remark: `订单 ${order.order_no} 余额支付`,
  });
  const advanced = await advanceOrderPaid(supabase, {
    order, operatorType: "user", operatorId: principal.id, reason: "余额支付即时到账",
  });
  return {
    order_id: order.id, payment_id: payment.payment_id, amount_base: actual,
    balance_after: payment.debit.after, status: advanced.advanced ? "PAID" : order.status_order,
    paid: advanced.advanced === true,
  };
}

// —— Y2 混合支付第一步：余额部分（订单两维不变，等待扫码）——
export async function payWalletPart(supabase, principal, body) {
  await assertPaymentPassword(supabase, principal, body);
  const { order, rows } = await payableOrder(supabase, principal, body.order_id);
  if (rows.some((p) => p.method === "BALANCE" && p.status !== "EXPIRED" && p.status !== "REJECTED")) {
    throw new AppError(409, "state_conflict", "该订单已有余额分项（混合支付仅允许一次）", null);
  }
  const assigned = sumBy(rows, ["CONFIRMED", "PENDING_SUBMIT", "PENDING_REVIEW"]);
  const remaining = amountOfOrder(order) - assigned;
  if (remaining <= 0) throw new AppError(409, "state_conflict", "订单已无未付差额", null);
  const amountBase = vAmount(body.amount_base, "amount_base", { min: 1, max: remaining });
  if (amountBase > remaining) {
    throw new AppError(400, "invalid_request", "金额超出未付差额", { remaining });
  }
  const payment = await createBalancePayment(supabase, {
    order, userId: principal.id, amountBase,
    idemKey: `pay:wallet:part:${order.id}#${attemptOf(rows)}`, remark: `订单 ${order.order_no} 余额部分`,
  });
  const advanced = await advanceOrderPaid(supabase, {
    order, operatorType: "user", operatorId: principal.id, reason: "余额部分支付后全额到账",
  });
  return {
    order_id: order.id, payment_id: payment.payment_id, amount_base: amountBase,
    remaining_base: advanced.advanced ? 0 : remaining - amountBase,
    balance_after: payment.debit.after,
    paid: advanced.advanced === true, status: advanced.advanced ? "PAID" : order.status_payment,
  };
}

async function createBalancePayment(supabase, { order, userId, amountBase, idemKey, remark, installmentIndex = null }) {
  const debit = await changeBalance(supabase, {
    userId, amount: -amountBase, txnType: "consume", refType: "order", refId: order.id, idemKey, remark,
  });
  if (!debit.ok) {
    if (debit.reason === "insufficient") {
      throw new AppError(409, "insufficient_balance", "余额不足",
        { balance: debit.before ?? null, required: amountBase });
    }
    if (debit.reason === "duplicated") {
      throw new AppError(409, "state_conflict", "该订单的余额扣款已入账，请刷新订单查看", null);
    }
    if (debit.reason === "conflict") throw new AppError(409, "claim_conflict", "余额正在变动，请重试", null);
    throw new AppError(500, "internal_error");
  }
  const paymentId = crypto.randomUUID();
  const now = nowIso();
  const { error } = await supabase.from("payments").insert({
    id: paymentId, payment_type: "ORDER_PAYMENT", target_type: "order", target_id: order.id,
    user_id: userId, method: "BALANCE", amount_base: amountBase,
    amount_currency: toDisplayAmount(amountBase, Number(order.currency_rate_scaled)),
    currency_code: order.currency_code, status: "CONFIRMED",
    installment_index: installmentIndex,
    reviewed_at: now, created_at: now, updated_at: now,
  });
  if (error) {
    // 补偿：分项写失败 → 冲正余额（文档B §0.1 ④）
    await changeBalance(supabase, {
      userId, amount: amountBase, txnType: "refund_in", refType: "order", refId: order.id,
      idemKey: `${idemKey}:rollback`, remark: "支付分项写入失败冲正",
    });
    throw new AppError(500, "internal_error");
  }
  return { payment_id: paymentId, debit };
}

// —— Y3 扫码分项（PENDING_SUBMIT + 收款码 + 应付额 + 单号入口）——
export async function payQrcode(supabase, principal, body) {
  const { order, rows } = await payableOrder(supabase, principal, body.order_id);
  const method = vStr(body.method, "method", { min: 1, max: 32, pattern: /^[A-Z][A-Z0-9_]{1,31}$/ });
  const channel = await enabledChannel(supabase, method, "manual");
  const assigned = sumBy(rows, ["CONFIRMED", "PENDING_SUBMIT", "PENDING_REVIEW"]);
  const unassigned = amountOfOrder(order) - assigned;
  if (unassigned <= 0) throw new AppError(409, "state_conflict", "订单已无未付差额", null);
  const amountBase = vAmount(body.amount_base, "amount_base", { min: 1, max: unassigned });
  // 一次转账覆盖全部差额：审核后要么整单 PAID，要么整单驳回，不留"已收款未付齐"悬空态
  if (amountBase !== unassigned) {
    throw new AppError(400, "invalid_request", "扫码分项金额需等于未付差额", { expected: unassigned, received: amountBase });
  }
  const paymentId = crypto.randomUUID();
  const now = nowIso();
  // 文档L：加密货币按客户所选币种计价出票。chain_index 是可选参数——微信/支付宝等渠道不传，行为与今天一致。
  const chains = await pricedChains(channel, amountBase);
  const coin = coinSnapshot(chains, vInt(body.chain_index, "chain_index", { min: 0, max: 7, optional: true }));
  const { error } = await supabase.from("payments").insert({
    id: paymentId, payment_type: "ORDER_PAYMENT", target_type: "order", target_id: order.id,
    user_id: principal.id, method, amount_base: amountBase,
    amount_currency: toDisplayAmount(amountBase, Number(order.currency_rate_scaled)),
    currency_code: order.currency_code, status: "PENDING_SUBMIT",
    coin_symbol: coin?.symbol ?? null, coin_network: coin?.network ?? null, coin_units: coin?.units ?? null, coin_decimals: coin?.decimals ?? null,
    created_at: now, updated_at: now,
  });
  if (error) throw new AppError(500, "internal_error");
  return {
    payment_id: paymentId, order_id: order.id, order_no: order.order_no,
    amount_base: amountBase, amount_currency: toDisplayAmount(amountBase, Number(order.currency_rate_scaled)),
    currency_code: order.currency_code, payment_deadline: order.payment_deadline,
    channel: {
      method, image_url: channel.image_url,
      holder_name: channel.holder_name, account_no: channel.account_no,
      pay_link: channel.pay_link, account_note: channel.account_note,
      account_note_i18n: channel.account_note_i18n,
      chains,
    },
    transfer_reference: order.order_no,
  };
}

// —— Y4 上传转账凭证（金额须等于分项额；同一订单同时仅一份在审；死线不重置）——
export async function payProof(supabase, principal, body) {
  const paymentId = vUuid(body.payment_id, "payment_id");
  const { data: payment } = await supabase.from("payments").select(PAYMENT_COLS).eq("id", paymentId).maybeSingle();
  if (!payment || payment.user_id !== principal.id) throw new AppError(404, "not_found", "支付分项不存在");
  if (!["PENDING_SUBMIT", "REJECTED"].includes(payment.status)) {
    throw new AppError(409, "state_conflict", "该分项不可上传凭证", { status: payment.status });
  }
  const order = payment.payment_type === "ORDER_PAYMENT" ? await readOrder(supabase, payment.target_id) : null;
  if (order && isExpired(order)) {
    throw new AppError(410, "deadline_passed", "支付时限已过", { payment_deadline: order.payment_deadline });
  }
  const imageKey = vStr(body.image_key, "image_key", { min: 12, max: 120, pattern: PROOF_KEY_RE });
  const transactionNo = vStr(body.transaction_no, "transaction_no", { min: 4, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
  const amountDeclared = vAmount(body.amount_declared, "amount_declared", { min: 1 });
  if (amountDeclared !== Number(payment.amount_currency)) {
    throw new AppError(409, "amount_mismatch", "申报金额与应付分项不一致",
      { expected: Number(payment.amount_currency), declared: amountDeclared });
  }
  if (order) {
    const rows = await paymentsOfOrder(supabase, order.id);
    if (rows.some((p) => p.id !== payment.id && p.status === "PENDING_REVIEW")) {
      throw new AppError(409, "state_conflict", "该订单已有凭证在审，请等待审核结果", null);
    }
  }
  const proofId = crypto.randomUUID();
  const now = nowIso();
  // 文档L：客户在票据上选了币种才随凭证一起落快照（按分项金额与**当时**的参考汇率重算），
  // 后台审核才看得到「客户所选：USDT / 应付 30.50 USDT」；没选或该币没汇率就只按账户币种审。
  // ⚠ 出票时已落过快照的分项**不再重算**：店主在客户转账期间改了参考汇率，重算出来的数就和客户
  //    看到并转出的那个数不同，审核照新数卡人等于凭空造纠纷。只有快照为空（出票时没选币/没汇率）才补。
  let coin = null;
  const chainIndex = vInt(body.chain_index, "chain_index", { min: 0, max: 7, optional: true });
  if (chainIndex !== null && !payment.coin_symbol) {
    const chain = (await channelRegistry(supabase))[payment.method]?.chains?.[chainIndex];
    const quote = chain ? coinQuoteOf(chain, Number(payment.amount_base)) : null;
    if (quote) coin = { symbol: chain.symbol, network: chain.network || null, units: quote.units, decimals: quote.decimals };
  }
  const { error } = await supabase.from("payment_proofs").insert({
    id: proofId, payment_id: payment.id, image_key: imageKey, transaction_no: transactionNo,
    amount_declared: amountDeclared, uploaded_by: principal.id, review_status: "pending",
    created_at: now,
  });
  if (error) throw new AppError(500, "internal_error");
  const flipped = await setStatus(supabase, payment.id, payment.status, "PENDING_REVIEW",
    { reject_reason: null, ...(coin ? { coin_symbol: coin.symbol, coin_network: coin.network, coin_units: coin.units, coin_decimals: coin.decimals } : {}) });
  if (!flipped) {
    throw new AppError(409, "state_conflict", "支付分项状态已变化，请重试", null);
  }
  if (order && order.status_payment !== "PENDING_REVIEW") {
    const { data } = await supabase.from("orders")
      .update({ status_payment: "PENDING_REVIEW", updated_at: nowIso() })
      .eq("id", order.id).eq("status_order", "PENDING_PAYMENT").eq("status_payment", order.status_payment).select("id");
    if (data?.length) {
      await writeStatusLog(supabase, {
        orderId: order.id, dim: "payment", fromStatus: order.status_payment, toStatus: "PENDING_REVIEW",
        operatorType: "user", operatorId: principal.id, reason: "提交转账凭证",
      });
    }
  }
  return {
    proof_id: proofId, payment_id: payment.id, review_status: "pending",
    order_status_payment: order ? "PENDING_REVIEW" : null,
    payment_deadline: order?.payment_deadline ?? null,
  };
}

// —— Y5 分项与凭证（本人）——
export async function payList(supabase, principal, query) {
  let q = supabase.from("payments").select(PAYMENT_COLS).eq("user_id", principal.id)
    .order("created_at", { ascending: false }).limit(100);
  if (query.order_id) {
    const orderId = vUuid(query.order_id, "order_id");
    const order = await readOrder(supabase, orderId);
    if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
    q = supabase.from("payments").select(PAYMENT_COLS)
      .eq("target_type", "order").eq("target_id", orderId).order("created_at", { ascending: true });
  }
  const { data } = await q;
  const rows = data ?? [];
  const ids = rows.map((p) => p.id);
  const proofs = ids.length
    ? (await supabase.from("payment_proofs").select(PROOF_COLS).in("payment_id", ids)).data ?? []
    : [];
  return {
    items: await Promise.all(rows.map(async (p) => ({
      ...p,
      proofs: await Promise.all(proofs.filter((f) => f.payment_id === p.id).map(async (f) => ({
        id: f.id, review_status: f.review_status, amount_declared: Number(f.amount_declared),
        transaction_no: f.transaction_no, reject_reason: f.reject_reason, created_at: f.created_at,
        image_url: await signedUrlForKey(f.image_key),
      }))),
    }))),
  };
}

// —— 分期支付 IN1/IN2（文档N D2 逐期人工收款：首付 + 各尾期，余额即时到账或扫码上传凭证走人工审核）——

// 买家本单当前可操作的分期订单（含归属与分期身份；期序合法性在调用处判）
async function installmentOrder(supabase, principal, orderIdValue, field = "order_id") {
  const orderId = vUuid(orderIdValue, field);
  const order = await readOrder(supabase, orderId);
  if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
  if (!isInstallmentOrder(order)) {
    throw new AppError(409, "state_conflict", "该订单不是分期订单", { installment_count: order.installment_count ?? null });
  }
  return order;
}

// 某期是否已有未结清的待处理付款（PENDING_SUBMIT / PENDING_REVIEW；REJECTED 允许重付）
const openPaymentForIndex = (rows, index) => rows.find((p) => Number(p.installment_index) === index
  && ["PENDING_SUBMIT", "PENDING_REVIEW"].includes(p.status)) ?? null;

// method 归一：缺省 / "BALANCE" 走站内余额，其余按大写渠道码走扫码
const normalizePayMethod = (raw) => (raw === undefined || raw === null || raw === "BALANCE"
  ? "BALANCE" : vStr(raw, "method", { min: 1, max: 32, pattern: /^[A-Z][A-Z0-9_]{1,31}$/ }));

// —— IN1 支付某一期（index=1 为首付；首付跳进 INSTALLMENT_ACTIVE，尾期跳到该期满则结清）——
export async function installmentPay(supabase, principal, body) {
  const order = await installmentOrder(supabase, principal, body.order_id);
  const index = vInt(body.installment_index, "installment_index", { min: 1, max: 99 });
  const amountBase = periodAmountOf(order, index);
  if (amountBase === null) {
    throw new AppError(400, "invalid_request", "期序超出该单分期计划", { installment_count: Number(order.installment_count) });
  }
  const rows = await paymentsOfOrder(supabase, order.id);
  const paidIdx = new Set(rows.filter((p) => p.status === "CONFIRMED").map((p) => Number(p.installment_index)));
  const isDeposit = index === 1;
  if (isDeposit) {
    if (order.status_order !== "PENDING_PAYMENT") {
      if (paidIdx.has(1)) throw new AppError(409, "state_conflict", "首付已到账", null);
      throw new AppError(409, "state_conflict", "订单当前不可支付首付", { status_order: order.status_order });
    }
    if (isExpired(order)) {
      throw new AppError(410, "deadline_passed", "支付时限已过", { payment_deadline: order.payment_deadline });
    }
  } else {
    if (order.status_payment !== "INSTALLMENT_ACTIVE") {
      throw new AppError(409, "state_conflict", "请先支付首付开通分期后再付尾款", { status_payment: order.status_payment });
    }
    if (paidIdx.has(index)) throw new AppError(409, "state_conflict", "该期已结清", { installment_index: index });
  }
  const inflight = openPaymentForIndex(rows, index);
  if (inflight) {
    throw new AppError(409, "state_conflict", "该期已有待处理的付款，请等待审核或先完成", { status: inflight.status });
  }
  const method = normalizePayMethod(body.method);

  if (method === "BALANCE") {
    await assertPaymentPassword(supabase, principal, body);
    const payment = await createBalancePayment(supabase, {
      order, userId: principal.id, amountBase, installmentIndex: index,
      idemKey: `pay:wallet:inst:${order.id}:${index}#${attemptOf(rows)}`,
      remark: `订单 ${order.order_no} 分期第 ${index} 期`,
    });
    const advanced = isDeposit
      ? await advanceOrderPaid(supabase, { order, operatorType: "user", operatorId: principal.id, reason: "分期首付余额到账" })
      : await settleInstallment(supabase, { order, operatorType: "user", operatorId: principal.id, reason: "分期尾款余额到账" });
    return {
      order_id: order.id, payment_id: payment.payment_id, installment_index: index, amount_base: amountBase,
      balance_after: payment.debit.after,
      started: advanced.installment === true ? true : undefined,
      settled: advanced.settled === true ? true : undefined,
      status_payment: advanced.status_payment ?? order.status_payment,
    };
  }

  const channel = await enabledChannel(supabase, method, "manual");
  const paymentId = crypto.randomUUID();
  const now = nowIso();
  const chains = await pricedChains(channel, amountBase);
  const coin = coinSnapshot(chains, vInt(body.chain_index, "chain_index", { min: 0, max: 7, optional: true }));
  const { error } = await supabase.from("payments").insert({
    id: paymentId, payment_type: "ORDER_PAYMENT", target_type: "order", target_id: order.id,
    user_id: principal.id, method, amount_base: amountBase,
    amount_currency: toDisplayAmount(amountBase, Number(order.currency_rate_scaled)),
    currency_code: order.currency_code, installment_index: index, status: "PENDING_SUBMIT",
    coin_symbol: coin?.symbol ?? null, coin_network: coin?.network ?? null, coin_units: coin?.units ?? null, coin_decimals: coin?.decimals ?? null,
    created_at: now, updated_at: now,
  });
  if (error) throw new AppError(500, "internal_error");
  return {
    payment_id: paymentId, order_id: order.id, order_no: order.order_no, installment_index: index,
    amount_base: amountBase, amount_currency: toDisplayAmount(amountBase, Number(order.currency_rate_scaled)),
    currency_code: order.currency_code,
    channel: {
      method, image_url: channel.image_url, holder_name: channel.holder_name, account_no: channel.account_no,
      pay_link: channel.pay_link, account_note: channel.account_note, account_note_i18n: channel.account_note_i18n, chains,
    },
    transfer_reference: `${order.order_no}-P${index}`,
  };
}

// —— IN2 提前结清：一笔覆盖该单全部未付期（余额即时到账，或扫码走人工），到账后剩余期全 PAID ——
export async function installmentSettleNow(supabase, principal, body) {
  const order = await installmentOrder(supabase, principal, body.order_id);
  if (order.status_payment !== "INSTALLMENT_ACTIVE") {
    throw new AppError(409, "state_conflict", "仅进行中的分期单可提前结清", { status_payment: order.status_payment });
  }
  const rows = await paymentsOfOrder(supabase, order.id);
  const remainingBase = amountOfOrder(order) - sumBy(rows, ["CONFIRMED"]);
  if (remainingBase <= 0) throw new AppError(409, "state_conflict", "该分期单已结清", null);
  const open = rows.find((p) => ["PENDING_SUBMIT", "PENDING_REVIEW"].includes(p.status)
    && (p.installment_index === null || p.installment_index === undefined));
  if (open) throw new AppError(409, "state_conflict", "已有待处理的结清付款", { status: open.status });
  const method = normalizePayMethod(body.method);

  if (method === "BALANCE") {
    await assertPaymentPassword(supabase, principal, body);
    const payment = await createBalancePayment(supabase, {
      order, userId: principal.id, amountBase: remainingBase, installmentIndex: null,
      idemKey: `pay:wallet:settle:${order.id}#${attemptOf(rows)}`,
      remark: `订单 ${order.order_no} 分期提前结清`,
    });
    const advanced = await settleInstallment(supabase, {
      order, operatorType: "user", operatorId: principal.id, reason: "分期提前结清（余额）",
    });
    return {
      order_id: order.id, payment_id: payment.payment_id, amount_base: remainingBase,
      balance_after: payment.debit.after,
      settled: advanced.settled === true ? true : undefined,
      status_payment: advanced.status_payment ?? order.status_payment,
    };
  }

  const channel = await enabledChannel(supabase, method, "manual");
  const paymentId = crypto.randomUUID();
  const now = nowIso();
  const chains = await pricedChains(channel, remainingBase);
  const coin = coinSnapshot(chains, vInt(body.chain_index, "chain_index", { min: 0, max: 7, optional: true }));
  const { error } = await supabase.from("payments").insert({
    id: paymentId, payment_type: "ORDER_PAYMENT", target_type: "order", target_id: order.id,
    user_id: principal.id, method, amount_base: remainingBase,
    amount_currency: toDisplayAmount(remainingBase, Number(order.currency_rate_scaled)),
    currency_code: order.currency_code, installment_index: null, status: "PENDING_SUBMIT",
    coin_symbol: coin?.symbol ?? null, coin_network: coin?.network ?? null, coin_units: coin?.units ?? null, coin_decimals: coin?.decimals ?? null,
    created_at: now, updated_at: now,
  });
  if (error) throw new AppError(500, "internal_error");
  return {
    payment_id: paymentId, order_id: order.id, order_no: order.order_no, amount_base: remainingBase,
    amount_currency: toDisplayAmount(remainingBase, Number(order.currency_rate_scaled)),
    currency_code: order.currency_code,
    channel: {
      method, image_url: channel.image_url, holder_name: channel.holder_name, account_no: channel.account_no,
      pay_link: channel.pay_link, account_note: channel.account_note, account_note_i18n: channel.account_note_i18n, chains,
    },
    transfer_reference: `${order.order_no}-SETTLE`,
  };
}

// —— W2 钱包充值（只走扫码 + 人工确认，BALANCE 不可用于充值）——
export async function walletRecharge(supabase, principal, body) {
  // 币种以账号侧为准，早于渠道校验执行（避免账号币种冲突时还要读渠道配置）
  const { data: user } = await supabase.from("users")
    .select("id,currency_code").eq("id", principal.id).is("deleted_at", null).maybeSingle();
  if (!user) throw new AppError(404, "not_found");
  // 账号币种已被后台下架时回落站点本位币；declared 只允许等于账号币种或实际采用的币种
  const currency = await getCurrencyOrBase(supabase, user.currency_code);
  const declared = body.currency_code;
  if (declared !== undefined && declared !== null && declared !== user.currency_code && declared !== currency.code) {
    throw new AppError(400, "currency_mismatch", "充值币种必须与账号币种一致", { account: user.currency_code, declared });
  }
  const method = vStr(body.method, "method", { min: 1, max: 32, pattern: /^[A-Z][A-Z0-9_]{1,31}$/ });
  const channel = await enabledChannel(supabase, method, "manual");
  const amountBase = vAmount(body.amount_base, "amount_base", { min: 100, max: 999999999 });
  const paymentId = crypto.randomUUID();
  const now = nowIso();
  // 文档L：充值与订单扫码同口径——选了加密货币币种就落快照，后台审核才看得见客户要转什么币
  const chains = await pricedChains(channel, amountBase);
  const coin = coinSnapshot(chains, vInt(body.chain_index, "chain_index", { min: 0, max: 7, optional: true }));
  const { error } = await supabase.from("payments").insert({
    id: paymentId, payment_type: "WALLET_RECHARGE", target_type: "wallet", target_id: principal.id,
    user_id: principal.id, method, amount_base: amountBase,
    amount_currency: toDisplayAmount(amountBase, Number(currency.rate_scaled)),
    currency_code: currency.code, status: "PENDING_SUBMIT",
    coin_symbol: coin?.symbol ?? null, coin_network: coin?.network ?? null, coin_units: coin?.units ?? null, coin_decimals: coin?.decimals ?? null,
    created_at: now, updated_at: now,
  });
  if (error) throw new AppError(500, "internal_error");
  return {
    payment_id: paymentId, amount_base: amountBase,
    amount_currency: toDisplayAmount(amountBase, Number(currency.rate_scaled)),
    currency_code: currency.code,
    // 文档L：币种报价按本分项金额计算，与 Y3/V2 同一口径
    channel: { method, image_url: channel.image_url, holder_name: channel.holder_name, account_no: channel.account_no, pay_link: channel.pay_link, account_note: channel.account_note, account_note_i18n: channel.account_note_i18n, chains },
    transfer_reference: `RC${paymentId.slice(0, 8).toUpperCase()}`,
  };
}
