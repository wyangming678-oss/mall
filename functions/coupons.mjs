// 优惠券（文档A §21/§22、文档B §4、文档C CP1/CP2 + CY1/CY2 + AU4）
// 状态集合 UNUSED/LOCKED/USED/EXPIRED/REVOKED，推进一律条件 CAS；发放防刷顺序=每人上限 → 模板库存 CAS → 才发券。
import { AppError, isUniqueViolation, ok } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { getMergedConfig } from "./config.mjs";
import { activeVip, vipDiscountOfLines } from "./vip.mjs";
import { nowIso, pageParams, pageResult, vBool, vEnum, vI18nMap, vInt, vStr, vUuid, countRows } from "./validate.mjs";

const TEMPLATE_COLS = "id,name,name_i18n,coupon_type,threshold_amount_base,discount_amount_base,scope,scope_ids,"
  + "valid_days,valid_from,valid_until,total_quota,unlimited,issued_count,per_user_limit,status,claimable,"
  + "created_at,updated_at";
const COUPON_COLS = "id,template_id,user_id,order_id,status,expire_at,source,source_ref_id,created_at,updated_at";

export const COUPON_STATUS = ["UNUSED", "LOCKED", "USED", "EXPIRED", "REVOKED"];
const TEMPLATE_STATUS = ["on", "off", "archived"];
const NEXT_TEMPLATE_STATUS = { on: ["off", "archived"], off: ["on", "archived"], archived: [] };
const COUPON_TYPES = ["threshold", "direct"];
const COUPON_SCOPES = ["all", "category", "product"];
// 占每人上限的实例状态（REVOKED 已撤销，不占）
const HOLD_LIMIT_STATUS = ["UNUSED", "LOCKED", "USED", "EXPIRED"];
const MAX_SCAN = 100;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const money = (v) => Number(v ?? 0);

function vTime(v, field, { optional = false } = {}) {
  if ((v === undefined || v === null || v === "") && optional) return null;
  const s = vStr(v, field, { max: 40, pattern: ISO_RE });
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new AppError(400, "invalid_request", "时间格式不合法", { field });
  return new Date(ms).toISOString();
}

// —— 发放时定格有效期（相对天数 / 绝对窗口二选一，文档A §21）——
function expireAtOf(template, nowMs = Date.now()) {
  return template.valid_days > 0
    ? new Date(nowMs + template.valid_days * 86400 * 1000).toISOString()
    : template.valid_until;
}

function windowOpen(template, nowMs = Date.now()) {
  if (template.valid_days > 0) return true;
  if (!template.valid_until) return false;
  if (Date.parse(template.valid_until) <= nowMs) return false;
  if (template.valid_from && Date.parse(template.valid_from) > nowMs) return false;
  return true;
}

// —— 惰性过期：到期 UNUSED → EXPIRED（文档B §4 / §12 T4）——
export async function lazyExpireCoupons(supabase, rows, nowMs = Date.now()) {
  let expired = 0;
  for (const row of rows ?? []) {
    if (row.status !== "UNUSED" || Date.parse(row.expire_at) > nowMs) continue;
    const { data: cas } = await supabase.from("user_coupons")
      .update({ status: "EXPIRED", updated_at: nowIso() })
      .eq("id", row.id).eq("status", "UNUSED").select("id");
    if (cas?.length) {
      row.status = "EXPIRED";
      expired += 1;
    }
  }
  return expired;
}

async function loadTemplate(supabase, templateId) {
  const { data } = await supabase.from("coupon_templates")
    .select(TEMPLATE_COLS).eq("id", templateId).is("deleted_at", null).maybeSingle();
  return data ?? null;
}

async function heldByUser(supabase, templateId, userId) {
  return countRows(supabase.from("user_coupons")
    .select("id", { count: "exact" })
    .eq("template_id", templateId).eq("user_id", userId).in("status", HOLD_LIMIT_STATUS));
}

const grantIdemKey = (templateId, userId, seq) => `grant:${templateId}:${userId}:${seq}`;

// —— 发放内核（文档B §4 防刷顺序；idem_key 兜底重复发放）——
export async function grantCoupon(supabase, {
  templateId, userId, seq = 0, source = "admin", sourceRefId = null, nowMs = Date.now(),
}) {
  const template = await loadTemplate(supabase, templateId);
  if (!template || template.status !== "on") return { granted: false, reason: "coupon_unavailable" };
  if (!windowOpen(template, nowMs)) return { granted: false, reason: "coupon_unavailable" };
  if (await heldByUser(supabase, template.id, userId) >= money(template.per_user_limit)) {
    return { granted: false, reason: "quota_reached" };
  }

  let claimed = false;
  const issuedBefore = money(template.issued_count);
  if (!template.unlimited) {
    if (issuedBefore >= money(template.total_quota)) return { granted: false, reason: "quota_reached" };
    const { data: cas } = await supabase.from("coupon_templates")
      .update({ issued_count: issuedBefore + 1, updated_at: nowIso() })
      .eq("id", template.id).eq("issued_count", issuedBefore).select("id");
    if (!cas?.length) return { granted: false, reason: "claim_conflict" };
    claimed = true;
  }

  const couponId = crypto.randomUUID();
  const row = {
    id: couponId,
    template_id: template.id,
    user_id: userId,
    order_id: null,
    status: "UNUSED",
    expire_at: expireAtOf(template, nowMs),
    source,
    source_ref_id: sourceRefId,
    idem_key: grantIdemKey(template.id, userId, seq),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const { error } = await supabase.from("user_coupons").insert(row);
  if (error) {
    if (claimed) {
      await supabase.from("coupon_templates")
        .update({ issued_count: issuedBefore, updated_at: nowIso() })
        .eq("id", template.id).eq("issued_count", issuedBefore + 1);
    }
    if (isUniqueViolation(error)) {
      const { data: existing } = await supabase.from("user_coupons")
        .select("id").eq("idem_key", row.idem_key).maybeSingle();
      return { granted: false, duplicated: true, reason: "duplicated", coupon_id: existing?.id ?? null };
    }
    throw new AppError(500, "internal_error");
  }
  return { granted: true, coupon_id: couponId, expire_at: row.expire_at };
}

// —— 适用范围与门槛（方案 §8：券抵扣在商品额之后；抵扣不超过适用小计）——
export function couponDeduction(template, lines) {
  const ids = Array.isArray(template.scope_ids) ? template.scope_ids.map(String) : [];
  let eligibleBase = 0;
  for (const line of lines) {
    const hit = template.scope === "all"
      || (template.scope === "category" && ids.includes(String(line.category_id)))
      || (template.scope === "product" && ids.includes(String(line.product_id)));
    if (hit) eligibleBase += money(line.subtotal_base);
  }
  const threshold = money(template.threshold_amount_base);
  if (eligibleBase < threshold) {
    return { eligible_base: eligibleBase, deduction_base: 0, reason: "below_threshold" };
  }
  if (eligibleBase <= 0) return { eligible_base: 0, deduction_base: 0, reason: "scope_empty" };
  return {
    eligible_base: eligibleBase,
    deduction_base: Math.min(money(template.discount_amount_base), eligibleBase),
    reason: null,
  };
}

async function templateMap(supabase, templateIds) {
  const ids = [...new Set(templateIds)];
  if (!ids.length) return new Map();
  // 与 loadTemplate 同口径排除软删模板：已删券名不再展示（前端按语言落「券已下架」），
  // 而 priceCouponForOrder 本来就用 loadTemplate 拒绝该券 ⇒ 展示与可用性一致。
  const { data } = await supabase.from("coupon_templates").select(TEMPLATE_COLS).in("id", ids).is("deleted_at", null);
  return new Map((data ?? []).map((t) => [t.id, t]));
}

function couponView(coupon, template) {
  return {
    coupon_id: coupon.id,
    template_id: coupon.template_id,
    order_id: coupon.order_id,
    status: coupon.status,
    expire_at: coupon.expire_at,
    source: coupon.source,
    created_at: coupon.created_at,
    // 券名与商品名同口径：函数只透传原文 + 译文 map，取词在前端 pickLocalized。
    // 模板行已不可用时 name 落空串，由前端按语言显示「券已下架」（不再在函数侧写死中文）。
    name: template?.name ?? "",
    name_i18n: template?.name_i18n ?? {},
    coupon_type: template?.coupon_type ?? "direct",
    threshold_amount_base: money(template?.threshold_amount_base),
    discount_amount_base: money(template?.discount_amount_base),
    scope: template?.scope ?? "all",
    scope_ids: Array.isArray(template?.scope_ids) ? template.scope_ids : [],
  };
}

// —— 下单/预览共用的购物车行（sku → 商品/分类/小计）——
export async function cartLinesForPricing(supabase, userId, cartIds) {
  const { data: carts, error } = await supabase.from("carts")
    .select("id,sku_id,quantity").eq("user_id", userId).in("id", cartIds);
  if (error) throw new AppError(500, "internal_error");
  const rows = carts ?? [];
  if (rows.length !== cartIds.length) throw new AppError(404, "not_found", "购物车条目不存在或已变动");
  const skuIds = [...new Set(rows.map((c) => c.sku_id))];
  const { data: skus } = await supabase.from("product_skus")
    .select("id,product_id,price_base,status").in("id", skuIds).is("deleted_at", null);
  const productIds = [...new Set((skus ?? []).map((s) => s.product_id))];
  const { data: products } = productIds.length
    ? await supabase.from("products").select("id,category_id,title,status").in("id", productIds).is("deleted_at", null)
    : { data: [] };
  const productMap = new Map((products ?? []).map((p) => [p.id, p]));
  const skuMap = new Map((skus ?? []).map((s) => [s.id, s]));
  const lines = [];
  for (const cart of rows) {
    const sku = skuMap.get(cart.sku_id);
    const product = sku ? productMap.get(sku.product_id) : null;
    if (!sku || !product || sku.status !== "on" || product.status !== "on") {
      throw new AppError(409, "state_conflict", "商品已下架", { sku_id: cart.sku_id });
    }
    const quantity = vInt(cart.quantity, "quantity", { min: 1, max: 999 });
    lines.push({
      cart_id: cart.id,
      sku_id: sku.id,
      product_id: product.id,
      category_id: product.category_id,
      price_base: money(sku.price_base),
      quantity,
      subtotal_base: money(sku.price_base) * quantity,
    });
  }
  return lines;
}

// —— CP1 GET /app/coupon/my ——
export async function couponMy(supabase, principal, query) {
  const { offset, limit } = pageParams(query);
  const status = query.status
    ? vEnum(query.status, "status", COUPON_STATUS)
    : null;
  let q = supabase.from("user_coupons").select(COUPON_COLS)
    .eq("user_id", principal.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  await lazyExpireCoupons(supabase, rows);
  const templates = await templateMap(supabase, rows.map((r) => r.template_id));
  const counts = {};
  await Promise.all(COUPON_STATUS.map(async (st) => {
    counts[st] = await countRows(supabase.from("user_coupons")
      .select("id", { count: "exact" }).eq("user_id", principal.id).eq("status", st));
  }));
  return ok({
    ...pageResult(rows.map((r) => couponView(r, templates.get(r.template_id))), offset, limit),
    counts_by_status: counts,
  });
}

// —— CP2 GET /app/coupon/available-for-cart?cart_ids=a,b,c ——
export async function couponAvailableForCart(supabase, principal, query) {
  const raw = Array.isArray(query.cart_ids)
    ? query.cart_ids
    : String(query.cart_ids ?? "").split(",");
  const cartIds = [...new Set(raw.map((id) => String(id).trim()).filter(Boolean).map((id) => vUuid(id, "cart_ids")))];
  if (!cartIds.length || cartIds.length > 50) {
    throw new AppError(400, "invalid_request", "cart_ids 需为 1–50 条（逗号分隔）", { field: "cart_ids" });
  }
  const lines = await cartLinesForPricing(supabase, principal.id, cartIds);
  // 方案 §8 算价顺序：原价 → VIP 折扣 → 券。叠加关闭时选券即放弃 VIP 折扣，故按原价判定券。
  const { config } = await getMergedConfig(supabase);
  const stack = config.switches?.vip_coupon_stack !== false;
  const vip = await activeVip(supabase, principal.id);
  const vipCut = vip ? vipDiscountOfLines(lines, vip.discount_rate) : { lines, discount_base: 0 };
  // 关闭叠加时券按原价判定门槛；vip 仍回传权益折行，供结算页在「未选券」时照常展示
  const pricedLines = stack ? vipCut.lines : lines;
  const goodsBase = lines.reduce((sum, l) => sum + l.subtotal_base, 0);

  const { data: coupons, error } = await supabase.from("user_coupons")
    .select(COUPON_COLS).eq("user_id", principal.id).eq("status", "UNUSED")
    .gt("expire_at", nowIso()).order("expire_at", { ascending: true }).limit(MAX_SCAN);
  if (error) throw new AppError(500, "internal_error");
  const templates = await templateMap(supabase, (coupons ?? []).map((c) => c.template_id));

  const options = [];
  for (const coupon of coupons ?? []) {
    const template = templates.get(coupon.template_id);
    if (!template || template.status !== "on" || !windowOpen(template)) continue;
    const { eligible_base: eligibleBase, deduction_base: deduction, reason } = couponDeduction(template, pricedLines);
    options.push({
      ...couponView(coupon, template),
      usable: reason === null,
      eligible_amount_base: eligibleBase,
      deduction_amount_base: deduction,
      reason,
    });
  }
  options.sort((a, b) => (b.usable - a.usable) || (b.deduction_amount_base - a.deduction_amount_base));
  return ok({
    cart_ids: cartIds,
    line_count: lines.length,
    goods_amount_base: goodsBase,
    // 会员权益按原价折行展示；是否与本单所选券同时生效看 vip_coupon_stack（与 O1 的 useVip 同口径）
    vip: vip ? { ...vip, discount_amount_base: vipCut.discount_base, after_base: goodsBase - vipCut.discount_base } : null,
    vip_coupon_stack: stack,
    options,
  });
}

// —— 领券中心视图（claimable 模板 + 剩余库存 + 我的持有 + 可否再领）——
function templateCenterView(t) {
  return {
    template_id: t.id,
    name: t.name,
    name_i18n: t.name_i18n ?? {},
    coupon_type: t.coupon_type,
    threshold_amount_base: money(t.threshold_amount_base),
    discount_amount_base: money(t.discount_amount_base),
    scope: t.scope,
    scope_ids: Array.isArray(t.scope_ids) ? t.scope_ids : [],
    valid_days: money(t.valid_days),
    valid_from: t.valid_from ?? null,
    valid_until: t.valid_until ?? null,
    unlimited: Boolean(t.unlimited),
    total_quota: t.unlimited ? null : money(t.total_quota),
    per_user_limit: money(t.per_user_limit),
    issued_count: money(t.issued_count),
  };
}

// —— CP3 GET /app/coupon/center（登录用户可见的可领券列表）——
export async function couponCenter(supabase, principal) {
  const nowMs = Date.now();
  const { data, error } = await supabase.from("coupon_templates").select(TEMPLATE_COLS)
    .is("deleted_at", null).eq("status", "on").eq("claimable", true)
    .order("created_at", { ascending: false }).limit(MAX_SCAN);
  if (error) throw new AppError(500, "internal_error");
  const rows = (data ?? []).filter((t) => windowOpen(t, nowMs));
  const items = [];
  for (const t of rows) {
    const held = principal?.id ? await heldByUser(supabase, t.id, principal.id) : 0;
    const quotaLeft = t.unlimited ? null : money(t.total_quota) - money(t.issued_count);
    const limitLeft = money(t.per_user_limit) - held;
    items.push({
      ...templateCenterView(t),
      my_held: held,
      remaining_quota: quotaLeft === null ? null : Math.max(quotaLeft, 0),
      can_claim: limitLeft > 0 && (quotaLeft === null || quotaLeft > 0),
      sold_out: quotaLeft !== null && quotaLeft <= 0,
    });
  }
  return ok({ items });
}

// —— CP4 POST /app/coupon/claim（自助领取；限领 → 库存 CAS → idem 兜底）——
export async function couponClaim(supabase, principal, body) {
  const templateId = vUuid(body.template_id, "template_id");
  const template = await loadTemplate(supabase, templateId);
  if (!template || template.status !== "on" || template.claimable !== true) {
    throw new AppError(410, "coupon_unavailable", "该优惠券不支持自助领取", { template_id: templateId });
  }
  if (!windowOpen(template)) {
    throw new AppError(410, "coupon_unavailable", "优惠券不在领取时间窗口内", { template_id: templateId });
  }
  // seq 取当前持有条数：每次自助领取用独立 idem_key，重复/并发领取自然去重
  const seq = await heldByUser(supabase, templateId, principal.id);
  const res = await grantCoupon(supabase, { templateId, userId: principal.id, seq, source: "activity" });
  if (!res.granted && !res.duplicated) {
    if (res.reason === "quota_reached") {
      throw new AppError(410, "quota_reached", "优惠券已领完或已达个人领取上限", { template_id: templateId });
    }
    throw new AppError(res.reason === "claim_conflict" ? 409 : 410,
      res.reason === "claim_conflict" ? "claim_conflict" : "coupon_unavailable", "领取失败，请稍后重试", { template_id: templateId });
  }
  return ok({ granted: Boolean(res.granted), duplicated: Boolean(res.duplicated), coupon_id: res.coupon_id ?? null });
}

// —— O1 锁券（UNUSED→LOCKED；失败由调用方按 reason 分流）——
export async function lockCoupon(supabase, { couponId, userId, orderId }) {
  const { data } = await supabase.from("user_coupons")
    .select(COUPON_COLS).eq("id", couponId).maybeSingle();
  if (!data || data.user_id !== userId) throw new AppError(404, "not_found", "优惠券不存在");
  if (data.status === "LOCKED") {
    return data.order_id === orderId
      ? { coupon: data, already: true }
      : { conflict: "locked_other" };
  }
  if (data.status !== "UNUSED") return { conflict: data.status.toLowerCase() };
  if (Date.parse(data.expire_at) <= Date.now()) {
    await supabase.from("user_coupons")
      .update({ status: "EXPIRED", updated_at: nowIso() })
      .eq("id", data.id).eq("status", "UNUSED");
    return { conflict: "expired" };
  }
  const { data: cas } = await supabase.from("user_coupons")
    .update({ status: "LOCKED", order_id: orderId, updated_at: nowIso() })
    .eq("id", data.id).eq("status", "UNUSED").select(COUPON_COLS);
  if (!cas?.length) return { conflict: "conflict" };
  return { coupon: cas[0] };
}

// —— 退券（LOCKED→UNUSED，重校验有效期；文档B §4）——
export async function releaseCoupon(supabase, { couponId, orderId }) {
  const { data: current } = await supabase.from("user_coupons")
    .select(COUPON_COLS).eq("id", couponId).eq("order_id", orderId).maybeSingle();
  if (!current) return { released: false, reason: "not_bound" };
  if (current.status === "UNUSED") return { released: true, reason: "already" };
  if (current.status !== "LOCKED") return { released: false, reason: current.status.toLowerCase() };
  const expired = Date.parse(current.expire_at) <= Date.now();
  const to = expired ? "EXPIRED" : "UNUSED";
  const { data: cas } = await supabase.from("user_coupons")
    .update({ status: to, order_id: null, updated_at: nowIso() })
    .eq("id", current.id).eq("status", "LOCKED").select("id");
  if (!cas?.length) return { released: false, reason: "conflict" };
  return { released: true, to };
}

// —— Y1 券 USED（LOCKED→USED，order_id 绑定幂等；文档B §4）——
export async function markCouponUsed(supabase, { couponId, orderId }) {
  const { data: cas } = await supabase.from("user_coupons")
    .update({ status: "USED", order_id: orderId, updated_at: nowIso() })
    .eq("id", couponId).eq("order_id", orderId).eq("status", "LOCKED").select("id");
  if (cas?.length) return { used: true };
  const { data: existing } = await supabase.from("user_coupons")
    .select("id,status").eq("id", couponId).eq("order_id", orderId).maybeSingle();
  if (existing?.status === "USED") return { used: true, reason: "already" };
  return { used: false, reason: existing ? existing.status.toLowerCase() : "not_bound" };
}

// —— 下单前校验：券属主 + 未过期 + 门槛/范围匹配 → 抵扣额 ——
export async function priceCouponForOrder(supabase, { couponId, userId, lines }) {
  const id = vUuid(couponId, "coupon_id");
  const { data: coupon } = await supabase.from("user_coupons")
    .select(COUPON_COLS).eq("id", id).maybeSingle();
  if (!coupon || coupon.user_id !== userId) throw new AppError(410, "coupon_unavailable", "优惠券不可用");
  if (coupon.status !== "UNUSED" || Date.parse(coupon.expire_at) <= Date.now()) {
    throw new AppError(410, "coupon_unavailable", "优惠券不可用", { status: coupon.status });
  }
  const template = await loadTemplate(supabase, coupon.template_id);
  if (!template || template.status !== "on" || !windowOpen(template)) {
    throw new AppError(410, "coupon_unavailable", "券模板已停止发放或已过期");
  }
  const calc = couponDeduction(template, lines);
  if (calc.reason) {
    throw new AppError(409, "coupon_unavailable", "优惠券不满足使用条件", {
      coupon_id: coupon.id,
      reason: calc.reason,
      threshold_amount_base: money(template.threshold_amount_base),
      eligible_amount_base: calc.eligible_base,
    });
  }
  return { coupon, template, deduction: calc.deduction_base, eligible: calc.eligible_base };
}

// —— CY1 模板草稿校验 ——
function validateTemplateDraft(body, { issued = 0 } = {}) {
  const name = vStr(body.name, "name", { min: 1, max: 60 });
  // 券名译文：与 products/vip_plans 同口径，缺省落 {} 绝不落 null（#194 的教训）
  const nameI18n = vI18nMap(body.name_i18n, "name_i18n", 60);
  const couponType = vEnum(body.coupon_type, "coupon_type", COUPON_TYPES);
  const discount = vInt(body.discount_amount_base, "discount_amount_base", { min: 1, max: 1000000000 });
  const threshold = couponType === "direct"
    ? 0
    : vInt(body.threshold_amount_base ?? 1, "threshold_amount_base", { min: 1, max: 1000000000 });
  const scope = vEnum(body.scope, "scope", COUPON_SCOPES);
  const rawIds = body.scope_ids ?? [];
  if (!Array.isArray(rawIds) || rawIds.length > 50) {
    throw new AppError(400, "invalid_request", "scope_ids 需为不超过 50 条的数组", { field: "scope_ids" });
  }
  const scopeIds = scope === "all" ? [] : [...new Set(rawIds.map((id) => vUuid(id, "scope_ids")))];
  if (scope !== "all" && !scopeIds.length) {
    throw new AppError(400, "invalid_request", "该适用范围必须选择至少一个对象", { field: "scope_ids" });
  }
  const validDays = vInt(body.valid_days ?? 0, "valid_days", { min: 0, max: 3650 });
  const validFrom = vTime(body.valid_from, "valid_from", { optional: true });
  const validUntil = vTime(body.valid_until, "valid_until", { optional: true });
  if (validDays > 0) {
    if (validFrom || validUntil) {
      throw new AppError(400, "invalid_request", "相对有效期与绝对窗口二选一", { field: "valid_days" });
    }
  } else {
    if (!validFrom || !validUntil) throw new AppError(400, "invalid_request", "缺少绝对有效期窗口");
    if (Date.parse(validUntil) <= Date.parse(validFrom)) {
      throw new AppError(400, "invalid_request", "有效期终点必须晚于起点");
    }
  }
  const unlimited = vBool(body.unlimited ?? false, "unlimited");
  const totalQuota = unlimited ? null : vInt(body.total_quota ?? 1, "total_quota", { min: 1, max: 1000000000 });
  if (!unlimited && money(totalQuota) < issued) {
    throw new AppError(409, "state_conflict", "发放总量不得小于已发放数量", { issued_count: issued });
  }
  const perUserLimit = vInt(body.per_user_limit ?? 1, "per_user_limit", { min: 1, max: 999 });
  const claimable = vBool(body.claimable ?? false, "claimable");
  return {
    name,
    name_i18n: nameI18n,
    coupon_type: couponType,
    threshold_amount_base: threshold,
    discount_amount_base: discount,
    scope,
    scope_ids: scopeIds,
    valid_days: validDays,
    valid_from: validFrom,
    valid_until: validUntil,
    total_quota: totalQuota,
    unlimited,
    per_user_limit: perUserLimit,
    claimable,
  };
}

// —— CY1a 模板保存（新建/编辑，perm coupon.manage）——
export async function adminCouponTemplateSave(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coupon.manage");
  const templateId = body.template_id ? vUuid(body.template_id, "template_id") : null;
  let issued = 0;
  let current = null;
  if (templateId) {
    current = await loadTemplate(supabase, templateId);
    if (!current) throw new AppError(404, "not_found", "券模板不存在");
    issued = money(current.issued_count);
  }
  const draft = validateTemplateDraft(body, { issued });
  const now = nowIso();
  if (current) {
    const { error } = await supabase.from("coupon_templates").update({ ...draft, updated_at: now }).eq("id", current.id);
    if (error) throw new AppError(500, "internal_error");
    await writeAudit(supabase, {
      adminId: actor.id, action: "coupon.template_save", targetType: "coupon_template", targetId: current.id,
      detail: { name: draft.name, mode: "update" },
    });
    return { template_id: current.id, updated: true };
  }
  const id = crypto.randomUUID();
  const { error } = await supabase.from("coupon_templates").insert({
    id, ...draft, issued_count: 0, status: "off", created_at: now, updated_at: now,
  });
  if (error) throw new AppError(500, "internal_error");
  await writeAudit(supabase, {
    adminId: actor.id, action: "coupon.template_save", targetType: "coupon_template", targetId: id,
    detail: { name: draft.name, mode: "create" },
  });
  return { template_id: id, updated: false };
}

// —— CY1b 模板上下架/归档（perm coupon.manage）——
export async function adminCouponTemplateStatus(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coupon.manage");
  const id = vUuid(body.template_id, "template_id");
  const to = vEnum(body.status, "status", TEMPLATE_STATUS);
  const current = await loadTemplate(supabase, id);
  if (!current) throw new AppError(404, "not_found", "券模板不存在");
  const from = current.status;
  if (from === to) return { template_id: id, status: to, changed: false };
  if (!NEXT_TEMPLATE_STATUS[from].includes(to)) {
    throw new AppError(409, "state_conflict", "券模板状态不可这样流转", { from, to });
  }
  const { data: cas } = await supabase.from("coupon_templates")
    .update({ status: to, updated_at: nowIso() })
    .eq("id", id).eq("status", from).select("id");
  if (!cas?.length) throw new AppError(409, "claim_conflict", "券模板状态已变化，请刷新后重试");
  await writeAudit(supabase, {
    adminId: actor.id, action: "coupon.template_status", targetType: "coupon_template", targetId: id,
    detail: { name: current.name, from, to },
  });
  return { template_id: id, status: to, changed: true };
}

// —— CY1b2 模板删除（软删；券实例保留，顾客侧按语言显示「券已下架」且不可再用）——
export async function adminCouponTemplateDelete(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coupon.manage");
  const id = vUuid(body.template_id, "template_id");
  const current = await loadTemplate(supabase, id);
  if (!current) throw new AppError(404, "not_found", "券模板不存在");
  // 在营模板必须先下架，避免把正在领/正在用的活动券一键抹掉
  if (current.status === "on") throw new AppError(409, "state_conflict", "请先下架再删除");
  const now = nowIso();
  const { data: cas } = await supabase.from("coupon_templates")
    .update({ deleted_at: now, status: "archived", updated_at: now })
    .eq("id", id).eq("status", current.status).select("id");
  if (!cas?.length) throw new AppError(409, "claim_conflict", "券模板状态已变化，请刷新后重试");
  await writeAudit(supabase, {
    adminId: actor.id, action: "coupon.template_delete", targetType: "coupon_template", targetId: id,
    detail: { name: current.name, status: current.status },
  });
  return ok({ template_id: id, deleted: true });
}

// —— CY1c 模板列表（perm coupon.manage）——
export async function adminCouponTemplates(supabase, request, query) {
  await adminGuard(supabase, request, "coupon.manage");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("coupon_templates").select(TEMPLATE_COLS).is("deleted_at", null)
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  const status = vEnum(query.status, "status", TEMPLATE_STATUS, { optional: true });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const total = await countRows(supabase.from("coupon_templates")
    .select("id", { count: "exact" }).is("deleted_at", null));
  return ok({
    total,
    ...pageResult(rows.map((t) => ({
      ...t,
      threshold_amount_base: money(t.threshold_amount_base),
      discount_amount_base: money(t.discount_amount_base),
      issued_count: money(t.issued_count),
      total_quota: t.unlimited ? null : money(t.total_quota),
      scope_ids: Array.isArray(t.scope_ids) ? t.scope_ids : [],
    })), offset, limit),
  });
}

// —— 券实例查询（perm coupon.manage；运营核对与批量发放结果）——
export async function adminCoupons(supabase, request, query) {
  await adminGuard(supabase, request, "coupon.manage");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("user_coupons").select(COUPON_COLS)
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  if (query.template_id) q = q.eq("template_id", vUuid(query.template_id, "template_id"));
  if (query.user_id) q = q.eq("user_id", vUuid(query.user_id, "user_id"));
  const status = vEnum(query.status, "status", COUPON_STATUS, { optional: true });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  await lazyExpireCoupons(supabase, rows);
  const templates = await templateMap(supabase, rows.map((r) => r.template_id));
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: users } = userIds.length
    ? await supabase.from("users").select("id,username,nickname").in("id", userIds)
    : { data: [] };
  const userMap = new Map((users ?? []).map((u) => [u.id, u]));
  return ok(pageResult(rows.map((r) => ({
    ...couponView(r, templates.get(r.template_id)),
    user_id: r.user_id,
    username: userMap.get(r.user_id)?.username ?? "—",
    nickname: userMap.get(r.user_id)?.nickname ?? "",
  })), offset, limit));
}

async function activeUserIds(supabase, ids) {
  const { data } = await supabase.from("users")
    .select("id,username,status").in("id", ids).is("deleted_at", null);
  return new Map((data ?? []).map((u) => [u.id, u]));
}

// —— AU4 单用户发券（⚠ perm coupon.grant，idem_key=grant:{tid}:{uid}:{seq}）——
export async function adminUserCouponGrant(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coupon.grant");
  const templateId = vUuid(body.template_id, "template_id");
  const userId = vUuid(body.user_id, "user_id");
  const seq = vInt(body.seq ?? 0, "seq", { min: 0, max: 999 });
  const userMap = await activeUserIds(supabase, [userId]);
  if (!userMap.has(userId)) throw new AppError(404, "not_found", "用户不存在");
  const res = await grantCoupon(supabase, { templateId, userId, seq, source: "admin" });
  if (!res.granted && !res.duplicated) {
    const status = res.reason === "quota_reached" ? 410 : res.reason === "coupon_unavailable" ? 410 : 409;
    throw new AppError(status, res.reason === "claim_conflict" ? "claim_conflict" : res.reason,
      res.reason === "quota_reached" ? "已达发放上限" : "优惠券当前不可发放", { template_id: templateId, user_id: userId });
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "coupon.grant", targetType: "coupon_template", targetId: templateId,
    detail: { user_id: userId, seq, duplicated: Boolean(res.duplicated) },
  });
  return { granted: Boolean(res.granted), duplicated: Boolean(res.duplicated), coupon_id: res.coupon_id ?? null };
}

// —— CY2 批量发券（⚠ perm coupon.grant；逐用户独立幂等，失败个体不影响整批）——
export async function adminCouponBatchGrant(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coupon.grant");
  const templateId = vUuid(body.template_id, "template_id");
  if (!Array.isArray(body.user_ids) || !body.user_ids.length || body.user_ids.length > 50) {
    throw new AppError(400, "invalid_request", "user_ids 需为 1–50 条", { field: "user_ids" });
  }
  const userIds = [...new Set(body.user_ids.map((id) => vUuid(id, "user_id")))];
  const seq = vInt(body.seq ?? 0, "seq", { min: 0, max: 999 });
  const userMap = await activeUserIds(supabase, userIds);
  const results = [];
  for (const userId of userIds) {
    if (!userMap.has(userId)) {
      results.push({ user_id: userId, granted: false, reason: "not_found" });
      continue;
    }
    try {
      const res = await grantCoupon(supabase, { templateId, userId, seq, source: "admin" });
      results.push({
        user_id: userId,
        granted: res.granted,
        duplicated: Boolean(res.duplicated),
        coupon_id: res.coupon_id ?? null,
        ...(!res.granted && !res.duplicated ? { reason: res.reason } : {}),
      });
    } catch {
      results.push({ user_id: userId, granted: false, reason: "internal_error" });
    }
  }
  const granted = results.filter((r) => r.granted).length;
  await writeAudit(supabase, {
    adminId: actor.id, action: "coupon.batch_grant", targetType: "coupon_template", targetId: templateId,
    detail: { seq, requested: results.length, granted },
  });
  return {
    template_id: templateId,
    requested: results.length,
    granted,
    results,
  };
}

// —— AU1 附带：用户券计数（UNUSED 张数）——
export async function unusedCouponCounts(supabase, userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const { data } = await supabase.from("user_coupons")
    .select("user_id").in("user_id", userIds).eq("status", "UNUSED").gt("expire_at", nowIso()).limit(2000);
  for (const row of data ?? []) map.set(row.user_id, (map.get(row.user_id) ?? 0) + 1);
  return map;
}

// —— T4 券过期扫描（tasks tick 调用）——
export async function taskExpireCoupons(supabase, nowIsoStr = nowIso()) {
  const { data: rows } = await supabase.from("user_coupons")
    .select(COUPON_COLS).eq("status", "UNUSED").lte("expire_at", nowIsoStr)
    .order("expire_at", { ascending: true }).limit(50);
  return lazyExpireCoupons(supabase, rows);
}

export { loadTemplate as couponTemplateOf };
