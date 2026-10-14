// 金币兑换商城（文档F V1.0；决策 D-1..D-8 全按推荐落地）——本地实现，D9 未应用云端
// 金币=完全独立激励货币：不接 wallet/算价/退款链，不可充值提现转账抵现。
// 账本原子序镜像文档B §3.4 / wallet.changeBalance，仅换表（coin_accounts CAS + coin_txns append-only）。
// 消耗走独立兑换小状态机（coin_redemptions），实物也不并入 orders；返币后置到 order→COMPLETED（免撤币）。
import { AppError, isUniqueViolation } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { signedUrlForKey } from "./files.mjs";
import { grantCoupon, couponTemplateOf } from "./coupons.mjs";
import { grantVipForCoin, vipPlanRowById } from "./vip.mjs";
import { loadAddressSnapshot } from "./address.mjs";
import { emit } from "./notify.mjs";
import { getMergedConfig, saveConfigKeys, validateCoinRules } from "./config.mjs";
import { nowIso, pageParams, pageResult, vEnum, vInt, vStr, vUuid, countRows } from "./validate.mjs";

export const COIN_TXN_TYPES = [
  "checkin", "checkin_bonus", "order_reward", "invite_reward",
  "redeem_coupon", "redeem_item", "admin_adjust", "revoke",
];
// 文档P §2：平台不售卖虚拟产品 ⇒ virtual 出局，新增 vip（会员时长权益）。
// 两列历史虚拟内容（virtual_content/virtual_snapshot）保留不改写，只关入口。
export const COIN_ITEM_TYPES = ["coupon", "vip", "physical"];
export const COIN_ITEM_STATUS = ["on", "off", "archived"];
const NEXT_ITEM_STATUS = { on: ["off", "archived"], off: ["on", "archived"], archived: [] };
export const REDEMPTION_STATUS = ["REDEEMED", "PENDING_SHIP", "SHIPPED", "RECEIVED", "REVOKED"];
// 占兑换上限 / 库存的兑换单状态（REVOKED 已撤销，不占）
const HELD_REDEMPTION_STATUS = ["REDEEMED", "PENDING_SHIP", "SHIPPED", "RECEIVED"];

const ACCOUNT_COLS = "id,user_id,balance,total_earned,total_spent,created_at,updated_at";
const TXN_COLS = "id,user_id,txn_type,amount,balance_before,balance_after,ref_type,ref_id,remark,created_at";
const ITEM_COLS = "id,item_type,title,title_i18n,images,description,coupon_template_id,sku_id,virtual_content,"
  + "vip_plan_id,vip_duration_days,"
  + "coin_price,stock_mode,stock_available,per_user_limit,redeemed_count,status,sort_order,created_at,updated_at";
const REDEEM_COLS = "id,user_id,coin_item_id,item_type,title_snapshot,image_snapshot,coin_amount,status,"
  + "coupon_instance_id,virtual_snapshot,user_vip_id,address_snapshot,ship_company,ship_no,coin_txn_id,revoke_txn_id,created_at,updated_at";
// 专区图片复用商品/品牌前缀（brand 为文档F 约定；products 兼容既有上传器）
const IMAGE_KEY_RE = /^(brand|products)\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isSafeInteger(n) ? n : 0;
};

const vCoin = (v, field, { min = 0 } = {}) => vInt(v, field, { min, max: 999999999 });

// UTC 自然日界（决策 D-7，与公告/审计/券一致）
function utcDateStr(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// —— 全站开关（决策 D-6：switches.coins）——
async function coinsEnabled(supabase) {
  const { config } = await getMergedConfig(supabase);
  return config.switches?.coins === true;
}

async function assertCoinsEnabled(supabase) {
  if (!(await coinsEnabled(supabase))) {
    throw new AppError(410, "coins_disabled", "金币功能当前未开启");
  }
}

async function coinRules(supabase) {
  const { config } = await getMergedConfig(supabase);
  return config.coin_rules;
}

async function accountRow(supabase, userId) {
  const { data } = await supabase.from("coin_accounts").select(ACCOUNT_COLS)
    .eq("user_id", userId).maybeSingle();
  return data ?? null;
}

// 惰性开户：命中 0 行→INSERT(balance=0)，撞 UNIQUE(user_id) 视作并发已开→重读
async function loadOrCreateAccount(supabase, userId) {
  const existing = await accountRow(supabase, userId);
  if (existing) return existing;
  const now = nowIso();
  const { error } = await supabase.from("coin_accounts").insert({
    id: crypto.randomUUID(), user_id: userId, balance: 0, total_earned: 0, total_spent: 0,
    created_at: now, updated_at: now,
  });
  if (error && !isUniqueViolation(error)) throw new AppError(500, "internal_error");
  return await accountRow(supabase, userId) ?? {
    id: null, user_id: userId, balance: 0, total_earned: 0, total_spent: 0, created_at: now, updated_at: now,
  };
}

// —— 账本原子序（文档F §3.1，镜像 wallet.changeBalance）——
// amount 带符号（获得为 +，消耗/撤销为 −）；返回 { ok, txn_id, before, after } | { ok:false, reason }
export async function changeCoins(supabase, {
  userId, amount, txnType, refType, refId = null, idemKey = null, remark = null, reversalOf = null,
}) {
  if (!COIN_TXN_TYPES.includes(txnType)) return { ok: false, reason: "bad_type" };
  if (!Number.isSafeInteger(amount) || amount === 0) return { ok: false, reason: "bad_amount" };
  const account = await loadOrCreateAccount(supabase, userId);
  const before = num(account.balance);
  const after = before + amount;
  if (after < 0) return { ok: false, reason: "insufficient" };
  const earnedDelta = amount > 0 ? amount : 0;
  const spentDelta = amount < 0 ? -amount : 0;
  const now = nowIso();
  const { data: cas } = await supabase.from("coin_accounts")
    .update({
      balance: after,
      total_earned: num(account.total_earned) + earnedDelta,
      total_spent: num(account.total_spent) + spentDelta,
      updated_at: now,
    })
    .eq("user_id", userId).eq("balance", before)
    .select("id");
  if (!cas?.length) return { ok: false, reason: "conflict" };
  const txnId = crypto.randomUUID();
  const { error } = await supabase.from("coin_txns").insert({
    id: txnId,
    user_id: userId,
    txn_type: txnType,
    amount,
    balance_before: before,
    balance_after: after,
    ref_type: refType,
    ref_id: refId ?? null,
    reversal_of: reversalOf ?? null,
    idem_key: idemKey,
    remark,
    created_at: now,
  });
  if (error) {
    // 账本不可缺行（原则 4）：回滚 CAS；idem_key 撞车=该笔已入账，同样撤销本次增量
    await supabase.from("coin_accounts")
      .update({ balance: before, total_earned: num(account.total_earned), total_spent: num(account.total_spent), updated_at: nowIso() })
      .eq("user_id", userId).eq("balance", after);
    return { ok: false, reason: isUniqueViolation(error) ? "duplicated" : "log_failed" };
  }
  return { ok: true, txn_id: txnId, before, after };
}

// 找回已入账流水（重放/duplicated 时补状态用）
async function txnByIdem(supabase, idemKey) {
  const { data } = await supabase.from("coin_txns").select("id").eq("idem_key", idemKey).maybeSingle();
  return data?.id ?? null;
}

async function imageUrls(keys) {
  const urls = await Promise.all((keys ?? []).map((k) => signedUrlForKey(k)));
  return urls.filter(Boolean);
}

function shapeTxn(row) {
  return { ...row, amount: num(row.amount), balance_before: num(row.balance_before), balance_after: num(row.balance_after) };
}

function shapeItem(row) {
  return {
    id: row.id,
    item_type: row.item_type,
    title: row.title,
    title_i18n: row.title_i18n ?? {},
    description: row.description,
    images: Array.isArray(row.images) ? row.images : [],
    coin_price: num(row.coin_price),
    stock_mode: row.stock_mode,
    stock_available: row.stock_mode === "unlimited" ? null : num(row.stock_available),
    per_user_limit: num(row.per_user_limit),
    redeemed_count: num(row.redeemed_count),
    status: row.status,
    sort_order: num(row.sort_order),
    coupon_template_id: row.coupon_template_id ?? null,
    sku_id: row.sku_id ?? null,
    vip_plan_id: row.vip_plan_id ?? null,
    vip_duration_days: row.item_type === "vip" ? num(row.vip_duration_days) : null,
    need_address: row.item_type === "physical",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function shapeRedemption(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    coin_item_id: row.coin_item_id,
    item_type: row.item_type,
    title_snapshot: row.title_snapshot,
    coin_amount: num(row.coin_amount),
    status: row.status,
    coupon_instance_id: row.coupon_instance_id ?? null,
    virtual_snapshot: row.virtual_snapshot ?? null,
    user_vip_id: row.user_vip_id ?? null,
    address_snapshot: row.address_snapshot ?? null,
    ship_company: row.ship_company ?? null,
    ship_no: row.ship_no ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 该用户在该兑换项上的有效兑换次数（占 per_user_limit / 库存）
async function userRedeemedCount(supabase, userId, itemId) {
  return countRows(supabase.from("coin_redemptions")
    .select("id", { count: "exact" })
    .eq("user_id", userId).eq("coin_item_id", itemId).in("status", HELD_REDEMPTION_STATUS));
}

// 兑换单回显权益到期日：快照不含时长，须回读 user_vips（D18）
async function vipRowsByIds(supabase, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data } = await supabase.from("user_vips").select("id,status,expire_at").in("id", unique);
  return new Map((data ?? []).map((v) => [v.id, v]));
}

function vipFields(row, vips) {
  const vip = row.user_vip_id ? vips.get(row.user_vip_id) : null;
  return { vip_status: vip?.status ?? null, vip_expire_at: vip?.expire_at ?? null };
}

// 兑换项可兑性判定（按钮态），返回 { can_redeem, reason }
function redeemability(item, balance, redeemedCount) {
  if (item.status !== "on") return { can_redeem: false, reason: "item_offline" };
  if (item.stock_mode === "limited" && num(item.stock_available) < 1) return { can_redeem: false, reason: "out_of_stock" };
  if (item.per_user_limit > 0 && redeemedCount >= item.per_user_limit) return { can_redeem: false, reason: "redeem_limit_reached" };
  if (balance < item.coin_price) return { can_redeem: false, reason: "insufficient_coins" };
  return { can_redeem: true, reason: null };
}

// —— CI1 GET /app/coin/overview ——
export async function coinOverview(supabase, principal, query) {
  await assertCoinsEnabled(supabase);
  const { offset, limit } = pageParams(query);
  const [account, rules] = await Promise.all([loadOrCreateAccount(supabase, principal.id), coinRules(supabase)]);
  const today = utcDateStr();
  const { data: todayRow } = await supabase.from("coin_checkins").select("streak_days,reward_amount")
    .eq("user_id", principal.id).eq("checkin_date", today).maybeSingle();
  const { data: lastRow } = await supabase.from("coin_checkins").select("checkin_date,streak_days")
    .eq("user_id", principal.id).order("checkin_date", { ascending: false }).limit(1).maybeSingle();
  const { data, error } = await supabase.from("coin_txns").select(TXN_COLS)
    .eq("user_id", principal.id).order("created_at", { ascending: false }).range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  return {
    balance: num(account.balance),
    total_earned: num(account.total_earned),
    total_spent: num(account.total_spent),
    checked_in_today: Boolean(todayRow),
    streak_days: todayRow ? num(todayRow.streak_days) : (lastRow ? num(lastRow.streak_days) : 0),
    today_reward_base: todayRow ? num(todayRow.reward_amount) : 0,
    rules: {
      checkin_base: num(rules.checkin.base),
      bonus_schedule: rules.checkin.bonus_schedule,
      order_reward_enabled: rules.order_reward.enabled,
      order_reward_rate_bp: rules.order_reward.rate_bp,
    },
    ...pageResult((data ?? []).map(shapeTxn), offset, limit),
  };
}

// 连续天数：上一条为昨日则 +1，否则重置为 1
async function nextStreak(supabase, userId, nowMs) {
  const { data: last } = await supabase.from("coin_checkins").select("checkin_date,streak_days")
    .eq("user_id", userId).order("checkin_date", { ascending: false }).limit(1).maybeSingle();
  const yesterday = utcDateStr(nowMs - 86400 * 1000);
  if (last && last.checkin_date === yesterday) return num(last.streak_days) + 1;
  return 1;
}

// 连续阶梯加成：取 streak 达到的最高档 bonus
function bonusOf(schedule, streak) {
  let bonus = 0;
  for (const step of schedule ?? []) {
    if (streak >= num(step.streak)) bonus = Math.max(bonus, num(step.bonus));
  }
  return bonus;
}

// —— CI2 POST /app/coin/checkin [I] ——
export async function coinCheckin(supabase, principal) {
  await assertCoinsEnabled(supabase);
  const rules = await coinRules(supabase);
  const nowMs = Date.now();
  const today = utcDateStr(nowMs);
  const streak = await nextStreak(supabase, principal.id, nowMs);
  const baseAmt = num(rules.checkin.base);
  const bonus = bonusOf(rules.checkin.bonus_schedule, streak);
  const reward = baseAmt + bonus;

  const checkinId = crypto.randomUUID();
  const { error } = await supabase.from("coin_checkins").insert({
    id: checkinId, user_id: principal.id, checkin_date: today, streak_days: streak,
    base_amount: baseAmt, bonus_amount: bonus, reward_amount: reward, coin_txn_id: null, created_at: nowIso(),
  });
  if (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "already_checked_in", "今日已签到");
    throw new AppError(500, "internal_error");
  }

  const idemKey = `coin:checkin:${principal.id}:${today}`;
  const res = await changeCoins(supabase, {
    userId: principal.id, amount: reward, txnType: "checkin",
    refType: "checkin", refId: checkinId, idemKey, remark: `连续签到第 ${streak} 天`,
  });
  if (!res.ok && res.reason !== "duplicated") {
    throw new AppError(500, "internal_error");
  }
  const txnId = res.ok ? res.txn_id : await txnByIdem(supabase, idemKey);
  if (txnId) {
    await supabase.from("coin_checkins").update({ coin_txn_id: txnId }).eq("id", checkinId);
  }
  return {
    checkin_id: checkinId,
    checkin_date: today,
    streak_days: streak,
    base_amount: baseAmt,
    bonus_amount: bonus,
    reward_amount: reward,
    balance: res.ok ? res.after : await currentBalance(supabase, principal.id),
  };
}

async function currentBalance(supabase, userId) {
  return num((await accountRow(supabase, userId))?.balance);
}

// —— CI3 GET /app/coin/items ——
export async function coinItems(supabase, principal, query) {
  await assertCoinsEnabled(supabase);
  const { offset, limit } = pageParams(query);
  const account = await loadOrCreateAccount(supabase, principal.id);
  const balance = num(account.balance);
  let q = supabase.from("coin_items").select(ITEM_COLS).eq("status", "on").is("deleted_at", null)
    .order("sort_order", { ascending: true }).order("created_at", { ascending: false })
    .range(offset, offset + limit);
  const type = vEnum(query.item_type, "item_type", COIN_ITEM_TYPES, { optional: true });
  if (type) q = q.eq("item_type", type);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = (data ?? []).map(shapeItem).filter((item) => COIN_ITEM_TYPES.includes(item.item_type));
  const items = [];
  for (const item of rows) {
    const redeemed = await userRedeemedCount(supabase, principal.id, item.id);
    const { can_redeem, reason } = redeemability(item, balance, redeemed);
    items.push({ ...item, redeemed_count_by_user: redeemed, can_redeem, blocked_reason: reason, image_urls: await imageUrls(item.images) });
  }
  return { balance, ...pageResult(items, offset, limit) };
}

// —— CI4 GET /app/coin/item?id= ——
export async function coinItemDetail(supabase, principal, query) {
  await assertCoinsEnabled(supabase);
  const id = vUuid(query.id, "id");
  const { data } = await supabase.from("coin_items").select(ITEM_COLS).eq("id", id).is("deleted_at", null).maybeSingle();
  if (!data || data.status !== "on") throw new AppError(410, "item_offline", "兑换项已下架或不存在");
  const account = await loadOrCreateAccount(supabase, principal.id);
  const item = shapeItem(data);
  // 停售类型（如历史 virtual）不进购物端详情：与 CI3 列表同源过滤
  if (!COIN_ITEM_TYPES.includes(item.item_type)) throw new AppError(410, "item_offline", "该兑换项已停止兑换");
  const redeemed = await userRedeemedCount(supabase, principal.id, item.id);
  const { can_redeem, reason } = redeemability(item, num(account.balance), redeemed);
  let coupon = null;
  if (item.item_type === "coupon" && item.coupon_template_id) {
    const t = await couponTemplateOf(supabase, item.coupon_template_id);
    if (t) {
      coupon = {
        name: t.name, name_i18n: t.name_i18n ?? {}, coupon_type: t.coupon_type,
        threshold_amount_base: num(t.threshold_amount_base), discount_amount_base: num(t.discount_amount_base),
        scope: t.scope, valid_days: num(t.valid_days), valid_until: t.valid_until,
      };
    }
  }
  let vip = null;
  if (item.item_type === "vip" && item.vip_plan_id) {
    // 三档权益共用同一套餐（文档P Q1：内容完全相同、只差时长）⇒ 权益内容取套餐，天数取兑换项自身
    const plan = await vipPlanRowById(supabase, item.vip_plan_id);
    if (plan) {
      vip = {
        name: plan.name, name_i18n: plan.name_i18n ?? {},
        discount_rate: Number(plan.discount_rate ?? 0), benefits: plan.benefits ?? [],
      };
    }
  }
  return {
    ...item,
    image_urls: await imageUrls(item.images),
    redeemed_count_by_user: redeemed,
    can_redeem,
    blocked_reason: reason,
    coupon,
    vip,
  };
}

// —— CI5 POST /app/coin/redeem [I] ——
// 顺序：认领库存 → 扣币（reserve）→ 履约（发券/快照/地址）→ 落兑换单；任一步失败逆序补偿
export async function coinRedeem(supabase, principal, body) {
  await assertCoinsEnabled(supabase);
  const itemId = vUuid(body.item_id, "item_id");
  const { data } = await supabase.from("coin_items").select(ITEM_COLS).eq("id", itemId).is("deleted_at", null).maybeSingle();
  const item = data ? shapeItem(data) : null;
  if (!item || item.status !== "on") throw new AppError(410, "item_offline", "兑换项已下架或不存在");

  const redeemed = await userRedeemedCount(supabase, principal.id, item.id);
  if (item.per_user_limit > 0 && redeemed >= item.per_user_limit) {
    throw new AppError(410, "redeem_limit_reached", "已达该兑换项的每人兑换上限", { per_user_limit: item.per_user_limit });
  }

  // ① 库存认领（limited）：按读取值做等值 CAS（防并发丢失更新）→ stock-1, redeemed_count+1
  if (item.stock_mode === "limited") {
    const { data: cas } = await supabase.from("coin_items")
      .update({ stock_available: num(item.stock_available) - 1, redeemed_count: num(item.redeemed_count) + 1, updated_at: nowIso() })
      .eq("id", item.id).eq("stock_available", num(item.stock_available)).gte("stock_available", 1).select("id");
    if (!cas?.length) throw new AppError(409, "out_of_stock", "兑换库存不足");
  } else {
    await supabase.from("coin_items").update({ redeemed_count: num(item.redeemed_count) + 1, updated_at: nowIso() })
      .eq("id", item.id);
  }
  const restoreStock = async () => {
    if (item.stock_mode === "limited") {
      await supabase.from("coin_items")
        .update({ stock_available: num(item.stock_available), redeemed_count: redeemed })
        .eq("id", item.id);
    } else {
      await supabase.from("coin_items").update({ redeemed_count: redeemed }).eq("id", item.id);
    }
  };

  const redemptionId = crypto.randomUUID();
  const price = item.coin_price;
  const txnType = item.item_type === "coupon" ? "redeem_coupon" : "redeem_item";
  const coinIdem = `coin:redeem:${redemptionId}`;

  // ② 扣币（reserve）
  const debit = await changeCoins(supabase, {
    userId: principal.id, amount: -price, txnType,
    refType: "coin_redemption", refId: redemptionId, idemKey: coinIdem, remark: `兑换 ${item.title}`,
  });
  if (!debit.ok) {
    await restoreStock();
    if (debit.reason === "insufficient") throw new AppError(409, "insufficient_coins", "金币不足");
    throw new AppError(500, "internal_error");
  }

  // 退币补偿（后续步骤失败时）
  const refundCoins = async () => {
    await changeCoins(supabase, {
      userId: principal.id, amount: price, txnType: "revoke",
      refType: "coin_redemption", refId: redemptionId, idemKey: `coin:redeem:undo:${redemptionId}`,
      remark: `兑换失败退回：${item.title}`, reversalOf: debit.txn_id,
    });
  };

  // ③ 履约
  let status;
  let couponInstanceId = null;
  let userVipId = null;
  let vipExpireAt = null;
  let addressSnapshot = null;
  try {
    if (item.item_type === "coupon") {
      if (!item.coupon_template_id) throw new AppError(409, "item_misconfigured", "券兑换项未关联券模板");
      const seq = await userRedeemedCount(supabase, principal.id, item.id);
      const grant = await grantCoupon(supabase, {
        templateId: item.coupon_template_id, userId: principal.id, seq, source: "activity", sourceRefId: redemptionId,
      });
      if (!grant.granted && !grant.duplicated) {
        throw grant.reason === "quota_reached"
          ? new AppError(410, "item_quota_reached", "该优惠券已兑完或达上限")
          : new AppError(410, "item_offline", "优惠券当前不可兑换");
      }
      couponInstanceId = grant.coupon_id;
      status = "REDEEMED";
    } else if (item.item_type === "vip") {
      // 权益兑换 = 直接把会员时长发放到 user_vips，零现金、不经 payments；三档共用同一套餐，只差天数（文档P Q1）
      const days = num(item.vip_duration_days);
      if (!item.vip_plan_id || days <= 0) throw new AppError(409, "item_misconfigured", "权益兑换项未关联会员套餐或时长非法");
      const plan = await vipPlanRowById(supabase, item.vip_plan_id);
      if (!plan) throw new AppError(409, "item_misconfigured", "权益兑换项关联的会员套餐已不存在");
      const grant = await grantVipForCoin(supabase, { userId: principal.id, plan, durationDays: days });
      if (!grant.ok) throw new AppError(500, "internal_error");
      userVipId = grant.granted.vip_id;
      vipExpireAt = grant.granted.expire_at;
      status = "REDEEMED";
    } else if (item.item_type === "physical") {
      const addressId = body.address_id ? vUuid(body.address_id, "address_id") : null;
      if (!addressId) throw new AppError(400, "invalid_request", "实物兑换需提供收货地址", { field: "address_id" });
      addressSnapshot = await loadAddressSnapshot(supabase, principal.id, addressId);
      status = "PENDING_SHIP";
    } else {
      // 停售类型（如历史 virtual）即便还挂着 on 也不兑：类型白名单已不含它
      throw new AppError(410, "item_offline", "该兑换项已停止兑换");
    }
  } catch (error) {
    await refundCoins();
    await restoreStock();
    if (error instanceof AppError) throw error;
    throw new AppError(500, "internal_error");
  }

  // ④ 落兑换单（快照定格）
  const now = nowIso();
  const { error: insertErr } = await supabase.from("coin_redemptions").insert({
    id: redemptionId,
    user_id: principal.id,
    coin_item_id: item.id,
    item_type: item.item_type,
    title_snapshot: item.title,
    image_snapshot: Array.isArray(data.images) ? data.images : [],
    coin_amount: price,
    status,
    coupon_instance_id: couponInstanceId,
    user_vip_id: userVipId,
    address_snapshot: addressSnapshot,
    coin_txn_id: debit.txn_id,
    revoke_txn_id: null,
    created_at: now,
    updated_at: now,
  });
  if (insertErr) {
    if (item.item_type === "coupon" && couponInstanceId) {
      await supabase.from("user_coupons").update({ status: "REVOKED", updated_at: nowIso() }).eq("id", couponInstanceId);
    }
    // 权益已发放却落单失败 ⇒ 收回（activeVip 只认 status=active，非 active 即不再享折扣；user_vips 无 updated_at 列）
    if (item.item_type === "vip" && userVipId) {
      await supabase.from("user_vips").update({ status: "refunded" }).eq("id", userVipId);
    }
    await refundCoins();
    await restoreStock();
    throw new AppError(500, "internal_error");
  }

  await emit(supabase, {
    userId: principal.id,
    msgType: item.item_type === "vip" ? "coin_redeem_vip" : "coin_redeem_done",
    title: "兑换成功",
    content: item.item_type === "coupon" ? `「${item.title}」已放入你的券包`
      : item.item_type === "vip" ? `「${item.title}」兑换成功，会员权益已到账，有效期至 ${String(vipExpireAt).slice(0, 10)}`
        : `「${item.title}」兑换成功，等待发货`,
    refType: "coin_redemption", refId: redemptionId,
  });
  return {
    redemption_id: redemptionId,
    status,
    item_type: item.item_type,
    coin_amount: price,
    balance: debit.after,
    coupon_instance_id: couponInstanceId,
    user_vip_id: userVipId,
    vip_expire_at: vipExpireAt,
    need_ship: item.item_type === "physical",
  };
}

// —— CI6 GET /app/coin/redemptions ——
export async function coinRedemptions(supabase, principal, query) {
  await assertCoinsEnabled(supabase);
  const { offset, limit } = pageParams(query);
  let q = supabase.from("coin_redemptions").select(REDEEM_COLS)
    .eq("user_id", principal.id).order("created_at", { ascending: false }).range(offset, offset + limit);
  const status = vEnum(query.status, "status", REDEMPTION_STATUS, { optional: true });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = (data ?? []).map(shapeRedemption);
  const couponIds = rows.map((r) => r.coupon_instance_id).filter(Boolean);
  const { data: coupons } = couponIds.length
    ? await supabase.from("user_coupons").select("id,status").in("id", couponIds)
    : { data: [] };
  const couponMap = new Map((coupons ?? []).map((c) => [c.id, c.status]));
  const vips = await vipRowsByIds(supabase, rows.map((r) => r.user_vip_id));
  const items = [];
  for (const r of rows) {
    items.push({
      ...r,
      image_urls: await imageUrls(r.image_snapshot),
      coupon_status: r.coupon_instance_id ? (couponMap.get(r.coupon_instance_id) ?? null) : null,
      ...vipFields(r, vips),
    });
  }
  return pageResult(items, offset, limit);
}

// —— 购物端确认收货（仅 physical：SHIPPED→RECEIVED，终态）——
export async function coinRedemptionConfirm(supabase, principal, body) {
  await assertCoinsEnabled(supabase);
  const id = vUuid(body.redemption_id, "redemption_id");
  const { data: cas } = await supabase.from("coin_redemptions")
    .update({ status: "RECEIVED", updated_at: nowIso() })
    .eq("id", id).eq("user_id", principal.id).eq("status", "SHIPPED").select("id");
  if (!cas?.length) throw new AppError(409, "state_conflict", "兑换单状态不可确认收货");
  return { redemption_id: id, status: "RECEIVED" };
}

// ══ 后台 CO1–CO4（文档F §五）═══════════════════════════════════════════════════

// —— CO1a GET /app/admin/coin/rules ——
export async function adminCoinRules(supabase, request) {
  await adminGuard(supabase, request, "coin.manage");
  return await coinRules(supabase);
}

// —— CO1b POST /app/admin/coin/rules（保存即生效）——
export async function adminCoinRulesSave(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coin.manage");
  const rules = validateCoinRules(body.coin_rules);
  await saveConfigKeys(supabase, actor.id, { coin_rules: rules });
  await writeAudit(supabase, {
    adminId: actor.id, action: "coin.rules.save", targetType: "site_config", targetId: null,
    detail: { checkin_base: rules.checkin.base, order_reward_enabled: rules.order_reward.enabled },
    ip: request.headers.get("x-forwarded-for"),
  });
  return rules;
}

// —— coin_items 草稿校验 ——
function validateCoinItemDraft(body, { existing = null } = {}) {
  const itemType = vEnum(body.item_type, "item_type", COIN_ITEM_TYPES);
  const title = vStr(body.title, "title", { min: 1, max: 60 });
  const description = body.description ? vStr(body.description, "description", { max: 500 }) : "";
  const rawImages = body.images ?? [];
  if (!Array.isArray(rawImages) || rawImages.length > 6) {
    throw new AppError(400, "invalid_request", "images 需为 ≤6 的数组", { field: "images" });
  }
  const images = rawImages.map((k) => {
    if (typeof k !== "string" || !IMAGE_KEY_RE.test(k)) throw new AppError(400, "invalid_request", "兑换项图片不合法");
    return k;
  });
  const coinPrice = vCoin(body.coin_price, "coin_price", { min: 1 });
  const stockMode = vEnum(body.stock_mode ?? "limited", "stock_mode", ["limited", "unlimited"]);
  const stockAvailable = stockMode === "limited" ? vInt(body.stock_available ?? 0, "stock_available", { min: 0, max: 1000000000 }) : 0;
  const perUserLimit = vInt(body.per_user_limit ?? 0, "per_user_limit", { min: 0, max: 999 });
  const sortOrder = vInt(body.sort_order ?? 0, "sort_order", { min: 0, max: 999 });

  let couponTemplateId = null;
  let vipPlanId = null;
  let vipDurationDays = null;
  let skuId = null;
  if (itemType === "coupon") {
    couponTemplateId = vUuid(body.coupon_template_id, "coupon_template_id");
  } else if (itemType === "vip") {
    // 权益项必须绑定套餐与时长；时长允许覆盖套餐默认（三档共用同一套餐，只差天数）
    vipPlanId = vUuid(body.vip_plan_id, "vip_plan_id");
    vipDurationDays = vInt(body.vip_duration_days ?? 0, "vip_duration_days", { min: 1, max: 3650 });
  } else {
    skuId = body.sku_id ? vUuid(body.sku_id, "sku_id") : null;
  }

  const redeemed = num(existing?.redeemed_count);
  if (stockMode === "limited" && existing && stockAvailable < redeemed) {
    throw new AppError(409, "state_conflict", "库存不得小于已兑换数量", { redeemed_count: redeemed });
  }

  // coin_items.title_i18n 是 jsonb NOT NULL：缺省必须给 {}，给 null 会让 insert/update 直接撞约束（与 catalog/vip/announcements 同口径）
  const titleI18n = body.title_i18n && typeof body.title_i18n === "object" && !Array.isArray(body.title_i18n)
    ? body.title_i18n : {};
  return {
    item_type: itemType,
    title,
    title_i18n: titleI18n,
    description,
    images,
    coupon_template_id: couponTemplateId,
    vip_plan_id: vipPlanId,
    vip_duration_days: vipDurationDays,
    sku_id: skuId,
    coin_price: coinPrice,
    stock_mode: stockMode,
    stock_available: stockAvailable,
    per_user_limit: perUserLimit,
    sort_order: sortOrder,
  };
}

// —— CO2a GET /app/admin/coin-items ——
export async function adminCoinItems(supabase, request, query) {
  await adminGuard(supabase, request, "coin.manage");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("coin_items").select(ITEM_COLS).is("deleted_at", null)
    .order("sort_order", { ascending: true }).order("created_at", { ascending: false }).range(offset, offset + limit);
  const status = vEnum(query.status, "status", COIN_ITEM_STATUS, { optional: true });
  if (status) q = q.eq("status", status);
  const type = vEnum(query.item_type, "item_type", COIN_ITEM_TYPES, { optional: true });
  if (type) q = q.eq("item_type", type);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const total = await countRows(supabase.from("coin_items").select("id", { count: "exact" }).is("deleted_at", null));
  // 历史虚拟项的 virtual_content 仅后台可读（文档P §2 已关入口，购物端不再下发）
  const rows = (data ?? []).map((d) => ({ ...shapeItem(d), virtual_content: d.virtual_content ?? null }));
  return { total, ...pageResult(rows, offset, limit) };
}

// —— CO2b POST /app/admin/coin-item/save ——
export async function adminCoinItemSave(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coin.manage");
  const itemId = body.item_id ? vUuid(body.item_id, "item_id") : null;
  let existing = null;
  if (itemId) {
    const { data } = await supabase.from("coin_items").select(ITEM_COLS).eq("id", itemId).is("deleted_at", null).maybeSingle();
    if (!data) throw new AppError(404, "not_found", "兑换项不存在");
    existing = data;
  }
  const draft = validateCoinItemDraft(body, { existing });
  // 权益项的套餐必须真实存在（下架 off 允许：金币侧的售卖闸是 coin_items.status，不是套餐状态）
  if (draft.item_type === "vip" && !(await vipPlanRowById(supabase, draft.vip_plan_id))) {
    throw new AppError(400, "invalid_request", "关联的会员套餐不存在", { field: "vip_plan_id" });
  }
  const now = nowIso();
  if (existing) {
    const { error } = await supabase.from("coin_items").update({ ...draft, updated_at: now }).eq("id", existing.id);
    if (error) throw new AppError(500, "internal_error");
    await writeAudit(supabase, {
      adminId: actor.id, action: "coin.item.save", targetType: "coin_item", targetId: existing.id,
      detail: { title: draft.title, mode: "update" },
    });
    return { item_id: existing.id, updated: true };
  }
  const id = crypto.randomUUID();
  const { error } = await supabase.from("coin_items").insert({
    id, ...draft, redeemed_count: 0, status: "off", created_at: now, updated_at: now,
  });
  if (error) throw new AppError(500, "internal_error");
  await writeAudit(supabase, {
    adminId: actor.id, action: "coin.item.save", targetType: "coin_item", targetId: id,
    detail: { title: draft.title, mode: "create" },
  });
  return { item_id: id, updated: false };
}

// —— CO2c POST /app/admin/coin-item/status（上下架/归档，软删走 archived）——
export async function adminCoinItemStatus(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coin.manage");
  const id = vUuid(body.item_id, "item_id");
  const to = vEnum(body.status, "status", COIN_ITEM_STATUS);
  const { data } = await supabase.from("coin_items").select("id,title,status,deleted_at").eq("id", id).is("deleted_at", null).maybeSingle();
  if (!data) throw new AppError(404, "not_found", "兑换项不存在");
  const from = data.status;
  if (from === to) return { item_id: id, status: to, changed: false };
  if (!NEXT_ITEM_STATUS[from].includes(to)) {
    throw new AppError(409, "state_conflict", "兑换项状态不可这样流转", { from, to });
  }
  const now = nowIso();
  const patch = to === "archived" ? { status: to, deleted_at: now, updated_at: now } : { status: to, updated_at: now };
  const { data: cas } = await supabase.from("coin_items").update(patch).eq("id", id).eq("status", from).select("id");
  if (!cas?.length) throw new AppError(409, "claim_conflict", "兑换项状态已变化，请刷新后重试");
  await writeAudit(supabase, {
    adminId: actor.id, action: "coin.item.status", targetType: "coin_item", targetId: id, detail: { title: data.title, from, to },
  });
  return { item_id: id, status: to, changed: true };
}

// —— CO3a GET /app/admin/coin-redemptions（队列）——
export async function adminCoinRedemptions(supabase, request, query) {
  await adminGuard(supabase, request, "coin.fulfill");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("coin_redemptions").select(REDEEM_COLS)
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  const status = vEnum(query.status, "status", REDEMPTION_STATUS, { optional: true });
  if (status) q = q.eq("status", status);
  const type = vEnum(query.item_type, "item_type", COIN_ITEM_TYPES, { optional: true });
  if (type) q = q.eq("item_type", type);
  if (query.user_id) q = q.eq("user_id", vUuid(query.user_id, "user_id"));
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = (data ?? []).map(shapeRedemption);
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: users } = userIds.length
    ? await supabase.from("users").select("id,username,nickname").in("id", userIds)
    : { data: [] };
  const userMap = new Map((users ?? []).map((u) => [u.id, u]));
  const vips = await vipRowsByIds(supabase, rows.map((r) => r.user_vip_id));
  const counts = {};
  await Promise.all(REDEMPTION_STATUS.map(async (st) => {
    counts[st] = await countRows(supabase.from("coin_redemptions").select("id", { count: "exact" }).eq("status", st));
  }));
  return {
    counts_by_status: counts,
    ...pageResult(rows.map((r) => ({
      ...r,
      username: userMap.get(r.user_id)?.username ?? "—",
      nickname: userMap.get(r.user_id)?.nickname ?? "",
      ...vipFields(r, vips),
    })), offset, limit),
  };
}

// —— CO3b POST /app/admin/coin-redemption/ship（仅 physical：PENDING_SHIP→SHIPPED）——
export async function adminCoinRedemptionShip(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coin.fulfill");
  const id = vUuid(body.redemption_id, "redemption_id");
  const shipCompany = vStr(body.ship_company, "ship_company", { min: 1, max: 40 });
  const shipNo = vStr(body.ship_no, "ship_no", { min: 1, max: 60 });
  const { data: cas } = await supabase.from("coin_redemptions")
    .update({ status: "SHIPPED", ship_company: shipCompany, ship_no: shipNo, updated_at: nowIso() })
    .eq("id", id).eq("item_type", "physical").eq("status", "PENDING_SHIP").select("id");
  if (!cas?.length) throw new AppError(409, "state_conflict", "兑换单不可发货（非待发货实物单或状态已变化）");
  const { data: row } = await supabase.from("coin_redemptions").select("user_id").eq("id", id).maybeSingle();
  await emit(supabase, {
    userId: row?.user_id, msgType: "coin_redeem_done", title: "兑换商品已发货",
    content: `你的兑换商品已发出：${shipCompany} ${shipNo}`, refType: "coin_redemption", refId: id,
  });
  await writeAudit(supabase, {
    adminId: actor.id, action: "coin.redemption.ship", targetType: "coin_redemption", targetId: id,
    detail: { ship_company: shipCompany, ship_no: shipNo },
  });
  return { redemption_id: id, status: "SHIPPED" };
}

// —— CO3c POST /app/admin/coin-redemption/revoke（REDEEMED/PENDING_SHIP→REVOKED，退币+撤券/回库存）——
export async function adminCoinRedemptionRevoke(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coin.fulfill");
  const id = vUuid(body.redemption_id, "redemption_id");
  const reason = vStr(body.reason ?? "", "reason", { max: 200 });
  const { data: row } = await supabase.from("coin_redemptions").select(REDEEM_COLS).eq("id", id).maybeSingle();
  if (!row) throw new AppError(404, "not_found", "兑换单不存在");
  if (row.status !== "REDEEMED" && row.status !== "PENDING_SHIP") {
    throw new AppError(409, "state_conflict", "仅待发货/已兑换且券未使用的兑换单可撤销", { status: row.status });
  }
  // 权益（会员时长）一经发放不可撤销（文档P Q3）：时长已落 user_vips，期间可能已享受到下单折扣
  if (row.item_type === "vip") {
    throw new AppError(409, "revoke_not_allowed", "权益兑换不可撤销（会员时长已发放）");
  }
  // 券类：券已使用则拒绝撤销（沿用现状：只撤未用券）
  if (row.item_type === "coupon" && row.coupon_instance_id) {
    const { data: revoked } = await supabase.from("user_coupons")
      .update({ status: "REVOKED", updated_at: nowIso() })
      .eq("id", row.coupon_instance_id).eq("status", "UNUSED").select("id");
    if (!revoked?.length) throw new AppError(409, "revoke_failed", "券已使用或状态已变化，不可撤销");
  }
  // 退币（正向冲正，reversal_of 指向消耗行）
  const refund = await changeCoins(supabase, {
    userId: row.user_id, amount: num(row.coin_amount), txnType: "revoke",
    refType: "coin_redemption", refId: row.id, idemKey: `coin:revoke:${row.id}`,
    remark: `撤销兑换退回：${reason || "未填写"}`, reversalOf: row.coin_txn_id,
  });
  if (!refund.ok && refund.reason !== "duplicated") {
    throw new AppError(409, "revoke_failed", "退币失败", { reason: refund.reason });
  }
  const refundTxnId = refund.ok ? refund.txn_id : await txnByIdem(supabase, `coin:revoke:${row.id}`);
  // 库存回退（limited 实物/任意 limited 项）
  const { data: item } = await supabase.from("coin_items").select("id,stock_mode,stock_available,redeemed_count")
    .eq("id", row.coin_item_id).maybeSingle();
  if (item && item.stock_mode === "limited") {
    await supabase.from("coin_items")
      .update({ stock_available: num(item.stock_available) + 1, redeemed_count: Math.max(0, num(item.redeemed_count) - 1), updated_at: nowIso() })
      .eq("id", item.id);
  }
  const { data: cas } = await supabase.from("coin_redemptions")
    .update({ status: "REVOKED", revoke_txn_id: refundTxnId, updated_at: nowIso() })
    .eq("id", row.id).in("status", ["REDEEMED", "PENDING_SHIP"]).select("id");
  if (!cas?.length) throw new AppError(409, "state_conflict", "兑换单状态已变化");
  await writeAudit(supabase, {
    adminId: actor.id, action: "coin.redemption.revoke", targetType: "coin_redemption", targetId: row.id,
    detail: { user_id: row.user_id, item_type: row.item_type, coin_amount: num(row.coin_amount), reason },
    ip: request.headers.get("x-forwarded-for"),
  });
  return { revoked: true, redemption_id: row.id, refund_txn_id: refundTxnId };
}

// —— CO4 POST /app/admin/user/coin-adjust ⚠（手动增减，镜像 AU3；可负禁负余额；必填原因）——
export async function adminUserCoinAdjust(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "coin.adjust");
  const userId = vUuid(body.user_id, "user_id");
  const amount = vInt(body.amount, "amount", { min: -999999999, max: 999999999 });
  if (amount === 0) throw new AppError(400, "invalid_request", "调整金币数不可为 0");
  const reason = vStr(body.reason, "reason", { min: 2, max: 200 });
  const { data: user } = await supabase.from("users").select("id").eq("id", userId).is("deleted_at", null).eq("status", "active").maybeSingle();
  if (!user) throw new AppError(404, "not_found", "用户不存在");
  const idemKey = `coin:adjust:${crypto.randomUUID()}`;
  const res = await changeCoins(supabase, {
    userId, amount, txnType: "admin_adjust", refType: "admin_action", refId: actor.id,
    idemKey, remark: reason,
  });
  if (!res.ok) {
    if (res.reason === "insufficient") throw new AppError(409, "insufficient_coins", "扣减后金币不足（余额不足）");
    if (res.reason === "conflict") throw new AppError(409, "claim_conflict", "金币余额已变化，请重试");
    throw new AppError(500, "internal_error");
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "coin.user_adjust", targetType: "user", targetId: userId,
    detail: { amount, before: res.before, after: res.after, reason },
    ip: request.headers.get("x-forwarded-for"),
  });
  return { user_id: userId, amount, before: res.before, after: res.after, txn_id: res.txn_id };
}

// —— 下单返币（决策 D-2：order→COMPLETED 副作用，幂等 per order）——
// 由 order_state.settleComplete 调用；金额=clamp(round(actual_paid×rate_bp/10000), min, max)
export async function coinOrderReward(supabase, order, { operatorId = null } = {}) {
  if (!(await coinsEnabled(supabase))) return { granted: false, reason: "coins_disabled" };
  const rules = await coinRules(supabase);
  if (!rules.order_reward.enabled) return { granted: false, reason: "rule_off" };
  // T2 自动确认传入的行不含金额列，缺则补读一次（与 invite.payableBase 同口径）
  let paid = Number(order.actual_paid_amount_base);
  if (!Number.isSafeInteger(paid)) {
    const { data } = await supabase.from("orders").select("id,actual_paid_amount_base").eq("id", order.id).maybeSingle();
    paid = Number(data?.actual_paid_amount_base) || 0;
  }
  if (paid <= 0) return { granted: false, reason: "no_amount" };
  const { rate_bp, min, max } = rules.order_reward;
  let reward = Math.round((paid * rate_bp) / 10000);
  reward = Math.max(min, Math.min(reward, max));
  if (reward <= 0) return { granted: false, reason: "zero_reward" };
  const idemKey = `coin:order:${order.id}`;
  const res = await changeCoins(supabase, {
    userId: order.user_id, amount: reward, txnType: "order_reward",
    refType: "order", refId: order.id, idemKey, remark: `订单 ${order.order_no ?? order.id} 收货返币`,
  });
  if (res.ok) {
    await emit(supabase, {
      userId: order.user_id, msgType: "coin_order_reward", title: "收货返币到账",
      content: `订单已完成，获得 ${reward} 金币，可在金币中心查看`, refType: "order", refId: order.id,
    });
    return { granted: true, reward_amount: reward, balance: res.after, txn_id: res.txn_id };
  }
  if (res.reason === "duplicated") {
    return { granted: false, reason: "duplicated", txn_id: await txnByIdem(supabase, idemKey) };
  }
  return { granted: false, reason: res.reason };
}

// —— 邀请金币到账（决策 D-5：invite_rewards.reward_type=coin 时由 invite.settleReward 调用）——
export async function grantInviteCoin(supabase, { userId, amount, rewardId }) {
  const idemKey = `coin:invite:${rewardId}`;
  const res = await changeCoins(supabase, {
    userId, amount: num(amount), txnType: "invite_reward",
    refType: "invite_reward", refId: rewardId, idemKey, remark: "邀请奖励金币到账",
  });
  if (res.ok) return { granted: true, coin_txn_id: res.txn_id };
  if (res.reason === "duplicated") return { granted: true, coin_txn_id: await txnByIdem(supabase, idemKey), duplicated: true };
  return { granted: false, reason: res.reason };
}

// —— 邀请金币撤销（invite.adminRevokeReward 对 reward_type=coin 的分支调用）——
export async function revokeInviteCoin(supabase, { userId, amount, rewardId, sourceTxnId }) {
  const idemKey = `coin:invite:revoke:${rewardId}`;
  // 冲正行要指回原到账行：invite_rewards 表没有金币流水列（余额类才有 wallet_txn_id），按到账幂等键找回
  const srcTxnId = sourceTxnId ?? await txnByIdem(supabase, `coin:invite:${rewardId}`);
  const res = await changeCoins(supabase, {
    userId, amount: -num(amount), txnType: "revoke",
    refType: "invite_reward", refId: rewardId, idemKey,
    remark: "邀请奖励金币撤销冲正", reversalOf: srcTxnId,
  });
  if (res.ok) return { ok: true, coin_txn_id: res.txn_id };
  if (res.reason === "duplicated") return { ok: true, coin_txn_id: await txnByIdem(supabase, idemKey) };
  return { ok: false, reason: res.reason };
}

