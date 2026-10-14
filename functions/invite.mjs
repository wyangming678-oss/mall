// 邀请返利（文档A §23/§24、文档B §7、文档C A1/A7/CY3/CY4/CY5、方案 §9）
// 关系一次性绑定（invitee_id UNIQUE，注册即定不可改）；奖励 PENDING→AVAILABLE→REVOKED，原始记录只追加不修改。
import { AppError, isUniqueViolation } from "./errors.mjs";
import { vStr, vEnum, vUuid, nowIso, pageParams, pageResult } from "./validate.mjs";
import { getMergedConfig, saveConfigKeys, validateInviteRules } from "./config.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { changeBalance } from "./wallet.mjs";
import { grantInviteCoin, revokeInviteCoin } from "./coins.mjs";
import { grantCoupon } from "./coupons.mjs";
import { emit } from "./notify.mjs";

export const TRIGGERS = ["first_register", "first_order", "first_recharge"];
export const REWARD_STATUS = ["PENDING", "AVAILABLE", "REVOKED"];

const base = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

// 关系维只写入一次（文档A §23：无 update 权限语义）
export async function bindRelation(supabase, { inviterId, inviteeId, channel = null }) {
  if (!inviterId || inviterId === inviteeId) return { bound: false };
  const { error } = await supabase.from("invite_relations").insert({
    id: crypto.randomUUID(), inviter_id: inviterId, invitee_id: inviteeId,
    channel, created_at: nowIso(),
  });
  if (error) {
    if (isUniqueViolation(error)) return { bound: false, reason: "already_bound" };
    throw new AppError(500, "internal_error");
  }
  const { data } = await supabase.from("invite_relations")
    .select("id,inviter_id,invitee_id,created_at").eq("invitee_id", inviteeId).maybeSingle();
  return { bound: true, relation: data ?? null };
}

// 方案 §9「双方得奖」的被邀请人一侧：注册即送 welcome 券，不进 invite_rewards（文档A §24 只建模邀请人侧）
export async function grantInviteeCoupon(supabase, { templateId, inviteeId, relationId, nowMs = Date.now() }) {
  if (!templateId) return { granted: false, reason: "not_configured" };
  const res = await grantCoupon(supabase, {
    templateId, userId: inviteeId, seq: 0, source: "invite", sourceRefId: relationId, nowMs,
  });
  return res.granted ? { granted: true, coupon_id: res.coupon_id } : { granted: false, reason: res.reason };
}

export async function inviteRules(supabase) {
  const { config } = await getMergedConfig(supabase);
  return config.invite_rules;
}

// 价值门控开关（switches.invite_reward_trigger）：默认 "register" 保持 M3b 冻结行为；
// "first_order" 把 welcome 券与 first_register 奖励推迟到首笔已支付订单，削弱批量注册囤奖励的动机
export async function rewardTriggerMode(supabase) {
  const { config } = await getMergedConfig(supabase);
  return config.switches?.invite_reward_trigger === "first_order" ? "first_order" : "register";
}

// coin 类奖励的数额只有一个来源：后台「金币规则 → 邀请人得金币」（coin_rules.invite_reward.inviter）。
// invite_rules 里的 reward_value_base 对 coin 无意义，登记时按当时的金币规则快照进行。
async function coinRewardAmount(supabase) {
  const { config } = await getMergedConfig(supabase);
  return base(config.coin_rules?.invite_reward?.inviter);
}

// —— 触发登记：写 PENDING 行，UNIQUE(relation_id,trigger_type) 数据库级兜底重复触发 ——
export async function registerReward(supabase, { relation, triggerType, triggerRefId = null, rule }) {
  if (!relation || !rule?.enabled) return { created: false, reason: "rule_off" };
  let value = 0;
  if (rule.reward_type === "balance") value = base(rule.reward_value_base);
  else if (rule.reward_type === "coin") value = await coinRewardAmount(supabase);
  // 金币数为 0 时不登记：否则会留一条永远只能发 0 币的奖励行，还会给买家发「奖励已到账」站内信
  if (rule.reward_type === "coin" && value === 0) return { created: false, reason: "coin_amount_zero" };
  const now = nowIso();
  const { error } = await supabase.from("invite_rewards").insert({
    id: crypto.randomUUID(),
    relation_id: relation.id,
    inviter_id: relation.inviter_id,
    trigger_type: triggerType,
    trigger_ref_id: triggerRefId,
    reward_type: rule.reward_type,
    reward_value: value,
    coupon_template_id: rule.coupon_template_id ?? null,
    user_coupon_id: null,
    wallet_txn_id: null,
    status: "PENDING",
    available_at: null,
    created_at: now,
    updated_at: now,
  });
  if (error) {
    if (isUniqueViolation(error)) return { created: false, reason: "duplicated" };
    throw new AppError(500, "internal_error");
  }
  return { created: true };
}

async function relationOfUser(supabase, userId) {
  const { data } = await supabase.from("invite_relations")
    .select("id,inviter_id,invitee_id,created_at").eq("invitee_id", userId).maybeSingle();
  return data ?? null;
}

// 触发点订单额：调用方已带则用，否则补读一次（T2 自动确认传入的行不含金额列）
async function payableBase(supabase, order) {
  const own = Number(order?.actual_paid_amount_base);
  if (Number.isSafeInteger(own)) return own;
  const { data } = await supabase.from("orders")
    .select("id,actual_paid_amount_base").eq("id", order.id).maybeSingle();
  return Number(data?.actual_paid_amount_base) || 0;
}

async function firstOrderReward(supabase, order, basis) {
  const rules = await inviteRules(supabase);
  const rule = rules.first_order;
  if (!rule.enabled || rule.basis !== basis) return { created: false, reason: "rule_off" };
  const relation = await relationOfUser(supabase, order.user_id);
  if (!relation) return { created: false, reason: "no_relation" };
  const min = base(rule.min_amount_base);
  if (min > 0 && await payableBase(supabase, order) < min) return { created: false, reason: "below_min_amount" };
  return registerReward(supabase, { relation, triggerType: "first_order", triggerRefId: order.id, rule });
}

// 首笔 PAID：first_order 触发登记（basis=paid）+ 门控模式下补发注册侧奖励。
// 幂等：PENDING 行有 UNIQUE(relation_id,trigger_type)，welcome 券走 grantCoupon 的 idem_key，重复支付只补状态不发奖。
export async function onOrderPaid(supabase, order) {
  const first = await firstOrderReward(supabase, order, "paid");
  if (await rewardTriggerMode(supabase) !== "first_order") return first;
  const rules = await inviteRules(supabase);
  const relation = await relationOfUser(supabase, order.user_id);
  if (!relation) return { ...first, deferred: { created: false, reason: "no_relation" } };
  const deferred = { reward: null, coupon: null };
  if (rules.first_register.enabled) {
    deferred.reward = await registerReward(supabase, {
      relation, triggerType: "first_register", triggerRefId: order.user_id, rule: rules.first_register,
    });
  }
  if (rules.invitee_coupon_template_id) {
    deferred.coupon = await grantInviteeCoupon(supabase, {
      templateId: rules.invitee_coupon_template_id, inviteeId: order.user_id, relationId: relation.id,
    });
  }
  return { ...first, deferred };
}

export function onOrderCompleted(supabase, order) {
  return firstOrderReward(supabase, order, "completed");
}

export async function onFirstRecharge(supabase, payment) {
  const rules = await inviteRules(supabase);
  const relation = await relationOfUser(supabase, payment.user_id);
  if (!relation) return { created: false, reason: "no_relation" };
  return registerReward(supabase, {
    relation, triggerType: "first_recharge", triggerRefId: payment.id, rule: rules.first_recharge,
  });
}

// —— 防刷硬限制（文档B §7 发放顺序：每人上限 → 券模板库存 → CAS 认领）——
async function capPassed(supabase, inviterId, nowMs) {
  const rules = await inviteRules(supabase);
  const total = base(rules.caps.per_inviter_total);
  const daily = base(rules.caps.per_inviter_daily);
  if (!total && !daily) return { ok: true };
  const { data: rows } = await supabase.from("invite_rewards")
    .select("id,created_at").eq("inviter_id", inviterId).eq("status", "AVAILABLE").limit(1000);
  const held = rows ?? [];
  if (total > 0 && held.length >= total) return { ok: false, reason: "cap_total" };
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  if (daily > 0 && held.filter((r) => Date.parse(r.created_at) >= dayStart.getTime()).length >= daily) {
    return { ok: false, reason: "cap_daily" };
  }
  return { ok: true };
}

// PENDING → AVAILABLE：真正到账（+X 流水 / 入券包），写 available_at
export async function settleReward(supabase, reward, nowMs = Date.now()) {
  if (reward.status !== "PENDING") return { granted: false, reason: "bad_state" };
  const rules = await inviteRules(supabase);
  const rule = rules[reward.trigger_type] ?? {};
  if (rule.enabled === false) return { granted: false, reason: "rule_off" };
  if (base(rule.delay_minutes) * 60000 > nowMs - Date.parse(reward.created_at)) {
    return { granted: false, reason: "in_delay" };
  }
  const cap = await capPassed(supabase, reward.inviter_id, nowMs);
  if (!cap.ok) return { granted: false, reason: cap.reason };

  const now = nowIso();
  const markAvailable = async (patch) => {
    const { data: done } = await supabase.from("invite_rewards")
      .update({ status: "AVAILABLE", available_at: now, updated_at: now, ...patch })
      .eq("id", reward.id).eq("status", "PENDING").select("id");
    const flipped = done?.length === 1;
    // 只有本次 CAS 真正翻转成功才发通知：重放与并发都只此一条（文档B §7 到账行）
    if (flipped) {
      await emit(supabase, {
        userId: reward.inviter_id, msgType: "invite_reward", title: "邀请奖励已到账",
        content: reward.reward_type === "coupon"
          ? "一张邀请优惠券已放入你的券包，下单时可选用"
          : reward.reward_type === "coin"
            ? "邀请奖励金币已到账，可在金币中心查看与兑换"
            : "邀请奖励已入账到你的余额，可在钱包查看流水",
        refType: "invite_reward", refId: reward.id,
      });
    }
    return flipped;
  };

  if (reward.reward_type === "balance") {
    const idemKey = `invite:reward:${reward.id}`;
    const res = await changeBalance(supabase, {
      userId: reward.inviter_id, amount: base(reward.reward_value), txnType: "invite_reward",
      refType: "invite_reward", refId: reward.id, idemKey,
      remark: `邀请奖励到账（${reward.trigger_type}）`,
    });
    if (!res.ok) {
      // idem 撞车=该笔此前已入账（上次到账后状态 CAS 未完成），找回流水后仅补状态
      if (res.reason !== "duplicated") return { granted: false, reason: `balance_${res.reason}` };
      const { data: txn } = await supabase.from("wallet_txns")
        .select("id").eq("idem_key", idemKey).maybeSingle();
      if (!txn) return { granted: false, reason: "balance_txn_missing" };
      const flipped = await markAvailable({ wallet_txn_id: txn.id });
      return { granted: flipped, status: "AVAILABLE", wallet_txn_id: txn.id };
    }
    const flipped = await markAvailable({ wallet_txn_id: res.txn_id });
    return { granted: flipped, status: "AVAILABLE", wallet_txn_id: res.txn_id };
  }

  // 金币类（文档F 决策 D-5）：走独立金币账本，不落 wallet；invite_rewards 无金币列，靠 coin:invite idem 防重
  if (reward.reward_type === "coin") {
    const res = await grantInviteCoin(supabase, {
      userId: reward.inviter_id, amount: base(reward.reward_value), rewardId: reward.id,
    });
    if (!res.granted) return { granted: false, reason: `coin_${res.reason}` };
    const flipped = await markAvailable({});
    return { granted: flipped, status: "AVAILABLE", coin_txn_id: res.coin_txn_id };
  }

  // 券类：seq 取该用户已持有同模板券数递增，grantCoupon 的 idem_key 天然防重
  const { count } = await supabase.from("user_coupons")
    .select("id", { count: "exact" }).eq("template_id", reward.coupon_template_id)
    .eq("user_id", reward.inviter_id).limit(1);
  const grant = await grantCoupon(supabase, {
    templateId: reward.coupon_template_id, userId: reward.inviter_id,
    seq: Number.isSafeInteger(count) ? count : 0, source: "invite", sourceRefId: reward.id, nowMs,
  });
  if (!grant.granted) {
    if (grant.duplicated && grant.coupon_id) {
      const flipped = await markAvailable({ user_coupon_id: grant.coupon_id });
      return { granted: flipped, status: "AVAILABLE", user_coupon_id: grant.coupon_id };
    }
    return { granted: false, reason: `coupon_${grant.reason}` };
  }
  const flipped = await markAvailable({ user_coupon_id: grant.coupon_id });
  return { granted: flipped, status: "AVAILABLE", user_coupon_id: grant.coupon_id };
}

// 惰性扫账：到期 PENDING 逐条到账，单行失败不影响批次
export async function settlePendingRewards(supabase, { inviterId = null, nowMs = Date.now(), limit = 50 } = {}) {
  let query = supabase.from("invite_rewards")
    .select("id,relation_id,inviter_id,trigger_type,reward_type,reward_value,coupon_template_id,status,created_at")
    .eq("status", "PENDING").order("created_at", { ascending: true }).limit(limit);
  if (inviterId) query = query.eq("inviter_id", inviterId);
  const { data: rows } = await query;
  let granted = 0;
  const blocked = [];
  for (const row of rows ?? []) {
    try {
      const res = await settleReward(supabase, row, nowMs);
      if (res.granted) granted += 1;
      else if (res.reason !== "conflict") blocked.push({ id: row.id, reason: res.reason });
    } catch { /* 单行失败保请求 */ }
  }
  return { scanned: (rows ?? []).length, granted, blocked };
}

// —— A7 我的邀请：邀请码/已邀人数/奖励三态统计（顺带惰性到账本邀请人的 PENDING）——
export async function inviteSummary(supabase, principal) {
  const { data: user } = await supabase.from("users")
    .select("id,invite_code").eq("id", principal.id).is("deleted_at", null).maybeSingle();
  if (!user) throw new AppError(404, "not_found");
  await settlePendingRewards(supabase, { inviterId: user.id, limit: 20 });

  const { count: invitedCount } = await supabase.from("invite_relations")
    .select("id", { count: "exact" }).eq("inviter_id", user.id).limit(1);
  const { data: rewards } = await supabase.from("invite_rewards")
    .select("id,trigger_type,trigger_ref_id,reward_type,reward_value,status,available_at,created_at")
    .eq("inviter_id", user.id).order("created_at", { ascending: false }).limit(50);
  const rules = await inviteRules(supabase);
  const stats = { PENDING: 0, AVAILABLE: 0, REVOKED: 0 };
  const amounts = { PENDING: 0, AVAILABLE: 0, REVOKED: 0 };
  const coinAmounts = { PENDING: 0, AVAILABLE: 0, REVOKED: 0 };
  for (const r of rewards ?? []) {
    stats[r.status] = base(stats[r.status]) + 1;
    // 合计分三口径：reward_amounts_base 只累计余额（单位分），金币单独一条，券既不计金额也不为 0
    if (r.reward_type === "coin") coinAmounts[r.status] = base(coinAmounts[r.status]) + base(r.reward_value);
    else if (r.reward_type === "balance") amounts[r.status] = base(amounts[r.status]) + base(r.reward_value);
  }
  return {
    invite_code: user.invite_code,
    invite_link: `/register?ref=${user.invite_code}`,
    invited_count: Number.isSafeInteger(invitedCount) ? invitedCount : 0,
    reward_stats: stats,
    reward_amounts_base: amounts,
    reward_coin_amounts: coinAmounts,
    rewards: rewards ?? [],
    rules: {
      first_register_enabled: rules.first_register.enabled,
      first_order_enabled: rules.first_order.enabled,
      note: rules.note,
    },
  };
}

// 报表展示用：一次性把用到的用户换成 {username,nickname}，缺失则显示占位
async function userNameLookup(supabase, ids) {
  const { data: users } = ids.length
    ? await supabase.from("users").select("id,username,nickname").in("id", ids)
    : { data: [] };
  const map = new Map((users ?? []).map((u) => [u.id, u]));
  return (id) => {
    const u = map.get(id);
    return u ? { id, username: u.username, nickname: u.nickname ?? "" } : { id, username: "—", nickname: "" };
  };
}

// —— CY4 邀请报表：关系视角 / 奖励视角 + 撤销处置入口 ——
export async function adminInviteOverview(supabase, request, query) {
  await adminGuard(supabase, request, "invite.read");
  const { offset, limit } = pageParams(query);
  const scope = vEnum(query.scope ?? "relations", "scope", ["relations", "rewards"]);
  if (scope === "rewards") {
    let q = supabase.from("invite_rewards")
      .select("id,relation_id,inviter_id,trigger_type,trigger_ref_id,reward_type,reward_value,coupon_template_id,user_coupon_id,wallet_txn_id,status,available_at,created_at,updated_at")
      .order("created_at", { ascending: false }).range(offset, offset + limit);
    const trigger = vEnum(query.trigger_type, "trigger_type", TRIGGERS, { optional: true });
    if (trigger) q = q.eq("trigger_type", trigger);
    const status = vEnum(query.status, "status", REWARD_STATUS, { optional: true });
    if (status) q = q.eq("status", status);
    if (query.inviter_id) q = q.eq("inviter_id", vUuid(query.inviter_id, "inviter_id"));
    const { data, error } = await q;
    if (error) throw new AppError(500, "internal_error");
    const rows = data ?? [];
    const nameOf = await userNameLookup(supabase, [...new Set(rows.map((r) => r.inviter_id))]);
    return pageResult(rows.map((row) => ({ ...row, inviter: nameOf(row.inviter_id) })), offset, limit);
  }
  let q = supabase.from("invite_relations")
    .select("id,inviter_id,invitee_id,channel,created_at")
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  if (query.inviter_id) q = q.eq("inviter_id", vUuid(query.inviter_id, "inviter_id"));
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const ids = rows.map((r) => r.id);
  const { data: rewards } = ids.length
    ? await supabase.from("invite_rewards")
      .select("id,relation_id,trigger_type,reward_type,reward_value,status").in("relation_id", ids)
    : { data: [] };
  const byRelation = new Map();
  for (const rw of rewards ?? []) {
    if (!byRelation.has(rw.relation_id)) byRelation.set(rw.relation_id, []);
    byRelation.get(rw.relation_id).push(rw);
  }
  const userIds = [...new Set(rows.flatMap((r) => [r.inviter_id, r.invitee_id]))];
  const nameOf = await userNameLookup(supabase, userIds);
  return pageResult(rows.map((row) => ({
    ...row,
    inviter: nameOf(row.inviter_id),
    invitee: nameOf(row.invitee_id),
    rewards: byRelation.get(row.id) ?? [],
  })), offset, limit);
}

// —— CY5 AVAILABLE → REVOKED：余额冲正 −X / 撤未用券，原始奖励记录状态推进、到账记录不删 ——
export async function adminRevokeReward(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "invite.manage");
  const rewardId = vUuid(body.reward_id, "reward_id");
  const reason = vStr(body.reason ?? "", "reason", { max: 200 });
  const { data: reward } = await supabase.from("invite_rewards")
    .select("id,inviter_id,trigger_type,reward_type,reward_value,user_coupon_id,wallet_txn_id,status")
    .eq("id", rewardId).maybeSingle();
  if (!reward) throw new AppError(404, "not_found", "奖励记录不存在");
  if (reward.status !== "AVAILABLE") {
    throw new AppError(409, "state_conflict", "仅已到账奖励可撤销", { status: reward.status });
  }

  if (reward.reward_type === "balance") {
    const res = await changeBalance(supabase, {
      userId: reward.inviter_id, amount: -base(reward.reward_value), txnType: "invite_reward",
      refType: "invite_reward", refId: reward.id, idemKey: `invite:revoke:${reward.id}`,
      remark: `邀请奖励撤销冲正：${reason || "未填写"}`, reversalOf: reward.wallet_txn_id,
    });
    if (!res.ok && res.reason !== "duplicated") {
      throw new AppError(409, "revoke_failed", "撤销失败", { reason: res.reason });
    }
  } else if (reward.reward_type === "coin") {
    const res = await revokeInviteCoin(supabase, {
      userId: reward.inviter_id, amount: base(reward.reward_value), rewardId: reward.id,
    });
    if (!res.ok && res.reason !== "duplicated") {
      throw new AppError(409, "revoke_failed", "金币撤销失败", { reason: res.reason });
    }
  } else if (reward.user_coupon_id) {
    const { data: hit } = await supabase.from("user_coupons")
      .update({ status: "REVOKED", updated_at: nowIso() })
      .eq("id", reward.user_coupon_id).eq("status", "UNUSED").select("id");
    if (!hit?.length) throw new AppError(409, "revoke_failed", "券已使用或状态已变化，不可撤销");
  }

  const { data: cas } = await supabase.from("invite_rewards")
    .update({ status: "REVOKED", updated_at: nowIso() })
    .eq("id", reward.id).eq("status", "AVAILABLE").select("id");
  if (!cas?.length) throw new AppError(409, "state_conflict", "奖励状态已变化");
  await writeAudit(supabase, {
    adminId: actor.id, action: "invite.reward.revoke", targetType: "invite_reward", targetId: reward.id,
    detail: { inviter_id: reward.inviter_id, trigger_type: reward.trigger_type, reason },
    ip: request.headers.get("x-forwarded-for"),
  });
  return { revoked: true, reward_id: reward.id, reward_type: reward.reward_type };
}

// —— CY3 规则保存：写 site_config("invite_rules")，只约束后续发放 ——
export async function adminSaveInviteRule(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "invite.manage");
  const rules = validateInviteRules(body.invite_rules);
  await saveConfigKeys(supabase, actor.id, { invite_rules: rules });
  await writeAudit(supabase, {
    adminId: actor.id, action: "invite.rule.save", targetType: "site_config", targetId: null,
    detail: {
      enabled: [rules.first_register.enabled, rules.first_order.enabled, rules.first_recharge.enabled],
      reward_types: [rules.first_register.reward_type, rules.first_order.reward_type, rules.first_recharge.reward_type],
    },
    ip: request.headers.get("x-forwarded-for"),
  });
  return rules;
}
