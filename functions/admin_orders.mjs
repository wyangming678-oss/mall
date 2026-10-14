// 后台订单与凭证（文档C §六.3 OD1–OD6；权限点逐端点复验，⚠=confirm+audit_logs）
import { AppError } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { paymentsWithProofs } from "./payments.mjs";
import { installmentViewOfOrder } from "./installments.mjs";
import { cancelOrder } from "./orders.mjs";
import { readOrder, readOrderItems, settleComplete, writeStatusLog, allowedActions } from "./order_state.mjs";
import { emit } from "./notify.mjs";
import { nowIso, pageParams, pageResult, vStr, vUuid } from "./validate.mjs";

const LIST_COLS = "id,order_no,user_id,status_order,status_payment,status_shipping,actual_paid_amount_base,"
  + "currency_code,currency_actual_amount,payment_deadline,buyer_remark,shipped_at,installment_count,created_at,updated_at";

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const IDEM_ORDER_ACTIONS = [
  "order/create", "order/cancel", "order/confirm-receipt",
  "pay/wallet", "pay/wallet-part", "pay/qrcode", "pay/proof",
];

function assertIso(value, field) {
  const s = vStr(value, field, { min: 10, max: 32, pattern: DATE_RE });
  if (Number.isNaN(Date.parse(s))) throw new AppError(400, "invalid_request", "时间格式不合法", { field });
  return s;
}

// —— OD1 订单列表（三维状态 + 时间筛选）——
export async function adminOrderList(supabase, request, query) {
  await adminGuard(supabase, request, "order.read");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("orders").select(LIST_COLS).order("created_at", { ascending: false })
    .range(offset, offset + limit);
  for (const [param, col, allowed] of [
    ["status_order", "status_order", ["PENDING_PAYMENT", "PAID", "SHIPPED", "COMPLETED", "CANCELLED", "REFUNDING", "REFUNDED"]],
    ["status_payment", "status_payment", ["UNPAID", "PENDING_REVIEW", "PAID", "REJECTED", "REFUNDED"]],
    ["status_shipping", "status_shipping", ["NOT_SHIPPED", "SHIPPED", "DELIVERED"]],
  ]) {
    if (query[param]) {
      if (!allowed.includes(query[param])) throw new AppError(400, "invalid_request", "状态取值不合法", { field: param, allowed });
      q = q.eq(col, query[param]);
    }
  }
  if (query.keyword) {
    const kw = vStr(query.keyword, "keyword", { min: 2, max: 40, pattern: /^[A-Za-z0-9]+$/ });
    q = q.or(`order_no.ilike.%${kw}%`);
  }
  if (query.date_from) q = q.gte("created_at", assertIso(query.date_from, "date_from"));
  if (query.date_to) q = q.lte("created_at", assertIso(query.date_to, "date_to"));
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const buyerMap = new Map();
  if (userIds.length) {
    const { data: buyers } = await supabase.from("users")
      .select("id,username,nickname").in("id", userIds);
    for (const u of buyers ?? []) buyerMap.set(u.id, u);
  }
  const itemsMap = await readOrderItems(supabase, rows.map((r) => r.id));
  return {
    ...pageResult(rows.map((r) => ({
      ...r,
      buyer: buyerMap.get(r.user_id) ?? null,
      item_count: (itemsMap.get(r.id) ?? []).length,
    })), offset, limit),
  };
}

// —— OD2 订单详情（状态轨迹 + 分项 + 凭证历史 + 幂等摘要）——
export async function adminOrderDetail(supabase, request, query) {
  await adminGuard(supabase, request, "order.read");
  const order = await readOrder(supabase, vUuid(query.order_id ?? query.id, "order_id"));
  if (!order) throw new AppError(404, "not_found", "订单不存在");
  const itemsMap = await readOrderItems(supabase, [order.id]);
  const { data: logs } = await supabase.from("order_status_logs")
    .select("id,dim,from_status,to_status,operator_type,operator_id,reason,created_at")
    .eq("order_id", order.id).order("created_at", { ascending: true });
  const { data: buyer } = await supabase.from("users")
    .select("id,username,nickname,balance,currency_code,status").eq("id", order.user_id).maybeSingle();
  const { data: idem } = await supabase.from("idempotency_keys")
    .select("action,state,created_at,updated_at").eq("principal_type", "user")
    .eq("principal_id", order.user_id).gte("created_at", order.created_at)
    .in("action", IDEM_ORDER_ACTIONS).order("created_at", { ascending: false }).limit(20);
  return {
    order,
    buyer: buyer ?? null,
    items: itemsMap.get(order.id) ?? [],
    status_logs: logs ?? [],
    payments: await paymentsWithProofs(supabase, order.id),
    installment: await installmentViewOfOrder(supabase, order),
    idempotency_summary: idem ?? [],
    allowed_actions: allowedActions(order),
  };
}

// —— OD3 发货 ⚠（已付∧未发货 → SHIPPED；分期首付即生效，INSTALLMENT_ACTIVE 也可发货，快递信息入 extra）——
export async function adminOrderShip(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "order.ship");
  const order = await readOrder(supabase, vUuid(body.order_id, "order_id"));
  if (!order) throw new AppError(404, "not_found", "订单不存在");
  const paidLike = order.status_payment === "PAID" || order.status_payment === "INSTALLMENT_ACTIVE";
  if (!(order.status_order === "PAID" && paidLike && order.status_shipping === "NOT_SHIPPED")) {
    throw new AppError(409, "state_conflict", "订单当前不可发货", {
      status_order: order.status_order, status_shipping: order.status_shipping,
    });
  }
  const carrier = vStr(body.carrier, "carrier", { min: 1, max: 40 });
  const trackingNo = vStr(body.tracking_no, "tracking_no", { min: 3, max: 60, pattern: /^[A-Za-z0-9-]+$/ });
  const note = vStr(body.note, "note", { max: 200, optional: true });
  const now = nowIso();
  const extra = { ...(order.extra ?? {}), carrier, tracking_no: trackingNo, ship_note: note, shipped_by: actor.id };
  const { data: cas } = await supabase.from("orders")
    .update({ status_order: "SHIPPED", status_shipping: "SHIPPED", extra, shipped_at: now, updated_at: now })
    .eq("id", order.id).eq("status_order", "PAID").in("status_payment", ["PAID", "INSTALLMENT_ACTIVE"]).eq("status_shipping", "NOT_SHIPPED")
    .select("id");
  if (!cas?.length) throw new AppError(409, "claim_conflict", "订单状态已变化，请刷新后重试");
  await writeStatusLog(supabase, {
    orderId: order.id, dim: "order", fromStatus: "PAID", toStatus: "SHIPPED",
    operatorType: "admin", operatorId: actor.id, reason: `发货 ${carrier} ${trackingNo}`,
  });
  await writeStatusLog(supabase, {
    orderId: order.id, dim: "shipping", fromStatus: "NOT_SHIPPED", toStatus: "SHIPPED",
    operatorType: "admin", operatorId: actor.id, reason: `发货 ${carrier} ${trackingNo}`,
  });
  await emit(supabase, {
    userId: order.user_id, msgType: "order_shipped", title: "订单已发货",
    content: `订单 ${order.order_no} 已发出：${carrier} ${trackingNo}${note ? `（${note}）` : ""}`,
    refType: "order", refId: order.id,
  });
  await writeAudit(supabase, {
    adminId: actor.id, action: "order.ship", targetType: "order", targetId: order.id,
    detail: { order_no: order.order_no, carrier, tracking_no: trackingNo },
  });
  return { order_id: order.id, status_order: "SHIPPED", status_shipping: "SHIPPED", shipped_at: now, carrier, tracking_no: trackingNo };
}

// —— OD4 未付款强制关单 ⚠（补偿链同用户取消）——
export async function adminOrderClose(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "order.operate");
  const order = await readOrder(supabase, vUuid(body.order_id, "order_id"));
  if (!order) throw new AppError(404, "not_found", "订单不存在");
  if (order.status_order !== "PENDING_PAYMENT") {
    throw new AppError(409, "state_conflict", "仅未付款订单可关单", { status_order: order.status_order });
  }
  const reason = vStr(body.reason, "reason", { min: 2, max: 200 });
  const res = await cancelOrder(supabase, { order, reason: `后台关单：${reason}`, operatorType: "admin", operatorId: actor.id });
  if (!res.cancelled) throw new AppError(409, "claim_conflict", "订单状态已变化，请刷新后重试");
  await writeAudit(supabase, {
    adminId: actor.id, action: "order.close", targetType: "order", targetId: order.id,
    detail: { order_no: order.order_no, reason, unreleased: res.unreleased, expired_payments: res.expired_payment_ids },
  });
  return {
    order_id: order.id, status_order: "CANCELLED", cancel_reason: reason,
    stock_released: res.unreleased.length === 0, unreleased: res.unreleased,
  };
}

// —— OD5 代确认收货 ⚠——
export async function adminOrderComplete(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "order.operate");
  const order = await readOrder(supabase, vUuid(body.order_id, "order_id"));
  if (!order) throw new AppError(404, "not_found", "订单不存在");
  if (order.status_order !== "SHIPPED") {
    throw new AppError(409, "state_conflict", "仅待收货订单可代确认", { status_order: order.status_order });
  }
  const reason = vStr(body.reason, "reason", { max: 200, optional: true }) ?? "后台代确认收货";
  const res = await settleComplete(supabase, { order, operatorType: "admin", operatorId: actor.id, reason });
  if (!res.completed) throw new AppError(409, "claim_conflict", "订单状态已变化，请刷新后重试");
  await writeAudit(supabase, {
    adminId: actor.id, action: "order.complete", targetType: "order", targetId: order.id,
    detail: { order_no: order.order_no, reason },
  });
  return { order_id: order.id, status_order: "COMPLETED", status_shipping: "DELIVERED" };
}

// —— OD6 改地址快照（待付款 / 审核中 / 已付未发货）——
export async function adminOrderAddress(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "order.ship");
  const order = await readOrder(supabase, vUuid(body.order_id, "order_id"));
  if (!order) throw new AppError(404, "not_found", "订单不存在");
  const editable = order.status_order === "PENDING_PAYMENT"
    || (order.status_order === "PAID" && order.status_shipping === "NOT_SHIPPED");
  if (!editable) throw new AppError(409, "state_conflict", "该状态的订单不可修改收货信息", { status_order: order.status_order });
  const snapshot = {
    receiver_name: vStr(body.receiver_name, "receiver_name", { min: 1, max: 30 }),
    phone: vStr(body.phone, "phone", { min: 5, max: 20, pattern: /^[0-9+-]+$/ }),
    country: vStr(body.country, "country", { min: 1, max: 40 }),
    province: vStr(body.province, "province", { min: 1, max: 40 }),
    city: vStr(body.city, "city", { min: 1, max: 40 }),
    district: vStr(body.district, "district", { max: 40, optional: true }),
    detail: vStr(body.detail, "detail", { min: 2, max: 200 }),
    postal_code: vStr(body.postal_code, "postal_code", { max: 12, optional: true }),
  };
  const now = nowIso();
  const { data: cas } = await supabase.from("orders")
    .update({ address_snapshot: snapshot, updated_at: now })
    .eq("id", order.id)
    .eq("status_order", order.status_order).eq("status_payment", order.status_payment)
    .eq("status_shipping", order.status_shipping).select("id");
  if (!cas?.length) throw new AppError(409, "claim_conflict", "订单已变动，请刷新后重试");
  await writeAudit(supabase, {
    adminId: actor.id, action: "order.address", targetType: "order", targetId: order.id,
    detail: { order_no: order.order_no, receiver_name: snapshot.receiver_name, city: snapshot.city },
  });
  return { order_id: order.id, address_snapshot: snapshot };
}
