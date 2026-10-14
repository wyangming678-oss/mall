// 退款售后（文档B §5、文档C R1/R2/RF1/RF2 + D8 二期）：一单多笔部分退款、驳回零资源触碰、
// 完成动作四步各自幂等（T5 可重放）。资金上限不变式：累计退款额硬上限 = 实付额。
import { AppError, isUniqueViolation } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { signedUrlForKey } from "./files.mjs";
import { applyStockChange } from "./inventory.mjs";
import { changeBalance, vAmount } from "./wallet.mjs";
import { channelRegistry, fulfillmentOfMethod } from "./channels.mjs";
import { allowedActions, assertLegalCombo, readOrder, writeStatusLog } from "./order_state.mjs";
import { emit } from "./notify.mjs";
import { nowIso, pageParams, pageResult, vEnum, vInt, vStr, vUuid, countRows } from "./validate.mjs";

export const REFUND_STATUS = ["PENDING", "APPROVED", "PROCESSING", "COMPLETED", "REJECTED"];
// 在途状态：同一订单同时至多一张（去掉 DB UNIQUE(order_id) 后由应用层订单认领把关）
const ACTIVE_STATUS = ["PENDING", "APPROVED", "PROCESSING"];
const REFUND_COLS = "id,order_id,user_id,amount_base,refund_split,refund_method,lines,status,apply_reason,reject_reason,"
  + "reviewer_admin_id,reviewed_at,wallet_txn_id,images,created_at,updated_at";
const ORDER_COLS = "id,order_no,status_order,status_payment,status_shipping,actual_paid_amount_base,"
  + "currency_code,currency_rate_scaled,currency_actual_amount,pre_refund_status";
const ITEM_COLS = "id,sku_id,product_id,title_snapshot,spec_snapshot,price_base_snapshot,quantity,subtotal_base";
const IMAGE_KEY_RE = /^proofs\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
const MAX_IMAGES = 4;
// T5 残留重放的静默窗口：给 RF1 的正常执行留出时间
export const REFUND_RESIDUAL_MS = 60 * 1000;

const moneyNum = (v) => Number(v ?? 0);

// refund_split 定形（方案 §6.6）：balance 走冲正流水，offline_qr 由 RF2 登记线下结果
function splitOf(raw) {
  return {
    balance: moneyNum(raw?.balance),
    offline_qr: moneyNum(raw?.offline_qr),
    offline_done_at: raw?.offline_done_at ?? null,
    offline_note: raw?.offline_note ?? null,
  };
}

const methodOf = (split) => (split.balance > 0 && split.offline_qr > 0 ? "mixed"
  : split.offline_qr > 0 ? "offline" : "to_wallet");

// lines 定形：null=历史整单退款（读侧按整单一次退处理）；数组=本笔所选明细行
function shapeLines(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.map((l) => ({
    item_id: l.item_id ?? null,
    sku_id: l.sku_id ?? null,
    quantity: moneyNum(l.quantity),
    subtotal_base: moneyNum(l.subtotal_base),
  }));
}

// 凭证图片只下发签名 URL，不下发对象键
async function imageUrls(keys) {
  const urls = await Promise.all((keys ?? []).map((k) => signedUrlForKey(k)));
  return urls.filter(Boolean);
}

function shapeRefund(row, order) {
  const rate = moneyNum(order?.currency_rate_scaled);
  const base = moneyNum(row.amount_base);
  return {
    id: row.id,
    order_id: row.order_id,
    user_id: row.user_id,
    status: row.status,
    amount_base: base,
    amount_currency: rate ? Math.round((base * rate) / 1e6) : null,
    currency_code: order?.currency_code ?? null,
    refund_split: splitOf(row.refund_split),
    refund_method: row.refund_method,
    lines: shapeLines(row.lines),
    apply_reason: row.apply_reason,
    reject_reason: row.reject_reason ?? null,
    reviewer_admin_id: row.reviewer_admin_id ?? null,
    reviewed_at: row.reviewed_at ?? null,
    wallet_txn_id: row.wallet_txn_id ?? null,
    image_count: (row.images ?? []).length,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function refundById(supabase, refundId) {
  const { data } = await supabase.from("refunds").select(REFUND_COLS).eq("id", refundId).maybeSingle();
  return data ?? null;
}

async function refundsOfOrder(supabase, orderId) {
  const { data } = await supabase.from("refunds").select(REFUND_COLS).eq("order_id", orderId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

async function orderItems(supabase, orderId) {
  const { data } = await supabase.from("order_items").select(ITEM_COLS).eq("order_id", orderId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

async function orderBrief(supabase, orderId) {
  const { data } = await supabase.from("orders").select(ORDER_COLS).eq("id", orderId).maybeSingle();
  return data ?? null;
}

// 已确认到账分项按渠道归集（方案 §6.6：可退资金=实付，来源二分）
// instant→balance，其余（含已删除渠道的历史分项、尚未实现退款的 online）→offline_qr 走 RF2 人工退款
async function confirmedSplit(supabase, orderId) {
  const { data } = await supabase.from("payments")
    .select("id,method,amount_base").eq("target_type", "order").eq("target_id", orderId).eq("status", "CONFIRMED");
  const reg = await channelRegistry(supabase);
  const split = splitOf(null);
  for (const p of data ?? []) {
    if (fulfillmentOfMethod(reg, p.method) === "instant") split.balance += moneyNum(p.amount_base);
    else split.offline_qr += moneyNum(p.amount_base);
  }
  return split;
}

// 归集该单已完成退款消耗：金额、来源份额、明细行数量（历史整单 lines=null 视为全额占用）
function foldRefunds(refunds, items, confirmed, actualPaid) {
  const consumedQty = new Map();
  const consumedAll = () => {
    for (const it of items) consumedQty.set(it.id, (consumedQty.get(it.id) ?? 0) + moneyNum(it.quantity));
  };
  let completedAmount = 0;
  let completedBalance = 0;
  let completedQr = 0;
  let hasActive = false;
  let active = null;
  for (const r of refunds) {
    if (r.status === "COMPLETED") {
      completedAmount += moneyNum(r.amount_base);
      const s = splitOf(r.refund_split);
      completedBalance += s.balance;
      completedQr += s.offline_qr;
      const lines = shapeLines(r.lines);
      if (!lines) consumedAll();
      else {
        const byId = new Map(items.map((i) => [i.id, i]));
        for (const l of lines) {
          const it = byId.get(l.item_id);
          const cap = it ? moneyNum(it.quantity) : l.quantity;
          consumedQty.set(l.item_id, (consumedQty.get(l.item_id) ?? 0) + Math.min(l.quantity, cap));
        }
      }
    } else if (ACTIVE_STATUS.includes(r.status)) {
      hasActive = true;
      active = r;
    }
  }
  const remaining = moneyNum(actualPaid) - completedAmount;
  return {
    consumedQty, completedAmount, hasActive, active,
    remaining,
    remBalance: Math.max(0, confirmed.balance - completedBalance),
    remQr: Math.max(0, confirmed.offline_qr - completedQr),
  };
}

// 来源分摊：按剩余来源占比拆本笔金额到 balance / offline_qr，并夹在各自可用额度内
function allocSplit(amount, remBalance, remQr) {
  const total = remBalance + remQr;
  if (amount >= total) return { balance: remBalance, offline_qr: remQr };
  let bal = Math.round((amount * remBalance) / total);
  bal = Math.max(0, Math.min(bal, remBalance, amount));
  const qr = amount - bal;
  if (qr > remQr) return { balance: amount - remQr, offline_qr: remQr };
  return { balance: bal, offline_qr: qr };
}

// 解析申请选择：body.lines 缺省=整单退剩余（coversAll，金额=remaining）；给出=按行按数量（金额=Σ 行原价）
function resolveSelection(body, items, consumedQty, remaining) {
  const hasLines = Array.isArray(body.lines) && body.lines.length > 0;
  if (!hasLines) {
    const sel = [];
    for (const it of items) {
      const rq = moneyNum(it.quantity) - (consumedQty.get(it.id) ?? 0);
      if (rq > 0) {
        sel.push({ item_id: it.id, sku_id: it.sku_id, quantity: rq, subtotal_base: moneyNum(it.price_base_snapshot) * rq });
      }
    }
    return { sel, amount: remaining, coversAll: true };
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const take = new Map();
  body.lines.forEach((ln, idx) => {
    const field = `lines[${idx}]`;
    const itemId = vUuid(ln?.item_id, `${field}.item_id`);
    if (!byId.has(itemId)) throw new AppError(400, "invalid_request", "明细行不属于该订单", { field: `${field}.item_id` });
    const qty = vInt(ln?.quantity, `${field}.quantity`, { min: 1, max: 99999 });
    take.set(itemId, (take.get(itemId) ?? 0) + qty);
  });
  const sel = [];
  let amount = 0;
  for (const [itemId, qty] of take) {
    const it = byId.get(itemId);
    const refundable = moneyNum(it.quantity) - (consumedQty.get(itemId) ?? 0);
    if (refundable <= 0 || qty > refundable) {
      throw new AppError(409, "quantity_exceeded", "退款数量超过该明细可退数量", {
        field: "lines", item_id: itemId, requested: qty, refundable: Math.max(0, refundable),
      });
    }
    const subtotal = moneyNum(it.price_base_snapshot) * qty;
    amount += subtotal;
    sel.push({ item_id: itemId, sku_id: it.sku_id, quantity: qty, subtotal_base: subtotal });
  }
  return { sel, amount, coversAll: false };
}

function vImages(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) {
    throw new AppError(400, "invalid_request", "凭证图片最多 4 张");
  }
  return value.map((key) => {
    if (typeof key !== "string" || !IMAGE_KEY_RE.test(key)) {
      throw new AppError(400, "invalid_request", "凭证图片不合法");
    }
    return key;
  });
}

// —— R1 POST /app/refund/apply（仅 PAID ∧ 未发货；一单一退，本笔可按行挑选部分明细）——
export async function refundApply(supabase, principal, body) {
  const orderId = vUuid(body.order_id, "order_id");
  const applyReason = vStr(body.apply_reason, "apply_reason", { min: 2, max: 200 });
  const images = vImages(body.images);
  const order = await readOrder(supabase, orderId);
  if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
  const [refunds, items] = await Promise.all([refundsOfOrder(supabase, order.id), orderItems(supabase, order.id)]);
  const confirmed = await confirmedSplit(supabase, order.id);
  const actualPaid = moneyNum(order.actual_paid_amount_base);
  const fold = foldRefunds(refunds, items, confirmed, actualPaid);
  // 在途优先：订单被认领为 REFUNDING 后再次申请，应给出"退款处理中"而非泛化的状态冲突
  if (fold.hasActive) {
    throw new AppError(409, "refund_exists", "该订单有一笔退款正在处理中，请等待处理结果");
  }
  // 累计封顶：全额退完的订单已到 REFUNDED 终态，剩余可退为 0
  if (fold.remaining <= 0) {
    throw new AppError(409, "fully_refunded", "该订单已全额退款完毕", { refunded_base: fold.completedAmount, max_base: actualPaid });
  }
  // 决策 10（一单一退）：只要本单出现过退款记录（已到账或已驳回），买家侧都不再开放申请。
  // 后台 adminRefundCreate 同口径：现网 refunds.order_id 带 UNIQUE，同一订单的第二笔本就落不进库。
  if (refunds.length > 0) {
    throw new AppError(409, "refund_once", "该订单已申请过退款，一个订单只能退款一次", {
      refund_count: refunds.length, statuses: refunds.map((r) => r.status),
    });
  }
  // 窗口：仅"已付款 ∧ 未发货"可发起这笔申请
  if (!(order.status_order === "PAID" && order.status_payment === "PAID" && order.status_shipping === "NOT_SHIPPED")) {
    throw new AppError(409, "state_conflict", "仅已付款且未发货的订单可在线申请退款", {
      status_order: order.status_order, status_shipping: order.status_shipping,
    });
  }
  const { sel, amount, coversAll } = resolveSelection(body, items, fold.consumedQty, fold.remaining);
  // 客户端可回传期望金额做一致性校验；权威金额始终由服务端按明细行原价快照计算
  if (body.amount_base !== undefined && body.amount_base !== null) {
    const asked = vAmount(body.amount_base, "amount_base");
    if (asked !== amount) {
      throw new AppError(409, "amount_mismatch", "退款金额与所选明细行原价合计不符", { expected_base: amount });
    }
  }
  if (amount > fold.remaining) {
    throw new AppError(409, "amount_exceeds_paid", "退款金额超过该订单可退余额", {
      max_base: fold.remaining, requested_base: amount, refunded_base: fold.completedAmount,
    });
  }
  if (amount <= 0) throw new AppError(400, "invalid_request", "退款金额不合法", { field: "lines" });
  const split = allocSplit(amount, fold.remBalance, fold.remQr);
  const method = methodOf({ ...split });
  const now = nowIso();
  // 先认领订单（0 行=并发已变动/已有在途），再落退款单，失败即回滚认领，不留悬空 REFUNDING
  const { data: claim } = await supabase.from("orders")
    .update({ status_order: "REFUNDING", pre_refund_status: order.status_order, updated_at: now })
    .eq("id", order.id).eq("status_order", "PAID").eq("status_payment", "PAID").eq("status_shipping", "NOT_SHIPPED")
    .select("id");
  if (!claim?.length) throw new AppError(409, "claim_conflict", "订单状态已变化，请刷新后重试");

  const refundId = crypto.randomUUID();
  const { error } = await supabase.from("refunds").insert({
    id: refundId,
    order_id: order.id,
    user_id: principal.id,
    amount_base: amount,
    refund_split: { ...split, offline_done_at: null, offline_note: null },
    refund_method: method,
    lines: sel,
    status: "PENDING",
    apply_reason: applyReason,
    images,
    created_at: now,
    updated_at: now,
  });
  if (error) {
    await supabase.from("orders")
      .update({ status_order: "PAID", pre_refund_status: null, updated_at: nowIso() })
      .eq("id", order.id).eq("status_order", "REFUNDING");
    throw new AppError(500, "internal_error");
  }
  await writeStatusLog(supabase, {
    orderId: order.id, dim: "order", fromStatus: "PAID", toStatus: "REFUNDING",
    operatorType: "user", operatorId: principal.id, reason: `用户申请退款：${applyReason}`,
  });
  await emit(supabase, {
    userId: principal.id, msgType: "refund_applied", title: "退款申请已提交",
    content: `订单 ${order.order_no} 的退款申请已提交，客服审核后会把结果发在这里`,
    refType: "order", refId: order.id,
  });
  assertLegalCombo({ ...order, status_order: "REFUNDING" });
  return {
    refund_id: refundId,
    order_id: order.id,
    status: "PENDING",
    status_order: "REFUNDING",
    amount_base: amount,
    covers_all: coversAll,
    remaining_refundable_base: fold.remaining,
    refund_method: method,
    refund_split: split,
    lines: sel,
  };
}

// —— 后台代客发起退款（#279）：客服会话受理后由后台建 PENDING 单，仍走 admin/refund/review 审批 ——
// 与 refundApply 同一套资金/明细引擎，区别：① operator=admin、user_id 取自订单 ② 放宽状态闸——收货前/收货后皆可，
// 只要「已付款 ∧ 有可退余额 ∧ 无在途」；不再要求未发货（未发货才回库，已发货由执行序按 status_shipping 跳过回库）。
export async function adminRefundCreate(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "refund.review");
  // 支持按订单号或订单ID定位（客服手里通常只有会话中报出的订单号）
  let orderId = body.order_id ?? null;
  if (!orderId && body.order_no) {
    const { data } = await supabase.from("orders").select("id").eq("order_no", vStr(body.order_no, "order_no", { max: 64 })).maybeSingle();
    if (!data) throw new AppError(404, "not_found", "订单不存在");
    orderId = data.id;
  }
  const order = await readOrder(supabase, vUuid(orderId, "order_id"));
  if (!order) throw new AppError(404, "not_found", "订单不存在");
  const applyReason = vStr(body.apply_reason, "apply_reason", { min: 2, max: 200 });
  const images = vImages(body.images);
  const [refunds, items] = await Promise.all([refundsOfOrder(supabase, order.id), orderItems(supabase, order.id)]);
  const confirmed = await confirmedSplit(supabase, order.id);
  const actualPaid = moneyNum(order.actual_paid_amount_base);
  const fold = foldRefunds(refunds, items, confirmed, actualPaid);
  if (fold.hasActive) {
    throw new AppError(409, "refund_exists", "该订单有一笔退款正在处理中，请等待完成后再发起下一笔");
  }
  if (fold.remaining <= 0) {
    throw new AppError(409, "fully_refunded", "该订单已全额退款完毕", { refunded_base: fold.completedAmount, max_base: actualPaid });
  }
  // 决策 10（一单一退）对后台同口径：现网 refunds.order_id 带 UNIQUE，同一订单的第二笔落不进库（原先表现为 500）。
  if (refunds.length > 0) {
    throw new AppError(409, "refund_once", "该订单已有退款记录，一个订单只能退款一次", {
      refund_count: refunds.length, statuses: refunds.map((r) => r.status),
    });
  }
  // 放宽闸：钱必须已到账（status_payment=PAID），且订单不在 取消/退款 终态
  if (order.status_payment !== "PAID" || ["CANCELLED", "REFUNDED", "REFUNDING"].includes(order.status_order)) {
    throw new AppError(409, "state_conflict", "该订单当前状态不可发起退款", {
      status_order: order.status_order, status_payment: order.status_payment,
    });
  }
  const { sel, amount, coversAll } = resolveSelection(body, items, fold.consumedQty, fold.remaining);
  if (amount > fold.remaining) {
    throw new AppError(409, "amount_exceeds_paid", "退款金额超过该订单可退余额", {
      max_base: fold.remaining, requested_base: amount, refunded_base: fold.completedAmount,
    });
  }
  if (amount <= 0) throw new AppError(400, "invalid_request", "退款金额不合法", { field: "lines" });
  const split = allocSplit(amount, fold.remBalance, fold.remQr);
  const method = methodOf({ ...split });
  const now = nowIso();
  const fromStatus = order.status_order;
  const { data: claim } = await supabase.from("orders")
    .update({ status_order: "REFUNDING", pre_refund_status: fromStatus, updated_at: now })
    .eq("id", order.id).eq("status_order", fromStatus).select("id");
  if (!claim?.length) throw new AppError(409, "claim_conflict", "订单状态已变化，请刷新后重试");

  const refundId = crypto.randomUUID();
  const { error } = await supabase.from("refunds").insert({
    id: refundId,
    order_id: order.id,
    user_id: order.user_id,
    amount_base: amount,
    refund_split: { ...split, offline_done_at: null, offline_note: null },
    refund_method: method,
    lines: sel,
    status: "PENDING",
    apply_reason: applyReason,
    images,
    created_at: now,
    updated_at: now,
  });
  if (error) {
    await supabase.from("orders")
      .update({ status_order: fromStatus, pre_refund_status: null, updated_at: nowIso() })
      .eq("id", order.id).eq("status_order", "REFUNDING");
    throw new AppError(500, "internal_error");
  }
  await writeStatusLog(supabase, {
    orderId: order.id, dim: "order", fromStatus, toStatus: "REFUNDING",
    operatorType: "admin", operatorId: actor.id, reason: `客服受理退款：${applyReason}`,
  });
  await emit(supabase, {
    userId: order.user_id, msgType: "refund_applied", title: "退款申请已提交",
    content: `订单 ${order.order_no} 的退款申请已由客服提交，审核通过后会把结果发在这里`,
    refType: "order", refId: order.id,
  });
  await writeAudit(supabase, {
    adminId: actor.id, action: "refund.create", targetType: "refund", targetId: refundId,
    detail: { order_id: order.id, amount_base: amount, reason: applyReason },
  });
  return {
    refund_id: refundId,
    order_id: order.id,
    status: "PENDING",
    status_order: "REFUNDING",
    amount_base: amount,
    covers_all: coversAll,
    remaining_refundable_base: fold.remaining,
    refund_method: method,
    refund_split: split,
    lines: sel,
  };
}

// —— R2 GET /app/refund/status（脱敏进度 + 行级可退额 + 多笔历史）——
export async function refundStatus(supabase, principal, query) {
  const order = await readOrder(supabase, vUuid(query.order_id, "order_id"));
  if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
  const [refunds, items] = await Promise.all([refundsOfOrder(supabase, order.id), orderItems(supabase, order.id)]);
  const confirmed = await confirmedSplit(supabase, order.id);
  const actualPaid = moneyNum(order.actual_paid_amount_base);
  const fold = foldRefunds(refunds, items, confirmed, actualPaid);
  // can_apply 与 refundApply 的门保持同一口径：本单从未有过退款记录才开放申请（决策 10 一单一退）
  const canApply = allowedActions(order).can_refund && !fold.hasActive && refunds.length === 0 && fold.remaining > 0;
  const refundable = items.map((it) => {
    const consumed = fold.consumedQty.get(it.id) ?? 0;
    return {
      item_id: it.id,
      sku_id: it.sku_id,
      product_id: it.product_id,
      title_snapshot: it.title_snapshot,
      spec_snapshot: it.spec_snapshot,
      price_base_snapshot: moneyNum(it.price_base_snapshot),
      quantity: moneyNum(it.quantity),
      refundable_qty: Math.max(0, moneyNum(it.quantity) - consumed),
      refundable_base: Math.max(0, moneyNum(it.price_base_snapshot) * (moneyNum(it.quantity) - consumed)),
    };
  });
  const shaped = refunds.map((r) => shapeRefund(r, order));
  const active = fold.active ? { ...shapeRefund(fold.active, order), image_urls: await imageUrls(fold.active.images) } : null;
  return {
    order_id: order.id,
    order_status: {
      status_order: order.status_order,
      status_payment: order.status_payment,
      status_shipping: order.status_shipping,
    },
    can_apply: canApply,
    actual_paid_base: actualPaid,
    refunded_base: fold.completedAmount,
    remaining_refundable_base: Math.max(0, fold.remaining),
    refundable_items: refundable,
    refunds: shaped,
    refund: active,
  };
}

// —— COMPLETED 执行序（文档B §5：①资金 ②库存 ③券默认不恢复 ④终态与流水）——
// 每步可重放：资金靠 wallet_txns.idem_key UNIQUE，库存靠 inventory_logs 净值对账。
async function executeRefund(supabase, { refund, order, operatorId = null, operatorType = "system" }) {
  const split = splitOf(refund.refund_split);
  const idemKey = `refund:balance:${refund.id}`;
  let walletTxnId = refund.wallet_txn_id ?? null;
  let credit = { touched: split.balance > 0, amount_base: split.balance };

  // ① 余额来源部分 → refund_in 冲正回余额（CAS balance+=n）
  if (split.balance > 0 && !walletTxnId) {
    const res = await changeBalance(supabase, {
      userId: refund.user_id, amount: split.balance, txnType: "refund_in",
      refType: "refund", refId: refund.id, idemKey, remark: `订单 ${order.order_no} 退款`,
    });
    if (res.ok) walletTxnId = res.txn_id;
    else if (res.reason === "duplicated") {
      const { data: txn } = await supabase.from("wallet_txns").select("id").eq("idem_key", idemKey).maybeSingle();
      if (txn) walletTxnId = txn.id;
      else return { completed: false, stage: "credit", reason: "ledger_missing" };
    } else return { completed: false, stage: "credit", reason: res.reason };
  }

  // 扫码部分须先由 RF2 登记线下退款结果，才允许动库存与订单终态（方案 §7.4）
  if (split.offline_qr > 0 && !split.offline_done_at) {
    if (refund.status === "PROCESSING" && refund.wallet_txn_id !== walletTxnId) {
      await supabase.from("refunds").update({ wallet_txn_id: walletTxnId, updated_at: nowIso() })
        .eq("id", refund.id).eq("status", "PROCESSING");
    }
    return {
      completed: false, pending_offline: true, stage: "offline",
      amount_base_offline: split.offline_qr, wallet_txn_id: walletTxnId, credit,
      stock: { skipped: true, pending: true, restored: [], failures: [] },
    };
  }

  // ② 库存：仅按本笔退款行数量回库 available+=n（未发货窗口内才有退款）；历史整单 lines=null 回全量
  const stock = { skipped: order.status_shipping !== "NOT_SHIPPED", restored: [], failures: [] };
  if (!stock.skipped) {
    const need = new Map();
    const lines = shapeLines(refund.lines);
    if (lines) {
      for (const l of lines) need.set(l.sku_id, (need.get(l.sku_id) ?? 0) + l.quantity);
    } else {
      const { data: all } = await supabase.from("order_items").select("sku_id,quantity").eq("order_id", order.id);
      for (const it of all ?? []) need.set(it.sku_id, (need.get(it.sku_id) ?? 0) + moneyNum(it.quantity));
    }
    const { data: done } = await supabase.from("inventory_logs").select("sku_id,quantity")
      .eq("reference_type", "refund").eq("reference_id", refund.id).eq("change_type", "restore");
    const already = new Map();
    for (const log of done ?? []) already.set(log.sku_id, (already.get(log.sku_id) ?? 0) + moneyNum(log.quantity));
    for (const [skuId, q] of need) {
      const delta = q - (already.get(skuId) ?? 0);
      if (delta <= 0) continue;
      const res = await applyStockChange(supabase, {
        skuId, changeType: "restore", quantity: delta,
        referenceType: "refund", referenceId: refund.id, operator: operatorId ?? "system",
        reason: `订单 ${order.order_no} 退款回库`,
      });
      if (res.ok) stock.restored.push({ sku_id: skuId, quantity: delta });
      else stock.failures.push({ sku_id: skuId, reason: res.reason });
    }
    if (stock.failures.length) return { completed: false, stage: "stock", reason: "stock_failed", credit, stock };
  }

  // ③ 券默认不恢复（方案 §7.6，一期不做摊算）

  // ④ 累计判定：本次完结后 ΣCOMPLETED 与实付比较 → 整单退完到 REFUNDED 终态，否则回 PAID 以便续退
  const now = nowIso();
  let completedBefore = 0;
  {
    const { data: allR } = await supabase.from("refunds").select("id,status,amount_base").eq("order_id", order.id);
    for (const r of allR ?? []) {
      if (r.status === "COMPLETED" && r.id !== refund.id) completedBefore += moneyNum(r.amount_base);
    }
  }
  const newTotal = completedBefore + moneyNum(refund.amount_base);
  const fully = newTotal >= moneyNum(order.actual_paid_amount_base);
  const desired = fully ? "REFUNDED" : "PAID";

  if (order.status_order === "REFUNDING") {
    const patch = fully
      ? { status_order: "REFUNDED", status_payment: "REFUNDED", pre_refund_status: null, updated_at: now }
      : { status_order: "PAID", pre_refund_status: null, updated_at: now };
    const { data: cas } = await supabase.from("orders").update(patch)
      .eq("id", order.id).eq("status_order", "REFUNDING").eq("status_payment", "PAID").select("id");
    if (!cas?.length) return { completed: false, stage: "order", reason: "conflict", credit, stock };
    const reason = `退款完成 ${refund.id}${fully ? "（整单退完）" : "（部分退款）"}`;
    await writeStatusLog(supabase, {
      orderId: order.id, dim: "order", fromStatus: "REFUNDING", toStatus: desired,
      operatorType, operatorId, reason,
    });
    if (fully) {
      await writeStatusLog(supabase, {
        orderId: order.id, dim: "payment", fromStatus: "PAID", toStatus: "REFUNDED",
        operatorType, operatorId, reason,
      });
      assertLegalCombo({ ...order, status_order: "REFUNDED", status_payment: "REFUNDED" });
    } else {
      assertLegalCombo({ ...order, status_order: "PAID", status_payment: "PAID" });
    }
  } else if (order.status_order !== desired) {
    return { completed: false, stage: "order", reason: "state", status_order: order.status_order, credit, stock };
  }

  const { data: done } = await supabase.from("refunds")
    .update({ status: "COMPLETED", wallet_txn_id: walletTxnId, updated_at: now })
    .eq("id", refund.id).eq("status", "PROCESSING").select("id");
  if (!done?.length) return { completed: false, stage: "refund", reason: "conflict", credit, stock };
  await emit(supabase, {
    userId: refund.user_id, msgType: "refund_completed",
    title: fully ? "退款已到账" : "部分退款已到账",
    content: fully
      ? `订单 ${order.order_no} 退款完成，款项已按原路退回（余额支付部分退回钱包余额）`
      : `订单 ${order.order_no} 的部分退款已到账（${formatBaseHint(refund.amount_base)}）。一个订单只能退款一次，本单不再开放退款申请`,
    refType: "order", refId: order.id,
  });
  return {
    completed: true, fully, amount_base: moneyNum(refund.amount_base),
    remaining_refundable_base: Math.max(0, moneyNum(order.actual_paid_amount_base) - newTotal),
    wallet_txn_id: walletTxnId, credit, stock,
    status_order: desired, status_payment: fully ? "REFUNDED" : "PAID",
  };
}

// 仅用于通知文案的金额提示（基准整数→展示串，避免额外依赖）
function formatBaseHint(base) {
  return `${moneyNum(base)} 基准`;
}

// 已过审的退款单继续推进（RF2 登记线下结果后 / T5 残留重放共用）
export async function continueRefund(supabase, refund, { operatorId = null, operatorType = "system" } = {}) {
  const order = await readOrder(supabase, refund.order_id);
  if (!order) return { completed: false, stage: "order", reason: "not_found" };
  let current = refund;
  if (current.status === "APPROVED") {
    const { data: cas } = await supabase.from("refunds")
      .update({ status: "PROCESSING", updated_at: nowIso() })
      .eq("id", refund.id).eq("status", "APPROVED").select(REFUND_COLS);
    if (!cas?.length) return { completed: false, stage: "refund", reason: "conflict" };
    current = cas[0];
  }
  if (current.status !== "PROCESSING") {
    return { completed: false, stage: "refund", reason: "state", status: current.status };
  }
  return await executeRefund(supabase, { refund: current, order, operatorId, operatorType });
}

// —— RF1 POST /app/admin/refund/review ⚠（approve 走执行序；reject 零资源触碰 + 恢复 pre_refund_status）——
export async function adminRefundReview(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "refund.review");
  const refund = await refundById(supabase, vUuid(body.refund_id, "refund_id"));
  if (!refund) throw new AppError(404, "not_found", "退款单不存在");
  const decision = vEnum(body.decision, "decision", ["approve", "reject"]);

  if (decision === "reject") {
    if (!ACTIVE_STATUS.includes(refund.status)) {
      throw new AppError(409, "state_conflict", "该退款单已不可驳回", { status: refund.status });
    }
    const reason = vStr(body.reject_reason, "reject_reason", { min: 2, max: 200 });
    const now = nowIso();
    const { data: cas } = await supabase.from("refunds")
      .update({ status: "REJECTED", reject_reason: reason, reviewer_admin_id: actor.id, reviewed_at: now, updated_at: now })
      .eq("id", refund.id).eq("status", refund.status).select("id");
    if (!cas?.length) throw new AppError(409, "claim_conflict", "退款单状态已变化，请刷新后重试");
    // 零资源触碰：不退余额、不动库存、不恢复券；行数量占用只计 COMPLETED，驳回即自动释放
    const order = await orderBrief(supabase, refund.order_id);
    const back = order?.pre_refund_status ?? "PAID";
    const { data: restored } = await supabase.from("orders")
      .update({ status_order: back, pre_refund_status: null, updated_at: nowIso() })
      .eq("id", refund.order_id).eq("status_order", "REFUNDING").select("id");
    if (restored?.length) {
      await writeStatusLog(supabase, {
        orderId: refund.order_id, dim: "order", fromStatus: "REFUNDING", toStatus: back,
        operatorType: "admin", operatorId: actor.id, reason: `退款驳回：${reason}`,
      });
      assertLegalCombo({ ...order, status_order: back, pre_refund_status: null });
    }
    await emit(supabase, {
      userId: refund.user_id, msgType: "refund_rejected", title: "退款申请未通过",
      content: `订单 ${order?.order_no ?? refund.order_id} 的退款申请被驳回：${reason}。订单与余额均未变动`,
      refType: "order", refId: refund.order_id,
    });
    await writeAudit(supabase, {
      adminId: actor.id, action: "refund.reject", targetType: "refund", targetId: refund.id,
      detail: { order_id: refund.order_id, amount_base: moneyNum(refund.amount_base), reason },
    });
    return {
      refund_id: refund.id, status: "REJECTED", order_id: refund.order_id,
      order_status_restored: Boolean(restored?.length), status_order: restored?.length ? back : null,
      resources_touched: "none",
    };
  }

  const note = vStr(body.reason, "reason", { min: 2, max: 200 });
  // 已终结的退款单不可再过审：COMPLETED 由幂等键重放；REJECTED 即本单唯一一次退款机会已用完（一单一退）
  if (["COMPLETED", "REJECTED"].includes(refund.status)) {
    throw new AppError(409, "state_conflict", "该退款单已终结，不可再次审核", { status: refund.status });
  }
  let current = refund;
  if (current.status === "PENDING") {
    const now = nowIso();
    const { data: cas } = await supabase.from("refunds")
      .update({ status: "APPROVED", reviewer_admin_id: actor.id, reviewed_at: now, updated_at: now })
      .eq("id", refund.id).eq("status", "PENDING").select(REFUND_COLS);
    if (!cas?.length) throw new AppError(409, "claim_conflict", "退款单状态已变化，请刷新后重试");
    current = cas[0];
    await writeAudit(supabase, {
      adminId: actor.id, action: "refund.approve", targetType: "refund", targetId: refund.id,
      detail: { order_id: refund.order_id, amount_base: moneyNum(refund.amount_base), reason: note },
    });
  }
  const advanced = await continueRefund(supabase, current, { operatorId: actor.id, operatorType: "admin" });
  const after = await refundById(supabase, refund.id);
  return {
    refund_id: refund.id,
    order_id: refund.order_id,
    status: after?.status ?? current.status,
    ...advanced,
  };
}

// —— RF2 POST /app/admin/refund/offline-done ⚠（扫码部分线下退款结果登记）——
export async function adminRefundOfflineDone(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "refund.review");
  const refund = await refundById(supabase, vUuid(body.refund_id, "refund_id"));
  if (!refund) throw new AppError(404, "not_found", "退款单不存在");
  if (!["PROCESSING", "COMPLETED"].includes(refund.status)) {
    throw new AppError(409, "state_conflict", "退款单尚未进入执行阶段", { status: refund.status });
  }
  const split = splitOf(refund.refund_split);
  if (split.offline_qr <= 0) {
    throw new AppError(409, "state_conflict", "该退款不含扫码来源，无需线下登记");
  }
  if (split.offline_done_at) {
    return {
      refund_id: refund.id, already_marked: true, offline_done_at: split.offline_done_at,
      amount_base_offline: split.offline_qr, status: refund.status,
    };
  }
  const note = vStr(body.note, "note", { min: 2, max: 200 });
  const now = nowIso();
  const marked = { ...split, offline_done_at: now, offline_note: note, offline_by: actor.id };
  const { data: cas } = await supabase.from("refunds")
    .update({ refund_split: marked, updated_at: now })
    .eq("id", refund.id).eq("status", refund.status).select("id");
  if (!cas?.length) throw new AppError(409, "claim_conflict", "退款单状态已变化，请刷新后重试");
  await writeAudit(supabase, {
    adminId: actor.id, action: "refund.offline_done", targetType: "refund", targetId: refund.id,
    detail: { order_id: refund.order_id, amount_base_offline: split.offline_qr, note },
  });
  // 扫码部分登记完成 → 若资金/库存已就位则即刻完结
  const fresh = await refundById(supabase, refund.id);
  const advanced = refund.status === "PROCESSING"
    ? await continueRefund(supabase, fresh, { operatorId: actor.id, operatorType: "admin" })
    : { completed: false, stage: "refund", reason: "state", status: refund.status };
  const after = await refundById(supabase, refund.id);
  return {
    refund_id: refund.id,
    order_id: refund.order_id,
    status: after?.status ?? refund.status,
    offline_done_at: now,
    amount_base_offline: split.offline_qr,
    ...advanced,
  };
}

// —— 后台退款队列（状态统计 + 分页 + 可选订单过滤）——
export async function adminRefundList(supabase, request, query) {
  await adminGuard(supabase, request, "refund.review");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("refunds").select(REFUND_COLS)
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  if (query.status) {
    if (!REFUND_STATUS.includes(query.status)) {
      throw new AppError(400, "invalid_request", "状态取值不合法", { field: "status", allowed: REFUND_STATUS });
    }
    q = q.eq("status", query.status);
  }
  if (query.order_id) q = q.eq("order_id", vUuid(query.order_id, "order_id"));
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const orders = new Map();
  if (rows.length) {
    const { data: orderRows } = await supabase.from("orders")
      .select(ORDER_COLS).in("id", rows.map((r) => r.order_id));
    for (const o of orderRows ?? []) orders.set(o.id, o);
  }
  const buyerMap = new Map();
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  if (userIds.length) {
    const { data: buyers } = await supabase.from("users").select("id,username,nickname").in("id", userIds);
    for (const u of buyers ?? []) buyerMap.set(u.id, u);
  }
  const counts = {};
  await Promise.all(REFUND_STATUS.map(async (status) => {
    counts[status] = await countRows(supabase.from("refunds").select("id", { count: "exact" }).eq("status", status));
  }));
  return {
    ...pageResult(rows.map((r) => ({
      ...shapeRefund(r, orders.get(r.order_id)),
      order: orders.get(r.order_id)
        ? (({ id, order_no, status_order, status_payment, status_shipping }) => ({
            id, order_no, status_order, status_payment, status_shipping,
          }))(orders.get(r.order_id))
        : null,
      buyer: buyerMap.get(r.user_id) ?? null,
    })), offset, limit),
    counts_by_status: counts,
  };
}

// —— 后台退款详情（含凭证签名 URL、订单明细、本单累计与同订单多笔历史）——
export async function adminRefundDetail(supabase, request, query) {
  await adminGuard(supabase, request, "refund.review");
  const refund = await refundById(supabase, vUuid(query.refund_id ?? query.id, "refund_id"));
  if (!refund) throw new AppError(404, "not_found", "退款单不存在");
  const order = await readOrder(supabase, refund.order_id);
  const [items, allRefunds] = await Promise.all([
    orderItems(supabase, refund.order_id),
    refundsOfOrder(supabase, refund.order_id),
  ]);
  const { data: logs } = order
    ? await supabase.from("order_status_logs").select("id,dim,from_status,to_status,operator_type,reason,created_at")
        .eq("order_id", order.id).order("created_at", { ascending: true })
    : Promise.resolve({ data: [] });
  const { data: buyer } = await supabase.from("users")
    .select("id,username,nickname,balance").eq("id", refund.user_id).maybeSingle();
  const confirmed = await confirmedSplit(supabase, refund.order_id);
  const actualPaid = moneyNum(order?.actual_paid_amount_base);
  const fold = foldRefunds(allRefunds, items, confirmed, actualPaid);
  const consumedOf = (itemId) => fold.consumedQty.get(itemId) ?? 0;
  return {
    refund: { ...shapeRefund(refund, order), image_urls: await imageUrls(refund.images) },
    order: order ? (({ id, order_no, status_order, status_payment, status_shipping, actual_paid_amount_base,
      currency_code, currency_rate_scaled, currency_actual_amount, pre_refund_status }) => ({
      id, order_no, status_order, status_payment, status_shipping, actual_paid_amount_base,
      currency_code, currency_rate_scaled, currency_actual_amount, pre_refund_status,
    }))(order) : null,
    items: items.map((it) => ({
      id: it.id, product_id: it.product_id, sku_id: it.sku_id, title_snapshot: it.title_snapshot,
      spec_snapshot: it.spec_snapshot, quantity: moneyNum(it.quantity), subtotal_base: moneyNum(it.subtotal_base),
      price_base_snapshot: moneyNum(it.price_base_snapshot), consumed_qty: consumedOf(it.id),
      refundable_qty: Math.max(0, moneyNum(it.quantity) - consumedOf(it.id)),
    })),
    buyer: buyer ?? null,
    status_logs: logs ?? [],
    refunded_base: fold.completedAmount,
    remaining_refundable_base: Math.max(0, fold.remaining),
    order_refunds: allRefunds.map((r) => shapeRefund(r, order)),
  };
}
