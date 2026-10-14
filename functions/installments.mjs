// 分期付款纯算价 + 配置解析 + 只读端点（文档N V1.0 冻结 D1–D7）
// 依赖方向铁律：本模块**不** import payments.mjs（payments 反向 import 本模块），避免环依赖。
// 纯函数无副作用；读端点只做查询与展示聚合，落库/状态跃迁全部在 payments.mjs。
import { AppError } from "./errors.mjs";
import { readOrder } from "./order_state.mjs";
import { pageParams, pageResult, vUuid, vInt } from "./validate.mjs";

// 首付比例：全站统一常量，不入迁移、不入商品配置（文档N D3）。
export const DEPOSIT_RATIO = 30;
// 可选期数全集（文档N D4）：商品只能从这个集合里配子集，买家只能从子集里选 N。
export const INSTALLMENT_PERIODS = [2, 3, 6, 9, 12];
const INSTALLMENT_BILL_COLS = "id,order_id,installment_index,amount_base,due_date,status,payment_id,paid_at,created_at,updated_at";

// 商品分期配置解析（存于现成 products.extra.installment jsonb，零迁移）：
//   { enabled: true, periods: [3, 6, 12] } —— enabled 只有在至少配了一个合法期数时才为真。
export function parseInstallmentConfig(extra) {
  const inst = extra?.installment;
  if (!inst || inst.enabled !== true) return { enabled: false, periods: [] };
  const raw = Array.isArray(inst.periods) ? inst.periods : [];
  const periods = [...new Set(raw.map((p) => Number(p)).filter((p) => INSTALLMENT_PERIODS.includes(p)))]
    .sort((a, b) => a - b);
  return { enabled: periods.length > 0, periods };
}

// 多商品同单：买家可选期数 = 各商品可选期数的交集（任一商品不支持该期数即不能选）。
export function intersectPeriods(configs) {
  if (!configs.length) return [];
  return configs.reduce((acc, c) => acc.filter((p) => c.periods.includes(p)));
}

// UTC 加月：day-of-month 夹到目标月最后一天（1/31 → 2/28）。用 UTC 与全站时间口径一致。
export function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}

// 算价（文档N D3）：首付计为第 1 期 ⇒「共 N 期」= 1 首付 +（N−1）等额尾款，0 息。
//   d=round(P*30/100)、T=P-d、m=N-1、q=floor(T/m)、尾差 e=T-q*m 并入末期。
// 恒等 Σ=P（首付 d + 前段 q*(m-1) + 末期(q+e) = d + q*m + e = d + T = P）。
export function computeSchedule(totalBase, n) {
  const P = Math.max(0, Math.round(Number(totalBase) || 0));
  const periods = INSTALLMENT_PERIODS;
  if (!periods.includes(n)) throw new AppError(400, "invalid_request", "分期期数不合法", { allowed: periods });
  const depositBase = Math.round((P * DEPOSIT_RATIO) / 100);
  const tailTotal = P - depositBase;
  const m = n - 1;
  const each = m > 0 ? Math.floor(tailTotal / m) : 0;
  const tailDiff = tailTotal - each * m; // 0..m-1，并入末期
  const rows = [{ index: 1, amount_base: depositBase, is_deposit: true }];
  for (let k = 2; k <= n; k += 1) {
    rows.push({ index: k, amount_base: each + (k === n ? tailDiff : 0), is_deposit: false });
  }
  return {
    n,
    total_base: P,
    deposit_ratio: DEPOSIT_RATIO,
    deposit_amount_base: depositBase,
    tail_each_base: each,
    last_amount_base: each + tailDiff,
    periods: rows,
  };
}

// 下单快照：把「相对月份的 schedule」按下单时刻定格成绝对到期日，写进 orders.installment_config（不可变）。
export function snapshotInstallment(totalBase, n, createdAtIso) {
  const s = computeSchedule(totalBase, n);
  return {
    ...s,
    created_at: createdAtIso,
    periods: s.periods.map((p) => ({ ...p, due_date: addMonths(createdAtIso, p.index - 1) })),
  };
}

// 账单行落库前的期序唯一性去重（平台无 UNIQUE(order_id,index)，应用层挡）：已存在的期序跳过。
export function billRowsFromSnapshot(orderId, snapshot, existingIndexes = new Set()) {
  const now = new Date().toISOString();
  return (snapshot.periods ?? [])
    .filter((p) => !existingIndexes.has(p.index))
    .map((p) => ({
      id: crypto.randomUUID(),
      order_id: orderId,
      installment_index: p.index,
      amount_base: p.amount_base,
      due_date: p.due_date ?? null,
      status: "PENDING",
      payment_id: null,
      paid_at: null,
      created_at: now,
      updated_at: now,
    }));
}

export const isInstallmentOrder = (order) => Number(order?.installment_count) >= 2;

// 下单快照里的期次数组（installment_config.periods）；老单/非分期单返回空。
export const snapshotPeriods = (order) => order?.installment_config?.periods ?? [];

// 某期应付额（从不可变快照取，不重算，避免比例/汇率事后变化影响历史单）。
export function periodAmountOf(order, index) {
  const row = snapshotPeriods(order).find((p) => p.index === Number(index));
  return row ? Number(row.amount_base) : null;
}

// 已 CONFIRMED 的分期分项按期序回映：{ index → { payment_id, amount_base } }（同期取最新一笔）。
export async function confirmedPeriodsByIndex(supabase, orderId) {
  const { data } = await supabase.from("payments")
    .select("id,installment_index,amount_base,status").eq("target_type", "order").eq("target_id", orderId)
    .eq("status", "CONFIRMED").order("created_at", { ascending: true });
  const map = new Map();
  for (const p of data ?? []) {
    if (p.installment_index === null || p.installment_index === undefined) continue;
    map.set(Number(p.installment_index), { payment_id: p.id, amount_base: Number(p.amount_base) });
  }
  return map;
}

// —— 分期进度聚合（账单栏 / 结清判定共用；纯计算，不落库）——
// 依据 order_installments 行 + 已 CONFIRMED 分项合计，算出：已付期/剩余期/下期到期/剩余合计/是否逾期。
export function summarizeBill(billRows, confirmedBase, nowMs = Date.now()) {
  const sorted = [...billRows].sort((a, b) => a.installment_index - b.installment_index);
  const n = sorted.length;
  const paid = sorted.filter((r) => r.status === "PAID");
  const remaining = sorted.filter((r) => r.status !== "PAID");
  const remainingBase = remaining.reduce((s, r) => s + Number(r.amount_base), 0);
  const nextDue = remaining.reduce((min, r) => {
    if (!r.due_date) return min;
    return !min || Date.parse(r.due_date) < Date.parse(min) ? r.due_date : min;
  }, null);
  const overdue = remaining.filter((r) => r.due_date && Date.parse(r.due_date) <= nowMs)
    .map((r) => r.installment_index);
  return {
    n,
    paid_count: paid.length,
    remaining_count: remaining.length,
    paid_base: paid.reduce((s, r) => s + Number(r.amount_base), 0),
    remaining_base: remainingBase,
    confirmed_base: Number(confirmedBase) || 0,
    next_due_date: nextDue,
    overdue_indexes: overdue,
    fully_paid: remaining.length === 0,
    periods: sorted.map((r) => ({
      installment_index: r.installment_index,
      amount_base: Number(r.amount_base),
      due_date: r.due_date,
      status: r.status,
      paid_at: r.paid_at,
      payment_id: r.payment_id,
      overdue: Boolean(r.due_date) && r.status !== "PAID" && Date.parse(r.due_date) <= nowMs,
    })),
  };
}

// 已 CONFIRMED 分项合计（分期结清判定口径：ΣCONFIRMED ≥ 应付才算结清）。
async function confirmedBaseOfOrder(supabase, orderId) {
  const { data } = await supabase.from("payments")
    .select("id,amount_base,status").eq("target_type", "order").eq("target_id", orderId);
  return (data ?? []).filter((p) => p.status === "CONFIRMED")
    .reduce((s, p) => s + Number(p.amount_base), 0);
}

async function billOfOrder(supabase, orderId) {
  const { data } = await supabase.from("order_installments").select(INSTALLMENT_BILL_COLS)
    .eq("order_id", orderId).order("installment_index", { ascending: true });
  return data ?? [];
}

// —— 后台通用：按已载入订单构造分期账单视图（非分期单返回 null）。
// 调用方（admin_order/detail）已完成 order.read 鉴权，故此处不再做买家归属校验。
export async function installmentViewOfOrder(supabase, order) {
  if (!isInstallmentOrder(order)) return null;
  const [rows, confirmedBase] = await Promise.all([billOfOrder(supabase, order.id), confirmedBaseOfOrder(supabase, order.id)]);
  return {
    order_id: order.id,
    installment_count: Number(order.installment_count),
    installment_config: order.installment_config ?? null,
    status_payment: order.status_payment,
    actual_paid_amount_base: Number(order.actual_paid_amount_base),
    ...summarizeBill(rows, confirmedBase),
  };
}

// —— IB1 分期账单（买家本单）：期次明细 + 进度 + 可提前结清的剩余合计 ——
export async function installmentBill(supabase, principal, query) {
  const orderId = vUuid(query.order_id ?? query.id, "order_id");
  const order = await readOrder(supabase, orderId);
  if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
  if (!isInstallmentOrder(order)) {
    throw new AppError(409, "state_conflict", "该订单不是分期订单", { installment_count: order.installment_count ?? null });
  }
  const [rows, confirmedBase] = await Promise.all([billOfOrder(supabase, orderId), confirmedBaseOfOrder(supabase, orderId)]);
  return {
    order_id: orderId,
    order_no: order.order_no,
    status_order: order.status_order,
    status_payment: order.status_payment,
    installment_count: Number(order.installment_count),
    installment_config: order.installment_config ?? null,
    actual_paid_amount_base: Number(order.actual_paid_amount_base),
    ...summarizeBill(rows, confirmedBase),
  };
}

// —— IB2 我的分期订单栏（买家「我的订单 → 分期订单」）：列进行中分期单的进度摘要 ——
export async function myInstallments(supabase, principal, query) {
  const { offset, limit } = pageParams(query);
  const { data, error } = await supabase.from("orders")
    .select("id,order_no,status_order,status_payment,actual_paid_amount_base,currency_code,currency_actual_amount,installment_count,created_at")
    .eq("user_id", principal.id).gte("installment_count", 2)
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const items = await Promise.all(rows.map(async (o) => {
    const [bills, confirmedBase] = await Promise.all([billOfOrder(supabase, o.id), confirmedBaseOfOrder(supabase, o.id)]);
    return { ...o, actual_paid_amount_base: Number(o.actual_paid_amount_base), ...summarizeBill(bills, confirmedBase) };
  }));
  return pageResult(items, offset, limit);
}
