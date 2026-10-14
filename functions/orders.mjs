// 交易主链 O1–O5 + 取消补偿核心（文档B §1.1/§2、文档C §四）
import { AppError } from "./errors.mjs";
import { getCurrencyOrBase, getMergedConfig } from "./config.mjs";
import { applyStockChange } from "./inventory.mjs";
import { loadAddressSnapshot } from "./address.mjs";
import {
  allowedActions, assertLegalCombo, isExpired, readOrder, readOrderItems, settleComplete, writeStatusLog,
} from "./order_state.mjs";
import { paymentsWithProofs, settlePaymentsOnCancel } from "./payments.mjs";
import { lockCoupon, priceCouponForOrder, releaseCoupon } from "./coupons.mjs";
import { activeVip, vipDiscountOfLines } from "./vip.mjs";
import { INSTALLMENT_PERIODS, parseInstallmentConfig, snapshotInstallment } from "./installments.mjs";
import { nowIso, pageParams, pageResult, vInt, vStr, vUuid, countRows } from "./validate.mjs";
import { emit } from "./notify.mjs";

const BRIEF_COLS = "id,order_no,user_id,status_order,status_payment,status_shipping,goods_amount_base,"
  + "discount_amount_base,actual_paid_amount_base,coupon_instance_id,installment_count,"
  + "currency_code,currency_rate_scaled,currency_actual_amount,currency_name_snapshot,payment_deadline,created_at,updated_at";

// 前端聚合标签（文档B §1.1 注：审核中不是 order_status，只是展示细分）
const TABS = {
  all: null,
  pending_payment: "PENDING_PAYMENT",
  unshipped: "PAID",
  shipped: "SHIPPED",
  completed: "COMPLETED",
  cancelled: "CANCELLED",
};

function statusDisplay(order) {
  if (order.status_order === "PENDING_PAYMENT") {
    if (order.status_payment === "PENDING_REVIEW") return "pending_review";
    if (order.status_payment === "REJECTED") return "payment_rejected";
    return "pending_payment";
  }
  // 分期进行中（首付已付、订单已生效、未凑满）：status_order 仍是 PAID，用细分标签区分
  if (order.status_order === "PAID" && order.status_payment === "INSTALLMENT_ACTIVE") return "installment";
  return {
    PAID: "unshipped", SHIPPED: "shipped", COMPLETED: "completed",
    CANCELLED: "cancelled", REFUNDING: "refunding", REFUNDED: "refunded",
  }[order.status_order] ?? order.status_order;
}

function digitalOrderNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  let rand = "";
  for (let i = 0; i < 6; i += 1) rand += Math.floor(Math.random() * 10);
  return `M${stamp}${rand}`;
}

// 分期个人信息（购买须知确认页采集的四项）：判据与前端 InstallmentProfileModal 逐条同口径
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PROFILE_PHONE_RE = /^[0-9+-]{5,20}$/;

function parseInstallmentProfile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "installment_profile_required", "分期购买需先填写姓名、手机号、邮箱地址与详细住址");
  }
  const name = vStr(raw.name, "name", { min: 1, max: 30 });
  const phone = vStr(raw.phone, "phone", { min: 5, max: 20 });
  if (!PROFILE_PHONE_RE.test(phone)) throw new AppError(400, "invalid_request", "格式不正确", { field: "phone" });
  const email = vStr(raw.email, "email", { min: 6, max: 120 });
  if (!EMAIL_RE.test(email)) throw new AppError(400, "invalid_request", "格式不正确", { field: "email" });
  const address = vStr(raw.address, "address", { min: 5, max: 200 });
  return { name, phone, email, address };
}

const toMoney = (v) => Number(v ?? 0);

// 计价口径词表：无抵扣 / 单券 / 单会员 / 会员+券（抵扣额拆分见同快照的两个字段）
const pricingMode = (vipBase, couponBase) => {
  const kinds = [vipBase > 0 ? "vip" : null, couponBase > 0 ? "coupon" : null].filter(Boolean);
  return kinds.length ? `base_with_${kinds.join("_")}` : "base_no_discount";
};

// ②–⑥ 失败时逆序解冻（文档B §2 补偿链）
async function compensateFreeze(supabase, frozenLines, operator) {
  for (const line of [...frozenLines].reverse()) {
    await applyStockChange(supabase, {
      skuId: line.sku_id, changeType: "unfreeze", quantity: line.quantity,
      referenceType: "order", referenceId: line.order_id, operator, reason: "下单失败回滚解冻",
    });
  }
}

// ③ 之后任一步失败 → 退券（LOCKED→UNUSED）
async function compensateCoupon(supabase, coupon, orderId) {
  if (!coupon) return;
  await releaseCoupon(supabase, { couponId: coupon.id, orderId });
}

// —— O1 创建订单（九步序列；VIP 折扣 + 券抵扣已接入，运费留待后续里程碑）——
export async function createOrder(supabase, principal, body) {
  const { config } = await getMergedConfig(supabase);
  if (!config.switches?.order_open) throw new AppError(409, "state_conflict", "下单功能暂未开放");
  const timeoutHours = Number.isSafeInteger(config.pay_channels?.payment_timeout_hours)
    ? config.pay_channels.payment_timeout_hours : 48;

  if (!Array.isArray(body.cart_ids) || !body.cart_ids.length || body.cart_ids.length > 50) {
    throw new AppError(400, "invalid_request", "cart_ids 需为 1–50 条", { field: "cart_ids" });
  }
  const cartIds = [...new Set(body.cart_ids.map((id) => vUuid(id, "cart_ids")))];
  // 币种以账号侧为准（注册时按区号定，前端不再可改）；账号币种已被后台下架时回落站点本位币，
  // body.currency_code 只允许等于账号币种或实际采用的币种，防绕过
  const { data: buyer } = await supabase.from("users")
    .select("id,currency_code").eq("id", principal.id).is("deleted_at", null).maybeSingle();
  if (!buyer) throw new AppError(404, "not_found");
  const currency = await getCurrencyOrBase(supabase, buyer.currency_code);
  const declared = body.currency_code;
  if (declared !== undefined && declared !== null && declared !== buyer.currency_code && declared !== currency.code) {
    throw new AppError(400, "currency_mismatch", "下单币种必须与账号币种一致", { account: buyer.currency_code, declared });
  }
  const buyerRemark = vStr(body.buyer_remark, "buyer_remark", { max: 500, optional: true });
  const couponId = body.coupon_id ? vUuid(body.coupon_id, "coupon_id") : null;
  // 分期（文档N D4）：body.installment = 买家所选期数；缺省/0 = 全额支付。开关关闭时一律拒绝。
  const installmentN = (body.installment === undefined || body.installment === null || body.installment === 0)
    ? null : vInt(body.installment, "installment", { min: 2, max: 12 });
  if (installmentN !== null) {
    if (!config.switches?.installment) throw new AppError(409, "state_conflict", "分期功能暂未开放");
    if (!INSTALLMENT_PERIODS.includes(installmentN)) {
      throw new AppError(400, "invalid_request", "分期期数不合法", { allowed: INSTALLMENT_PERIODS });
    }
  }
  // 分期单必须先过「个人信息填写 + 购买须知确认页」；全额单一律不采集、不落库（不留 PII）
  const installmentProfile = installmentN !== null ? parseInstallmentProfile(body.installment_profile) : null;
  const addressSnapshot = await loadAddressSnapshot(supabase, principal.id, body.address_id);

  const { data: cartRows, error: cartErr } = await supabase.from("carts")
    .select("id,sku_id,quantity").eq("user_id", principal.id).in("id", cartIds);
  if (cartErr) throw new AppError(500, "internal_error");
  const found = cartRows ?? [];
  if (found.length !== cartIds.length) throw new AppError(404, "not_found", "购物车条目不存在或已变动");

  const orderId = crypto.randomUUID();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const deadline = new Date(now + timeoutHours * 3600 * 1000).toISOString();

  const lines = [];
  const frozen = [];
  const instConfigs = [];
  for (const row of found) {
    const quantity = vInt(row.quantity, "quantity", { min: 1, max: 999 });
    const { data: sku } = await supabase.from("product_skus")
      .select("id,product_id,spec_name,sku_code,price_base,status").eq("id", row.sku_id).is("deleted_at", null).maybeSingle();
    const product = sku
      ? (await supabase.from("products").select("id,category_id,title,images,status,extra").eq("id", sku.product_id).is("deleted_at", null).maybeSingle()).data
      : null;
    if (!sku || !product || sku.status !== "on" || product.status !== "on") {
      await compensateFreeze(supabase, frozen, principal.id);
      throw new AppError(409, "state_conflict", "商品已下架", { sku_id: row.sku_id });
    }
    const res = await applyStockChange(supabase, {
      skuId: sku.id, changeType: "freeze", quantity,
      referenceType: "order", referenceId: orderId, operator: principal.id, reason: "下单冻结",
    });
    if (!res.ok) {
      await compensateFreeze(supabase, frozen, principal.id);
      if (res.reason === "insufficient" || res.reason === "conflict") {
        throw new AppError(409, "insufficient_stock", "库存不足", { sku_id: sku.id, quantity });
      }
      if (res.reason === "not_found") throw new AppError(404, "not_found", "商品不存在");
      throw new AppError(500, "internal_error");
    }
    frozen.push({ sku_id: sku.id, quantity, order_id: orderId });
    if (installmentN !== null) instConfigs.push(parseInstallmentConfig(product.extra));
    const unit = toMoney(sku.price_base);
    lines.push({
      product_id: product.id,
      category_id: product.category_id,
      sku_id: sku.id,
      title_snapshot: product.title,
      image_snapshot: product.images ?? [],
      spec_snapshot: sku.spec_name,
      price_base_snapshot: unit,
      currency_price_snapshot: Math.round((unit * toMoney(currency.rate_scaled)) / 1e6),
      quantity,
      subtotal_base: unit * quantity,
    });
  }

  // 分期资格（文档N D6）：所选期数必须被本单每件商品都支持（商品 extra.installment 开且含该 N）
  if (installmentN !== null) {
    const unsupported = instConfigs.filter((c) => !c.enabled || !c.periods.includes(installmentN)).length;
    if (unsupported > 0) {
      await compensateFreeze(supabase, frozen, principal.id);
      throw new AppError(409, "state_conflict", "所选商品不支持该分期期数", { installment: installmentN, unsupported });
    }
  }

  // ④ VIP 折扣（方案 §8 顺序：原价 → VIP 快照 → 券 → 运费 → 应付）
  // 折扣额按快照万分比逐行 floor 分摊，券门槛与抵扣一律按折后金额判定
  const vip = await activeVip(supabase, principal.id);
  const stackCoupon = config.switches?.vip_coupon_stack !== false;
  const useVip = Boolean(vip) && (stackCoupon || !couponId);
  const vipCut = useVip ? vipDiscountOfLines(lines, vip.discount_rate) : { lines, discount_base: 0 };
  const vipLines = vipCut.lines;
  const vipDiscountBase = vipCut.discount_base;

  // ③ 锁券 + 券抵扣（券只作用在 VIP 折后金额上）
  let coupon = null;
  let couponTemplate = null;
  let discountBase = 0;
  let couponEligibleBase = 0;
  if (couponId) {
    let priced;
    try {
      priced = await priceCouponForOrder(supabase, { couponId, userId: principal.id, lines: vipLines });
    } catch (err) {
      await compensateFreeze(supabase, frozen, principal.id);
      throw err;
    }
    coupon = priced.coupon;
    couponTemplate = priced.template;
    discountBase = priced.deduction;
    couponEligibleBase = priced.eligible;
    const lock = await lockCoupon(supabase, { couponId, userId: principal.id, orderId });
    if (lock.conflict) {
      await compensateFreeze(supabase, frozen, principal.id);
      throw new AppError(409, "coupon_unavailable", "优惠券已被占用或状态变化", { conflict: lock.conflict });
    }
    coupon = lock.coupon ?? coupon;
  }

  // goods 存原价合计（文档A：goods=Σ明细、actual=goods−discount+freight，两列都必须与 order_items 对得上）
  const goodsBase = lines.reduce((sum, l) => sum + l.subtotal_base, 0);
  const totalDiscountBase = vipDiscountBase + discountBase;
  const actualBase = Math.max(0, goodsBase - totalDiscountBase); // 运费一期为 0
  const rateScaled = toMoney(currency.rate_scaled);
  // 分期快照：按下单当刻应付额 P 算出各期金额与绝对到期日，定格进 orders（不可变，文档N D3）
  const installmentConfig = installmentN !== null ? snapshotInstallment(actualBase, installmentN, createdAt) : null;
  const orderRow = {
    id: orderId,
    order_no: digitalOrderNo(),
    user_id: principal.id,
    status_order: "PENDING_PAYMENT",
    status_payment: "UNPAID",
    status_shipping: "NOT_SHIPPED",
    goods_amount_base: goodsBase,
    // discount_amount_base 单列承载 VIP + 券两段抵扣，拆分依据见 pricing_snapshot
    discount_amount_base: totalDiscountBase,
    freight_amount_base: 0,
    actual_paid_amount_base: actualBase,
    currency_code: currency.code,
    currency_rate_scaled: rateScaled,
    currency_actual_amount: Math.round((actualBase * rateScaled) / 1e6),
    currency_name_snapshot: `${currency.symbol} ${currency.code}`,
    payment_deadline: deadline,
    address_snapshot: addressSnapshot,
    pricing_snapshot: {
      mode: pricingMode(vipDiscountBase, discountBase),
      lines: lines.length,
      goods_amount_base: goodsBase,
      discount_amount_base: totalDiscountBase,
      vip_discount_amount_base: vipDiscountBase,
      coupon_discount_amount_base: discountBase,
      freight_amount_base: 0,
      payment_timeout_hours: timeoutHours,
      // 会员折扣按开通时快照记录（含当时的 tier_key/rate/到期时刻），套餐后续改动不回溯（方案 §10）
      vip: useVip ? {
        vip_id: vip.vip_id,
        tier_key: vip.tier_key,
        discount_rate: vip.discount_rate,
        expire_at: vip.expire_at,
      } : null,
      vip_skipped: vip && !useVip ? "no_stack" : null,
      coupon: coupon && couponTemplate ? {
        coupon_id: coupon.id,
        template_id: couponTemplate.id,
        name: couponTemplate.name,
        // 券名译文随快照一并定格（pricing_snapshot 是 jsonb，无迁移）：订单详情页据此按买家语言显示，
        // 旧订单没有这个键 ⇒ 前端回落到上面的 name 原文
        name_i18n: couponTemplate.name_i18n ?? {},
        coupon_type: couponTemplate.coupon_type,
        threshold_amount_base: toMoney(couponTemplate.threshold_amount_base),
        discount_amount_base: toMoney(couponTemplate.discount_amount_base),
        scope: couponTemplate.scope,
        eligible_amount_base: couponEligibleBase,
        expire_at: coupon.expire_at,
      } : null,
    },
    coupon_instance_id: coupon?.id ?? null,
    installment_count: installmentN,
    installment_config: installmentConfig,
    // 分期个人信息写入现成 orders.extra jsonb（零迁移）；全额单留 null，绝不落 PII
    extra: installmentProfile ? { installment_profile: installmentProfile } : null,
    buyer_remark: buyerRemark,
    created_at: createdAt,
    updated_at: createdAt,
  };

  let inserted = false;
  for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
    const { error } = await supabase.from("orders").insert(orderRow);
    if (!error) inserted = true;
    else if (error.code !== "23505") break;
    else orderRow.order_no = digitalOrderNo();
  }
  if (!inserted) {
    await compensateFreeze(supabase, frozen, principal.id);
    await compensateCoupon(supabase, coupon, orderId);
    throw new AppError(500, "internal_error");
  }

  const itemRows = lines.map((l) => ({
    id: crypto.randomUUID(),
    order_id: orderId,
    product_id: l.product_id,
    sku_id: l.sku_id,
    title_snapshot: l.title_snapshot,
    image_snapshot: l.image_snapshot,
    spec_snapshot: l.spec_snapshot,
    price_base_snapshot: l.price_base_snapshot,
    currency_price_snapshot: l.currency_price_snapshot,
    quantity: l.quantity,
    subtotal_base: l.subtotal_base,
    created_at: createdAt,
  }));
  const { error: itemsErr } = await supabase.from("order_items").insert(itemRows);
  if (itemsErr) {
    await compensateFreeze(supabase, frozen, principal.id);
    await compensateCoupon(supabase, coupon, orderId);
    await supabase.from("orders").update({ status_order: "CANCELLED", cancel_reason: "明细写入失败", cancelled_at: nowIso(), updated_at: nowIso() })
      .eq("id", orderId).eq("status_order", "PENDING_PAYMENT");
    throw new AppError(500, "internal_error");
  }

  for (const [dim, from, to] of [
    ["order", "CREATE", "PENDING_PAYMENT"],
    ["payment", "CREATE", "UNPAID"],
    ["shipping", "CREATE", "NOT_SHIPPED"],
  ]) {
    await writeStatusLog(supabase, {
      orderId, dim, fromStatus: from, toStatus: to, operatorType: "user", operatorId: principal.id, reason: "创建订单",
    });
  }

  // ⑥ 清购物车（订单已落库，此处失败不回滚订单）
  const { error: cleanErr } = await supabase.from("carts")
    .delete().eq("user_id", principal.id).in("id", cartIds);

  return {
    order_id: orderId,
    order_no: orderRow.order_no,
    status_order: "PENDING_PAYMENT",
    status_payment: "UNPAID",
    goods_amount_base: goodsBase,
    discount_amount_base: totalDiscountBase,
    vip_discount_amount_base: vipDiscountBase,
    actual_paid_amount_base: actualBase,
    currency_code: currency.code,
    currency_actual_amount: orderRow.currency_actual_amount,
    payment_deadline: deadline,
    installment_count: installmentN,
    installment_config: installmentConfig,
    cart_cleanup_failed: Boolean(cleanErr),
  };
}

// —— 取消内核（O4 用户取消 / OD4 后台关单 / T1 超时共用；先 CAS 认领再补偿）——
export async function cancelOrder(supabase, { order, reason, operatorType, operatorId = null }) {
  const now = nowIso();
  const { data: cas } = await supabase.from("orders")
    .update({ status_order: "CANCELLED", cancel_reason: reason, cancelled_at: now, updated_at: now })
    .eq("id", order.id).eq("status_order", "PENDING_PAYMENT")
    .in("status_payment", ["UNPAID", "REJECTED"]).select("id");
  if (!cas?.length) return { cancelled: false, reason: "conflict" };

  const logOk = await writeStatusLog(supabase, {
    orderId: order.id, dim: "order", fromStatus: "PENDING_PAYMENT", toStatus: "CANCELLED",
    operatorType, operatorId, reason,
  });
  // 文档B §1.1：仅超时自动取消给顾客发通知，用户主动取消与后台关单不发
  if (operatorType === "system") {
    await emit(supabase, {
      userId: order.user_id, msgType: "order_timeout", title: "订单已超时取消",
      content: `订单 ${order.order_no} 超过支付时限已自动关闭，冻结的库存与优惠券已退回`,
      refType: "order", refId: order.id,
    });
  }

  const { data: items } = await supabase.from("order_items")
    .select("id,sku_id,quantity").eq("order_id", order.id);
  const unreleased = [];
  for (const it of items ?? []) {
    const res = await applyStockChange(supabase, {
      skuId: it.sku_id, changeType: "unfreeze", quantity: Number(it.quantity),
      referenceType: "order", referenceId: order.id, operator: operatorId ?? "system", reason: "订单取消解冻",
    });
    if (!res.ok) unreleased.push({ sku_id: it.sku_id, reason: res.reason });
  }

  const payments = await settlePaymentsOnCancel(supabase, { order, reason });

  // §4 退券：LOCKED→UNUSED（重校验有效期，已过期则 EXPIRED）
  const { data: locked } = await supabase.from("user_coupons")
    .select("id,status").eq("order_id", order.id).eq("status", "LOCKED");
  const coupons = [];
  for (const row of locked ?? []) {
    const res = await releaseCoupon(supabase, { couponId: row.id, orderId: order.id });
    coupons.push({ coupon_id: row.id, ...res });
  }

  assertLegalCombo({ ...order, status_order: "CANCELLED" });
  return {
    cancelled: true, order_id: order.id, status_log: logOk,
    unreleased, released_coupons: coupons, ...payments,
  };
}

async function orderBrief(supabase, orderId, userId) {
  const id = vUuid(orderId, "order_id");
  const { data } = await supabase.from("orders").select(BRIEF_COLS).eq("id", id).maybeSingle();
  if (!data || (userId && data.user_id !== userId)) throw new AppError(404, "not_found", "订单不存在");
  return data;
}

// —— O2 我的订单（tab 聚合 + 各标签计数）——
export async function orderList(supabase, principal, query) {
  const tab = query.tab ?? "all";
  if (!Object.prototype.hasOwnProperty.call(TABS, tab)) {
    throw new AppError(400, "invalid_request", "tab 不在白名单", { allowed: Object.keys(TABS) });
  }
  const { offset, limit } = pageParams(query);
  let q = supabase.from("orders").select(BRIEF_COLS).eq("user_id", principal.id)
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  if (TABS[tab]) q = q.eq("status_order", TABS[tab]);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  // HB2 惰性顺带：本页内的到期订单就地认领取消（CAS 0 行=已被他人处理）
  for (const row of rows) {
    if (!isExpired(row)) continue;
    try {
      const res = await cancelOrder(supabase, {
        order: row, reason: "支付超时自动取消", operatorType: "system", operatorId: null,
      });
      if (res.cancelled) {
        row.status_order = "CANCELLED";
        row.cancel_reason = "支付超时自动取消";
      }
    } catch { /* 展示优先，单行失败留给 tick T1 */ }
  }
  const itemsMap = await readOrderItems(supabase, rows.map((r) => r.id));
  const counts = {};
  await Promise.all(Object.values(TABS).filter(Boolean).map(async (status) => {
    counts[status] = await countRows(supabase.from("orders").select("id", { count: "exact" })
      .eq("user_id", principal.id).eq("status_order", status));
  }));
  return {
    ...pageResult(rows.map((r) => ({
      ...r,
      status_display: statusDisplay(r),
      expired: isExpired(r),
      items: itemsMap.get(r.id) ?? [],
      item_count: (itemsMap.get(r.id) ?? []).length,
    })), offset, limit),
    counts_by_status: counts,
  };
}

// —— O3 订单详情（HB2 惰性顺带：发现过期 → 同请求内认领取消）——
export async function orderDetail(supabase, principal, query) {
  let order = await orderBrief(supabase, query.order_id ?? query.id, principal.id);
  let lazyCancel = null;
  if (isExpired(order)) {
    const full = await readOrder(supabase, order.id);
    const res = await cancelOrder(supabase, {
      order: full, reason: "支付超时自动取消", operatorType: "system", operatorId: null,
    });
    if (res.cancelled) {
      lazyCancel = { cancelled: true, released: res.unreleased.length === 0 };
      order = await orderBrief(supabase, order.id, principal.id);
    }
  }
  const full = await readOrder(supabase, order.id);
  const itemsMap = await readOrderItems(supabase, [order.id]);
  return {
    order: { ...full, status_display: statusDisplay(full), expired: isExpired(full) },
    items: itemsMap.get(order.id) ?? [],
    payments: await paymentsWithProofs(supabase, order.id),
    allowed_actions: allowedActions(full),
    lazy_cancel: lazyCancel ?? undefined,
  };
}

// —— O4 用户取消 ——
export async function orderCancel(supabase, principal, body) {
  const order = await readOrder(supabase, vUuid(body.order_id, "order_id"));
  if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
  if (order.status_order !== "PENDING_PAYMENT") {
    throw new AppError(409, "state_conflict", "订单当前不可取消", { status_order: order.status_order });
  }
  if (order.status_payment === "PENDING_REVIEW") {
    throw new AppError(409, "state_conflict", "凭证审核中，请等待审核结果后再取消", { action: "cancel" });
  }
  const reason = vStr(body.reason, "reason", { max: 200, optional: true }) ?? "用户取消";
  const res = await cancelOrder(supabase, { order, reason, operatorType: "user", operatorId: principal.id });
  if (!res.cancelled) throw new AppError(409, "claim_conflict", "订单状态已变化，请刷新后重试", null);
  return { order_id: order.id, status_order: "CANCELLED", cancel_reason: reason };
}

// —— O5 确认收货 ——
export async function orderConfirmReceipt(supabase, principal, body) {
  const order = await readOrder(supabase, vUuid(body.order_id, "order_id"));
  if (!order || order.user_id !== principal.id) throw new AppError(404, "not_found", "订单不存在");
  if (order.status_order !== "SHIPPED") {
    throw new AppError(409, "state_conflict", "订单当前不可确认收货", { status_order: order.status_order });
  }
  const res = await settleComplete(supabase, {
    order, operatorType: "user", operatorId: principal.id, reason: "用户确认收货",
  });
  if (!res.completed) throw new AppError(409, "claim_conflict", "订单状态已变化，请刷新后重试");
  return { order_id: order.id, status_order: "COMPLETED", status_shipping: "DELIVERED" };
}

export { statusDisplay };
