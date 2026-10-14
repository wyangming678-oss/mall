// HB1 到期任务（文档B §12 T1–T8 中已建表的部分；文档C §八）
// 两种触发：浏览器惰性心跳（tasksTick）与外部调度器（tasksTickSystem，见 deploy/deno-deploy.ts 的 Deno.cron）。
// 每任务限量 50 行、逐行 CAS 认领（0 行=已被他人处理）、单行失败不影响批次、吞错保请求。
import { AppError } from "./errors.mjs";
import { getMergedConfig } from "./config.mjs";
import { applyStockChange } from "./inventory.mjs";
import { REVIEW_SLOT_TTL_MS } from "./payments.mjs";
import { settleComplete } from "./order_state.mjs";
import { cancelOrder } from "./orders.mjs";
import { taskExpireCoupons } from "./coupons.mjs";
import { settlePendingRewards } from "./invite.mjs";
import { continueRefund, REFUND_RESIDUAL_MS } from "./refunds.mjs";
import { taskExpireVips } from "./vip.mjs";
import { taskExpireAnnouncements } from "./announcements.mjs";
import { recordTaskHealth, AUTO_CONFIRM_DAYS, TICK_MIN_INTERVAL_MS } from "./stats.mjs";

const SCAN_LIMIT = 50;
const RECONCILE_WINDOW_DAYS = 7;

const iso = (ms) => new Date(ms).toISOString();

// —— T1 超时未付取消（PENDING_REVIEW 豁免）——
async function taskTimeoutCancel(supabase, nowMs) {
  const { data: rows } = await supabase.from("orders")
    .select("id,user_id,status_order,status_payment,status_shipping,payment_deadline")
    .eq("status_order", "PENDING_PAYMENT").neq("status_payment", "PENDING_REVIEW")
    .lte("payment_deadline", iso(nowMs)).order("payment_deadline", { ascending: true }).limit(SCAN_LIMIT);
  let done = 0;
  for (const row of rows ?? []) {
    try {
      const res = await cancelOrder(supabase, {
        order: row, reason: "支付超时自动取消", operatorType: "system", operatorId: null,
      });
      if (res.cancelled) done += 1;
    } catch { /* 单行失败不影响批次 */ }
  }
  return done;
}

// —— T2 发货后自动确认收货 ——
async function taskAutoConfirm(supabase, nowMs) {
  const cutoff = iso(nowMs - AUTO_CONFIRM_DAYS * 86400 * 1000);
  const { data: rows } = await supabase.from("orders")
    .select("id,user_id,status_order,status_payment,status_shipping,shipped_at")
    .eq("status_order", "SHIPPED").eq("status_shipping", "SHIPPED").lte("shipped_at", cutoff)
    .order("shipped_at", { ascending: true }).limit(SCAN_LIMIT);
  let done = 0;
  for (const row of rows ?? []) {
    try {
      const res = await settleComplete(supabase, {
        order: row, operatorType: "system", operatorId: null, reason: `发货满 ${AUTO_CONFIRM_DAYS} 天自动确认`,
      });
      if (res.completed) done += 1;
    } catch { /* ignore */ }
  }
  return done;
}

// —— T3 取消残留对账：已 CANCELLED 但 freeze 未 unfreeze 的库存补退 ——
async function taskReconcileCancel(supabase) {
  const { data: cancelled } = await supabase.from("orders")
    .select("id").eq("status_order", "CANCELLED")
    .gte("cancelled_at", iso(Date.now() - RECONCILE_WINDOW_DAYS * 86400 * 1000))
    .order("cancelled_at", { ascending: false }).limit(SCAN_LIMIT);
  const ids = (cancelled ?? []).map((o) => o.id);
  if (!ids.length) return 0;
  const [{ data: items }, { data: logs }] = await Promise.all([
    supabase.from("order_items").select("order_id,sku_id,quantity").in("order_id", ids),
    supabase.from("inventory_logs").select("reference_id,sku_id,change_type,quantity").in("reference_id", ids),
  ]);
  const frozen = new Map(); // `${order}|${sku}` → 净值
  for (const log of logs ?? []) {
    if (log.change_type !== "freeze" && log.change_type !== "unfreeze") continue;
    const key = `${log.reference_id}|${log.sku_id}`;
    const delta = log.change_type === "freeze" ? Number(log.quantity) : -Number(log.quantity);
    frozen.set(key, (frozen.get(key) ?? 0) + delta);
  }
  let repaired = 0;
  for (const it of items ?? []) {
    const key = `${it.order_id}|${it.sku_id}`;
    const residual = Math.min(frozen.get(key) ?? 0, Number(it.quantity));
    if (residual <= 0) continue;
    frozen.set(key, 0);
    const res = await applyStockChange(supabase, {
      skuId: it.sku_id, changeType: "unfreeze", quantity: residual,
      referenceType: "order", referenceId: it.order_id, operator: "system", reason: "取消残留对账补退",
    });
    if (res.ok) repaired += 1;
  }
  return repaired;
}

// —— T5 退款残留重放（文档B §5 ⑤：APPROVED/PROCESSING 卡住的单子按幂等步骤续跑）——
const REFUND_COLS = "id,order_id,user_id,amount_base,refund_split,refund_method,lines,status,wallet_txn_id,created_at,updated_at";

async function taskRefundResidual(supabase, nowMs) {
  const { data: rows } = await supabase.from("refunds")
    .select(REFUND_COLS).in("status", ["APPROVED", "PROCESSING"])
    .lte("updated_at", iso(nowMs - REFUND_RESIDUAL_MS))
    .order("updated_at", { ascending: true }).limit(SCAN_LIMIT);
  let done = 0;
  for (const row of rows ?? []) {
    try {
      const res = await continueRefund(supabase, row, { operatorId: null, operatorType: "system" });
      if (res.completed) done += 1;
    } catch { /* ignore */ }
  }
  return done;
}

// —— T8 审核位超时释放 ——
async function taskReleaseStaleSlots(supabase, nowMs) {
  const { data: rows } = await supabase.from("proof_review_slot")
    .select("id,order_id,reserved_by,reserved_at").is("released_at", null)
    .lte("reserved_at", iso(nowMs - REVIEW_SLOT_TTL_MS)).limit(SCAN_LIMIT);
  let done = 0;
  for (const row of rows ?? []) {
    const { data: hit } = await supabase.from("proof_review_slot")
      .update({ released_at: iso(nowMs) })
      .eq("id", row.id).eq("reserved_by", row.reserved_by).is("released_at", null).select("id");
    if (hit?.length) done += 1;
  }
  return done;
}

// —— T9 邀请奖励到期结算（文档B §7 PENDING→AVAILABLE 的惰性推进；§12 未列，属本轮补充任务）——
async function taskSettleInviteRewards(supabase, nowMs) {
  const res = await settlePendingRewards(supabase, { nowMs, limit: SCAN_LIMIT });
  return res.granted;
}

// —— HB1 POST /app/tasks/tick（每主体 60s 节流，服务端记录在会话行）——
export async function tasksTick(supabase, principal) {
  if (!principal.sessionId) throw new AppError(500, "internal_error");
  const { data: session } = await supabase.from("user_sessions")
    .select("id,last_tick_at").eq("id", principal.sessionId).maybeSingle();
  if (!session) throw new AppError(401, "session_expired");
  const nowMs = Date.now();
  const last = session.last_tick_at ? Date.parse(session.last_tick_at) : 0;
  if (nowMs - last < TICK_MIN_INTERVAL_MS) {
    throw new AppError(429, "rate_limited", "心跳过于频繁", {
      retry_after_ms: TICK_MIN_INTERVAL_MS - (nowMs - last),
    });
  }
  // 认领本心跳窗口：CAS 上一毫秒值，0 行说明并发已有一个 tick 抢到
  const claim = session.last_tick_at
    ? await supabase.from("user_sessions").update({ last_tick_at: iso(nowMs) })
      .eq("id", principal.sessionId).eq("last_tick_at", session.last_tick_at).select("id")
    : await supabase.from("user_sessions").update({ last_tick_at: iso(nowMs) })
      .eq("id", principal.sessionId).is("last_tick_at", null).select("id");
  if (!claim.data?.length) {
    throw new AppError(429, "rate_limited", "心跳正在处理中", { retry_after_ms: 1000 });
  }

  return await runTaskBatch(supabase, nowMs, {
    actor_type: principal.type,
    actor_id: principal.type === "admin" ? principal.id : null,
  });
}

// 九个到期任务的批次执行体；T1–T9 的口径、限量与逐行 CAS 认领完全不变。
async function runTaskBatch(supabase, nowMs, actor) {
  // 单任务失败不再中断整批（AN7 需要看到哪条任务挂了）
  const runners = {
    T1: () => taskTimeoutCancel(supabase, nowMs),
    T2: () => taskAutoConfirm(supabase, nowMs),
    T3: () => taskReconcileCancel(supabase),
    T4: () => taskExpireCoupons(supabase, iso(nowMs)),
    T5: () => taskRefundResidual(supabase, nowMs),
    T6: () => taskExpireVips(supabase, nowMs),
    T7: () => taskExpireAnnouncements(supabase, nowMs),
    T8: () => taskReleaseStaleSlots(supabase, nowMs),
    T9: () => taskSettleInviteRewards(supabase, nowMs),
  };
  const started = Date.now();
  const counts = {};
  const durations = {};
  const errors = {};
  const ran = [];
  for (const [code, run] of Object.entries(runners)) {
    const t0 = Date.now();
    try {
      counts[code] = await run();
      ran.push(code);
    } catch (error) {
      counts[code] = 0;
      errors[code] = error?.code ?? "internal_error";
    }
    durations[code] = Date.now() - t0;
  }
  const { configVersion } = await getMergedConfig(supabase);
  try {
    await recordTaskHealth(supabase, {
      ran_at: iso(nowMs), ran_ms: Date.now() - started,
      counts, durations_ms: durations, errors, config_version: configVersion,
      actor_type: actor.actor_type, actor_id: actor.actor_id,
    });
  } catch { /* 落账失败不影响心跳响应 */ }
  return {
    ran,
    counts,
    errors,
    skipped: Object.keys(errors),
    config_version: configVersion,
    server_time: iso(nowMs),
  };
}

// —— 定时触发入口（Deno Cron / 任何外部调度器）——
// 不经 user_sessions：节流与 CAS 认领原本只是负载控制，正确性由 T1–T9 的逐行 CAS 认领保证，
// 因此 cron 与浏览器心跳可并存且重复执行安全。落账 actor_type=system、actor_id=null（stats.mjs 会回落 SYSTEM_ID）。
export async function tasksTickSystem(supabase) {
  return runTaskBatch(supabase, Date.now(), { actor_type: "system", actor_id: null });
}
