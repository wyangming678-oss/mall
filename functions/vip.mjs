// VIP 会员（文档A §25/§26、文档B §8、方案 §10；文档C V1/V2/VP1/VP2 + 文档B §12 T6 + 文档C HB2）
// 核心不变式：权益在开通那一刻整体复制进 user_vips（tier_key/discount_rate/成交价/benefits），
// 算价只读快照不回查套餐——套餐后台怎么改都不回溯影响已售权益（方案 §10）。
import { AppError, isUniqueViolation } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { getCurrencies, getCurrencyOrBase } from "./config.mjs";
import { coinSnapshot, enabledChannel, firstEnabledChannel, pricedChains, toDisplayAmount } from "./channels.mjs";
import { changeBalance, vAmount } from "./wallet.mjs";
import { emit } from "./notify.mjs";
import { nowIso, pageParams, pageResult, vBool, vEnum, vInt, vJson, vStr, vUuid } from "./validate.mjs";

export const PLAN_STATUS = ["on", "off"];
export const VIP_STATUS = ["active", "expired", "refunded"];
export const VIP_PAY_METHODS = ["BALANCE", "QR"];

const DAY_MS = 86400 * 1000;
const RATE_FULL = 10000; // 万分比：9500 = 95 折
const SCAN_LIMIT = 50;
const PLAN_COLS = "id,tier_key,discount_rate,name,name_i18n,duration_days,price_base,currency_prices,benefits,status,sort_order,created_at,updated_at";
const VIP_COLS = "id,user_id,plan_id,tier_key,discount_rate,start_at,expire_at,purchase_price_base,benefits_snapshot,payment_id,status,created_at";

const iso = (ms) => new Date(ms).toISOString();
const money = (v) => Number(v ?? 0);

// —— 权益快照视图（算价与前台展示都只吃这个形状）——
function vipView(row) {
  return {
    vip_id: row.id,
    user_id: row.user_id,
    plan_id: row.plan_id,
    tier_key: row.tier_key,
    discount_rate: money(row.discount_rate),
    start_at: row.start_at,
    expire_at: row.expire_at,
    purchase_price_base: money(row.purchase_price_base),
    benefits_snapshot: row.benefits_snapshot ?? [],
    payment_id: row.payment_id ?? null,
    status: row.status,
  };
}

function planView(plan) {
  return {
    plan_id: plan.id,
    tier_key: plan.tier_key,
    name: plan.name,
    name_i18n: plan.name_i18n ?? {},
    discount_rate: money(plan.discount_rate),
    duration_days: money(plan.duration_days),
    price_base: money(plan.price_base),
    currency_prices: plan.currency_prices ?? {},
    benefits: plan.benefits ?? [],
    status: plan.status,
    sort_order: money(plan.sort_order),
  };
}

// currency_prices 只影响展示换算（与 product_skus 同口径），成交价一律取 price_base
function displayPrices(plan, currencies) {
  const out = {};
  for (const c of currencies) {
    const override = money(plan.currency_prices?.[c.code]);
    out[c.code] = override > 0 ? override : toDisplayAmount(money(plan.price_base), money(c.rate_scaled));
  }
  return out;
}

async function loadPlan(supabase, planId, { requireOn = false } = {}) {
  const { data: plan } = await supabase.from("vip_plans").select(PLAN_COLS)
    .eq("id", planId).is("deleted_at", null).maybeSingle();
  if (!plan) throw new AppError(404, "not_found", "套餐不存在");
  // 前台自助购买只认 on 套餐；后台代开不受下架影响（下架关住的是售卖入口）
  if (requireOn && plan.status !== "on") throw new AppError(410, "vip_plan_offline", "该会员套餐已下架");
  return plan;
}

// —— V1 套餐列表（on + 各币种展示价）——
export async function vipPlans(supabase) {
  const { data, error } = await supabase.from("vip_plans").select(PLAN_COLS)
    .eq("status", "on").is("deleted_at", null).order("sort_order", { ascending: true }).limit(50);
  if (error) throw new AppError(500, "internal_error");
  const currencies = await getCurrencies(supabase);
  return {
    items: (data ?? []).map((p) => {
      const view = planView(p);
      return { ...view, prices: displayPrices(p, currencies) };
    }),
  };
}

// —— 当前有效权益（HB2：读到过期行就按 T6 同条件认领降级，保证展示态与折扣一致）——
export async function activeVip(supabase, userId, { nowMs = Date.now() } = {}) {
  const { data } = await supabase.from("user_vips").select(VIP_COLS)
    .eq("user_id", userId).eq("status", "active")
    .order("expire_at", { ascending: false }).limit(1);
  const top = data?.[0] ?? null;
  if (!top) return null;
  if (Date.parse(top.expire_at) > nowMs) return vipView(top);
  await expireVips(supabase, { nowMs, userId });
  return null;
}

// —— 到期降级：status 条件更新（0 行=已被他人处理），每次成功翻转写一条到期消息 ——
async function expireVips(supabase, { nowMs, userId = null, limit = SCAN_LIMIT }) {
  const nowStr = iso(nowMs);
  let q = supabase.from("user_vips").select("id,user_id,tier_key,expire_at")
    .eq("status", "active").lte("expire_at", nowStr)
    .order("expire_at", { ascending: true }).limit(limit);
  if (userId) q = q.eq("user_id", userId);
  const { data: rows } = await q;
  let expired = 0;
  for (const row of rows ?? []) {
    const { data: hit } = await supabase.from("user_vips")
      .update({ status: "expired" }).eq("id", row.id).eq("status", "active").select("id");
    if (!hit?.length) continue;
    expired += 1;
    await emit(supabase, {
      userId: row.user_id, msgType: "vip_expired", title: "会员已到期",
      content: `你的 ${row.tier_key} 会员权益已于 ${row.expire_at.slice(0, 10)} 到期，此后下单不再享受会员折扣`,
      refType: "user_vip", refId: row.id,
    });
  }
  return expired;
}

// —— T6 ——
export async function taskExpireVips(supabase, nowMs = Date.now()) {
  return expireVips(supabase, { nowMs });
}

// —— 续费叠加：从当前未过期权益的末尾起算，否则从此刻起算 ——
async function grantVip(supabase, {
  userId, plan, priceBase, paymentId = null, durationDays = null, nowMs = Date.now(),
}) {
  const days = durationDays ?? money(plan.duration_days);
  const { data: live } = await supabase.from("user_vips").select("id,expire_at")
    .eq("user_id", userId).eq("status", "active").gt("expire_at", iso(nowMs))
    .order("expire_at", { ascending: false }).limit(1);
  const startMs = live?.[0] ? Date.parse(live[0].expire_at) : nowMs;
  const id = crypto.randomUUID();
  const row = {
    id,
    user_id: userId,
    plan_id: plan.id,
    tier_key: plan.tier_key,
    discount_rate: money(plan.discount_rate),
    start_at: iso(startMs),
    expire_at: iso(startMs + days * DAY_MS),
    purchase_price_base: priceBase,
    benefits_snapshot: plan.benefits ?? [],
    payment_id: paymentId,
    status: "active",
    created_at: iso(nowMs),
  };
  const { error } = await supabase.from("user_vips").insert(row);
  if (error) return { ok: false, reason: isUniqueViolation(error) ? "duplicated" : "insert_failed" };
  return { ok: true, granted: vipView(row) };
}

// —— PF3 过审分支：VIP_PURCHASE 分项 CONFIRMED → 写快照开通（同分项重复过审幂等复用）——
export async function grantVipFromPayment(supabase, payment) {
  const { data: existing } = await supabase.from("user_vips").select(VIP_COLS)
    .eq("payment_id", payment.id).maybeSingle();
  if (existing) return { ok: true, granted: vipView(existing), replayed: true };
  // 套餐事后下架/改价都不影响这笔已收款的权益，只有行真的没了才失败
  const { data: plan } = await supabase.from("vip_plans").select(PLAN_COLS)
    .eq("id", payment.target_id).maybeSingle();
  if (!plan) return { ok: false, reason: "plan_missing" };
  return grantVip(supabase, {
    userId: payment.user_id, plan, priceBase: money(payment.amount_base), paymentId: payment.id,
  });
}

// —— 金币兑换权益（文档P §3 / D18）：金币把「会员时长」当兑换项卖，零现金、无 payment_id ——
// 返回原始套餐行而非 planView：grantVip 吃的是列原名（id/tier_key/discount_rate/benefits/duration_days）。
export async function vipPlanRowById(supabase, planId) {
  const { data: plan } = await supabase.from("vip_plans").select(PLAN_COLS)
    .eq("id", planId).is("deleted_at", null).maybeSingle();
  return plan ?? null;
}

// 售卖闸在金币侧（coin_items.status + switches.coins），故套餐自身 off **不**拦兑换：下架关的是 /vip 购买入口
// （loadPlan requireOn），历史已售权益与金币兑换都照旧。时长由兑换项覆盖（三档同一套餐、只差天数），
// 续费叠加/权益快照口径与 PF3 完全一致（同一 grantVip，priceBase=0、paymentId=null）。
export async function grantVipForCoin(supabase, { userId, plan, durationDays }) {
  return grantVip(supabase, { userId, plan, priceBase: 0, paymentId: null, durationDays });
}

// —— V2 购买：BALANCE 即时开通 / QR 建 VIP_PURCHASE 分项后复用 Y4 凭证链 ——
export async function vipPurchase(supabase, principal, body) {
  const planId = vUuid(body.plan_id, "plan_id");
  const payMethod = vEnum(body.pay_method, "pay_method", VIP_PAY_METHODS);
  const plan = await loadPlan(supabase, planId, { requireOn: true });
  const { data: user } = await supabase.from("users")
    .select("id,balance,currency_code").eq("id", principal.id).is("deleted_at", null).maybeSingle();
  if (!user) throw new AppError(404, "not_found");
  // 账号币种可能已被后台下架：按站点本位币回落，成交仍一律取 price_base，币种只影响展示换算
  const currency = await getCurrencyOrBase(supabase, user.currency_code);
  const priceBase = money(plan.price_base);
  const amountCurrency = toDisplayAmount(priceBase, money(currency.rate_scaled));
  const paymentId = crypto.randomUUID();
  const now = nowIso();

  if (payMethod === "BALANCE") {
    const debit = await changeBalance(supabase, {
      userId: principal.id, amount: -priceBase, txnType: "vip_purchase",
      refType: "vip_plan", refId: plan.id, idemKey: `vip:${paymentId}`, remark: `开通会员 ${plan.name}`,
    });
    if (!debit.ok) {
      if (debit.reason === "insufficient") {
        throw new AppError(409, "insufficient_balance", "余额不足", { balance: debit.before ?? 0, required: priceBase });
      }
      if (debit.reason === "duplicated") throw new AppError(409, "state_conflict", "该笔扣款已入账，请刷新会员页", null);
      if (debit.reason === "conflict") throw new AppError(409, "claim_conflict", "余额正在变动，请重试", null);
      if (debit.reason === "not_found") throw new AppError(404, "not_found");
      throw new AppError(500, "internal_error");
    }
    const rollback = async (reason) => {
      await changeBalance(supabase, {
        userId: principal.id, amount: priceBase, txnType: "refund_in",
        refType: "vip_plan", refId: plan.id, idemKey: `vip:${paymentId}:rollback`, remark: reason,
      });
      throw new AppError(500, "internal_error");
    };
    const { error: payErr } = await supabase.from("payments").insert({
      id: paymentId, payment_type: "VIP_PURCHASE", target_type: "vip_plan", target_id: plan.id,
      user_id: principal.id, method: "BALANCE", amount_base: priceBase, amount_currency: amountCurrency,
      currency_code: currency.code, status: "CONFIRMED", reviewed_at: now, created_at: now, updated_at: now,
    });
    if (payErr) await rollback("会员支付分项写入失败冲正");
    const res = await grantVip(supabase, { userId: principal.id, plan, priceBase, paymentId });
    if (!res.ok) {
      await supabase.from("payments").update({ status: "EXPIRED", reject_reason: "会员开通落库失败", updated_at: nowIso() })
        .eq("id", paymentId).eq("status", "CONFIRMED");
      await rollback("会员开通落库失败冲正");
    }
    return {
      pay_method: "BALANCE", plan_id: plan.id, payment_id: paymentId,
      amount_base: priceBase, amount_currency: amountCurrency, currency_code: currency.code,
      balance_after: debit.after, vip: res.granted,
    };
  }

  const channel = body.channel
    ? await enabledChannel(supabase, vStr(body.channel, "channel", { min: 1, max: 32, pattern: /^[A-Z][A-Z0-9_]{1,31}$/ }), "manual")
    : await firstEnabledChannel(supabase, "manual");
  const chains = await pricedChains(channel, priceBase);
  const coin = coinSnapshot(chains, vInt(body.chain_index, "chain_index", { min: 0, max: 7, optional: true }));
  const { error } = await supabase.from("payments").insert({
    id: paymentId, payment_type: "VIP_PURCHASE", target_type: "vip_plan", target_id: plan.id,
    user_id: principal.id, method: channel.method, amount_base: priceBase, amount_currency: amountCurrency,
    currency_code: currency.code, status: "PENDING_SUBMIT",
    coin_symbol: coin?.symbol ?? null, coin_network: coin?.network ?? null, coin_units: coin?.units ?? null, coin_decimals: coin?.decimals ?? null,
    created_at: now, updated_at: now,
  });
  if (error) throw new AppError(500, "internal_error");
  return {
    pay_method: "QR", plan_id: plan.id, payment_id: paymentId,
    amount_base: priceBase, amount_currency: amountCurrency, currency_code: currency.code,
    channel: { method: channel.method, image_url: channel.image_url, holder_name: channel.holder_name, account_no: channel.account_no, pay_link: channel.pay_link, account_note: channel.account_note, account_note_i18n: channel.account_note_i18n, chains },
    transfer_reference: `VIP${paymentId.slice(0, 8).toUpperCase()}`,
    vip: null,
  };
}

// —— VP1 套餐维护（文档C §六.6 vip.manage；增删改只影响后续新开通）——
function planDraft(body) {
  return {
    tier_key: vStr(body.tier_key, "tier_key", { min: 2, max: 30, pattern: /^[a-z][a-z0-9_-]{1,29}$/ }),
    // 万分比折扣，10000 等于不打折故排除在套餐之外
    discount_rate: vInt(body.discount_rate, "discount_rate", { min: 1, max: RATE_FULL - 1 }),
    name: vStr(body.name, "name", { min: 1, max: 60 }),
    name_i18n: vJson(body.name_i18n ?? {}, "name_i18n"),
    duration_days: vInt(body.duration_days, "duration_days", { min: 1, max: 3650 }),
    price_base: vAmount(body.price_base, "price_base", { min: 1, max: 999999999 }),
    currency_prices: vJson(body.currency_prices ?? {}, "currency_prices"),
    benefits: vJson(body.benefits ?? [], "benefits"),
    status: vEnum(body.status ?? "on", "status", PLAN_STATUS),
    sort_order: vInt(body.sort_order ?? 0, "sort_order", { min: 0, max: 9999 }),
  };
}

export async function adminVipPlanSave(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "vip.manage");
  const id = body.plan_id ? vUuid(body.plan_id, "plan_id") : null;
  if (vBool(body.delete ?? false, "delete")) {
    if (!id) throw new AppError(400, "invalid_request", "删除套餐需要 plan_id", { field: "plan_id" });
    const doomed = await loadPlan(supabase, id);
    const { data: gone } = await supabase.from("vip_plans")
      .update({ deleted_at: nowIso(), updated_at: nowIso() }).eq("id", id).is("deleted_at", null).select("id");
    if (!gone?.length) throw new AppError(404, "not_found", "套餐不存在");
    await writeAudit(supabase, {
      adminId: actor.id, action: "vip_plan.delete", targetType: "vip_plan", targetId: id,
      detail: { tier_key: doomed.tier_key },
    });
    return { plan_id: id, deleted: true };
  }
  const values = planDraft(body);
  const now = nowIso();
  if (id) {
    const { data: updated, error } = await supabase.from("vip_plans").update({ ...values, updated_at: now })
      .eq("id", id).is("deleted_at", null).select("id");
    if (error) {
      if (isUniqueViolation(error)) throw new AppError(409, "state_conflict", "该等级键已存在", { tier_key: values.tier_key });
      throw new AppError(500, "internal_error");
    }
    if (!updated?.length) throw new AppError(404, "not_found", "套餐不存在");
    await writeAudit(supabase, {
      adminId: actor.id, action: "vip_plan.save", targetType: "vip_plan", targetId: id,
      detail: { tier_key: values.tier_key, discount_rate: values.discount_rate, status: values.status },
    });
    return { plan_id: id, updated: true };
  }
  const newId = crypto.randomUUID();
  const { error } = await supabase.from("vip_plans").insert({
    id: newId, ...values, created_at: now, updated_at: now, deleted_at: null,
  });
  if (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "state_conflict", "该等级键已存在", { tier_key: values.tier_key });
    throw new AppError(500, "internal_error");
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "vip_plan.save", targetType: "vip_plan", targetId: newId,
    detail: { tier_key: values.tier_key, discount_rate: values.discount_rate, status: values.status },
  });
  return { plan_id: newId, created: true };
}

// 后台套餐列表：含 off（前台 V1 只见 on）
export async function adminVipPlans(supabase, request) {
  await adminGuard(supabase, request, "vip.manage");
  const { data, error } = await supabase.from("vip_plans").select(PLAN_COLS)
    .is("deleted_at", null).order("sort_order", { ascending: true }).limit(50);
  if (error) throw new AppError(500, "internal_error");
  const currencies = await getCurrencies(supabase);
  return {
    items: (data ?? []).map((p) => {
      const view = planView(p);
      return { ...view, prices: displayPrices(p, currencies) };
    }),
  };
}

// —— VP2 后台代开 / 赠送（零扣款：成交价 0、payment_id 空，快照仍按当时套餐落库）——
export async function adminUserVipGrant(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "vip.manage");
  const userId = vUuid(body.user_id, "user_id");
  const reason = vStr(body.reason, "reason", { min: 2, max: 200 });
  const durationDays = body.duration_days == null
    ? null : vInt(body.duration_days, "duration_days", { min: 1, max: 3650 });
  const plan = await loadPlan(supabase, vUuid(body.plan_id, "plan_id"));
  const { data: user } = await supabase.from("users").select("id,username,nickname")
    .eq("id", userId).is("deleted_at", null).maybeSingle();
  if (!user) throw new AppError(404, "not_found", "用户不存在");
  const res = await grantVip(supabase, { userId, plan, priceBase: 0, durationDays });
  if (!res.ok) throw new AppError(500, "internal_error");
  await writeAudit(supabase, {
    adminId: actor.id, action: "vip.grant", targetType: "user_vip", targetId: res.granted.vip_id,
    detail: { user_id: userId, plan_id: plan.id, tier_key: plan.tier_key, duration_days: durationDays ?? plan.duration_days, reason },
  });
  return { granted: true, ...res.granted };
}

// 会员记录 / 到期名单（VIP管理页 §整体逻辑：手动开通延长 + 到期名单）
export async function adminUserVips(supabase, request, query) {
  await adminGuard(supabase, request, "vip.manage");
  const { offset, limit } = pageParams(query);
  const status = query.status ? vEnum(query.status, "status", VIP_STATUS) : null;
  const userId = query.user_id ? vUuid(query.user_id, "user_id") : null;
  let q = supabase.from("user_vips").select(VIP_COLS).order("expire_at", { ascending: false });
  if (status) q = q.eq("status", status);
  if (userId) q = q.eq("user_id", userId);
  // 多取一行判 has_more（文档C §〇.2），再补买家信息
  const { data, error } = await q.range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  const rows = (data ?? []).map(vipView);
  const buyerIds = [...new Set(rows.slice(0, limit).map((r) => r.user_id))];
  const { data: buyers } = buyerIds.length
    ? await supabase.from("users").select("id,username,nickname").in("id", buyerIds)
    : { data: [] };
  const map = new Map((buyers ?? []).map((u) => [u.id, u]));
  const page = pageResult(rows, offset, limit);
  return { ...page, items: page.items.map((r) => ({ ...r, buyer: map.get(r.user_id) ?? null })) };
}

// —— 算价：VIP 折扣按万分比逐行分摊（floor，保证 Σ 行折扣 = 折扣总额且不超原价）——
export function vipDiscountOfLines(lines, discountRate) {
  const rate = money(discountRate);
  if (!(rate >= 1) || rate >= RATE_FULL) return { lines, discount_base: 0 };
  let discount = 0;
  const out = lines.map((line) => {
    const subtotal = money(line.subtotal_base);
    const cut = Math.floor((subtotal * (RATE_FULL - rate)) / RATE_FULL);
    discount += cut;
    return { ...line, subtotal_base: subtotal - cut, original_subtotal_base: subtotal };
  });
  return { lines: out, discount_base: discount };
}
