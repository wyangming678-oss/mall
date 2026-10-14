// 发票申请 A9（文档A 新增 invoices；文档C 新增 IN1/IN2/IN3 + 后台开具/作废）
// 口径：订单维度申请（个人/企业抬头、税号、接收邮箱），金额取下单实付快照；
//       一张订单至多一张「有效」（非作废）申请——作废不占名额，可重新申请（唯一性由函数层查询把关，DDL 无部分索引能力）。
//       后台开具 pending→issued、作废 →void（均 update，无 delete）。
import { AppError, ok } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { readOrder } from "./order_state.mjs";
import { emit } from "./notify.mjs";
import { nowIso, pageParams, pageResult, vEnum, vStr, vUuid, countRows } from "./validate.mjs";

const INVOICE_COLS = "id,order_id,user_id,invoice_type,title,tax_no,email,remark,amount_base,currency_code,"
  + "status,issued_at,void_reason,operator_admin_id,created_at,updated_at";
const INVOICE_TYPES = ["personal", "enterprise"];
const INVOICE_STATUS = ["pending", "issued", "void"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 已付款判定：status_payment=PAID 即可开票（覆盖 PAID/SHIPPED/COMPLETED 的稳态），PENDING_*/REJECTED/REFUNDED 不可
const PAID_PAYMENT = "PAID";

function invoiceView(r, orderNo) {
  return {
    invoice_id: r.id,
    order_id: r.order_id,
    order_no: orderNo ?? null,
    invoice_type: r.invoice_type,
    title: r.title,
    tax_no: r.tax_no ?? null,
    email: r.email,
    remark: r.remark ?? null,
    amount_base: Number(r.amount_base),
    currency_code: r.currency_code,
    status: r.status,
    issued_at: r.issued_at ?? null,
    void_reason: r.void_reason ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// 该订单当前有效（非作废）发票：取最新一张；用于「一单一票」把关与状态回读
async function activeInvoice(supabase, orderId) {
  const { data } = await supabase.from("invoices").select(INVOICE_COLS)
    .eq("order_id", orderId).neq("status", "void").order("created_at", { ascending: false }).limit(1);
  return (data ?? [])[0] ?? null;
}

async function orderNoMap(supabase, orderIds) {
  const map = new Map();
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return map;
  const { data } = await supabase.from("orders").select("id,order_no").in("id", ids);
  for (const o of data ?? []) map.set(o.id, o.order_no);
  return map;
}

// —— IN1 我的发票（登录，分页，按申请时间倒序）——
export async function invoiceList(supabase, principal, query) {
  const { offset, limit } = pageParams(query);
  const { data, error } = await supabase.from("invoices").select(INVOICE_COLS)
    .eq("user_id", principal.id).order("created_at", { ascending: false }).range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const noMap = await orderNoMap(supabase, rows.map((r) => r.order_id));
  return ok(pageResult(rows.map((r) => invoiceView(r, noMap.get(r.order_id))), offset, limit));
}

// —— IN2 订单发票状态回读（登录；OrderDetail 决定「申请/查看发票」入口）——
export async function invoiceStatus(supabase, principal, query) {
  const orderId = vUuid(query.order_id, "order_id");
  const order = await readOrder(supabase, orderId);
  if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
  const active = await activeInvoice(supabase, orderId);
  const paid = order.status_payment === PAID_PAYMENT;
  const canApply = paid && !active && Number(order.actual_paid_amount_base) > 0;
  return ok({
    order_id: orderId,
    paid,
    can_apply: canApply,
    actual_paid_base: Number(order.actual_paid_amount_base),
    currency_code: order.currency_code,
    invoice: active ? invoiceView(active, order.order_no) : null,
  });
}

// —— IN3 申请发票（登录；一单一有效票；金额/币种快照自订单）——
export async function invoiceApply(supabase, principal, body) {
  const orderId = vUuid(body.order_id, "order_id");
  const invoiceType = vEnum(body.invoice_type, "invoice_type", INVOICE_TYPES);
  const title = vStr(body.title, "title", { min: 2, max: 100 });
  const email = vStr(body.email, "email", { max: 120, pattern: EMAIL_RE });
  const remark = vStr(body.remark, "remark", { max: 200, optional: true });
  let taxNo = null;
  if (invoiceType === "enterprise") {
    taxNo = vStr(body.tax_no, "tax_no", { min: 4, max: 40 });
  } else if (body.tax_no) {
    taxNo = vStr(body.tax_no, "tax_no", { max: 40, optional: true });
  }

  const order = await readOrder(supabase, orderId);
  if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
  if (order.status_payment !== PAID_PAYMENT) {
    throw new AppError(409, "state_conflict", "仅已支付订单可申请发票", { status_payment: order.status_payment });
  }
  const amountBase = Number(order.actual_paid_amount_base);
  if (amountBase <= 0) throw new AppError(409, "state_conflict", "该订单实付金额为零，无法开票");

  const existing = await activeInvoice(supabase, orderId);
  if (existing) {
    throw new AppError(409, "invoice_exists", "该订单已有一张发票申请，如需变更请联系客服", {
      invoice_id: existing.id, status: existing.status,
    });
  }

  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    order_id: order.id,
    user_id: principal.id,
    invoice_type: invoiceType,
    title,
    tax_no: taxNo,
    email,
    remark,
    amount_base: amountBase,
    currency_code: order.currency_code ?? null,
    status: "pending",
    issued_at: null,
    void_reason: null,
    operator_admin_id: null,
    created_at: now,
    updated_at: now,
  };
  const { error } = await supabase.from("invoices").insert(row).select("id").maybeSingle();
  if (error) {
    // 并发重复申请：回读已有有效票并按冲突处理
    const after = await activeInvoice(supabase, orderId);
    if (after) {
      throw new AppError(409, "invoice_exists", "该订单已有一张发票申请", { invoice_id: after.id, status: after.status });
    }
    throw new AppError(500, "internal_error");
  }
  await emit(supabase, {
    userId: principal.id, msgType: "invoice_applied", title: "发票申请已提交",
    content: `订单 ${order.order_no} 的发票申请已提交，开具或作废结果会发在这里`,
    refType: "order", refId: order.id,
  });
  // 响应体用本地对象拼装，不依赖 INSERT 回显（跨 harness/真实库都成立）
  return ok({ invoice: invoiceView(row, order.order_no), created: true });
}

// —— 后台发票队列（perm order.read）——
export async function adminInvoices(supabase, request, query) {
  await adminGuard(supabase, request, "order.read");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("invoices").select(INVOICE_COLS)
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  if (query.status) q = q.eq("status", vEnum(query.status, "status", INVOICE_STATUS));
  if (query.order_id) q = q.eq("order_id", vUuid(query.order_id, "order_id"));
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const noMap = await orderNoMap(supabase, rows.map((r) => r.order_id));

  const buyerMap = new Map();
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  if (userIds.length) {
    const { data: buyers } = await supabase.from("users").select("id,username,nickname").in("id", userIds);
    for (const u of buyers ?? []) buyerMap.set(u.id, `${u.username}${u.nickname ? `（${u.nickname}）` : ""}`);
  }
  const counts = {};
  await Promise.all(INVOICE_STATUS.map(async (status) => {
    counts[status] = await countRows(supabase.from("invoices").select("id", { count: "exact" }).eq("status", status));
  }));
  return ok({
    ...pageResult(rows.map((r) => ({ ...invoiceView(r, noMap.get(r.order_id)), user_id: r.user_id, buyer: buyerMap.get(r.user_id) ?? null })), offset, limit),
    counts_by_status: counts,
  });
}

// —— 后台开具/作废（perm order.operate，idem）——
export async function adminInvoiceAction(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "order.operate");
  const id = vUuid(body.invoice_id, "invoice_id");
  const action = vEnum(body.action, "action", ["issue", "void"]);
  const { data } = await supabase.from("invoices").select(INVOICE_COLS).eq("id", id).maybeSingle();
  if (!data) throw new AppError(404, "not_found", "发票申请不存在", { invoice_id: id });
  const now = nowIso();
  let patch;
  if (action === "issue") {
    if (data.status !== "pending") {
      throw new AppError(409, "state_conflict", "仅待开具的申请可开具", { status: data.status });
    }
    patch = { status: "issued", issued_at: now, void_reason: null, operator_admin_id: actor.id, updated_at: now };
  } else {
    const reason = vStr(body.void_reason, "void_reason", { min: 2, max: 200 });
    if (data.status === "void") throw new AppError(409, "state_conflict", "该申请已作废");
    patch = { status: "void", void_reason: reason, operator_admin_id: actor.id, updated_at: now };
  }
  const { data: cas } = await supabase.from("invoices").update(patch).eq("id", id).eq("status", data.status).select("id");
  // CAS 未命中：并发下状态已变更（响应体改用本地合并对象，不依赖 UPDATE 回显）
  if (!cas?.length) throw new AppError(409, "claim_conflict", "发票状态已变化，请刷新后重试");
  const final = { ...data, ...patch };
  const { data: orderRow } = await supabase.from("orders").select("id,order_no").eq("id", data.order_id).maybeSingle();
  const orderNo = orderRow?.order_no ?? null;
  await emit(supabase, {
    userId: data.user_id,
    msgType: action === "issue" ? "invoice_issued" : "invoice_voided",
    title: action === "issue" ? "发票已开具" : "发票申请已作废",
    content: action === "issue"
      ? `订单 ${orderNo ?? data.order_id} 的发票已开具，电子发票将发送至 ${data.email}`
      : `订单 ${orderNo ?? data.order_id} 的发票申请已作废：${patch.void_reason}`,
    refType: "order", refId: data.order_id,
  });
  await writeAudit(supabase, {
    adminId: actor.id, action: `invoice.${action}`, targetType: "invoice", targetId: id,
    detail: { order_id: data.order_id, from: data.status, to: patch.status, reason: patch.void_reason ?? null },
  });
  return ok({ invoice: invoiceView(final, orderNo), action });
}
