// AN6 概览报表 + AN7 任务健康（文档C §六：GMV 口径=已 CONFIRMED 的 order 分项；AN7=T1–T9 最近批次+待处理存量+对账差异）
import { AppError } from "./errors.mjs";
import { requirePrincipal } from "./auth.mjs";
import { loadAdminPermissions, requirePermission } from "./permissions.mjs";
import { REVIEW_SLOT_TTL_MS } from "./payments.mjs";
import { REFUND_RESIDUAL_MS } from "./refunds.mjs";

const DAY_MS = 24 * 3600 * 1000;
// 与 tasks.mjs 的扫描窗口共用同一口径，健康页的 backlog 才等于任务真正会吃下的行数
export const AUTO_CONFIRM_DAYS = 10;
export const TICK_MIN_INTERVAL_MS = 60 * 1000;
export const LOW_STOCK_THRESHOLD = 5;
const STOCK_SCAN_MAX = 100;
const CONFIRM_LOOKBACK_DAYS = 90;
const CONFIRM_SCAN_MAX = 2000;
// site_config 无外键约束，用户心跳触发的批次用系统身份落账（与 chat 系统消息同一常量）
const SYSTEM_ID = "00000000-0000-4000-8000-00000000c0de";
export const TASK_HEALTH_KEY = "task_health";

const ORDER_STATUS = ["PENDING_PAYMENT", "PAID", "SHIPPED", "COMPLETED", "CANCELLED", "REFUNDING", "REFUNDED"];
export const TASK_LABELS = {
  T1: "支付超时自动取消",
  T2: "发货后自动确认收货",
  T3: "取消订单库存残留对账",
  T4: "优惠券到期",
  T5: "退款残留续办",
  T6: "VIP 到期",
  T7: "公告到期下线",
  T8: "审核位超时释放",
  T9: "邀请奖励结算",
};

// 计数走 GET+limit(1)：Sites 网关不为 HEAD 计数回传 Content-Range（见 validate.countRows）
async function countWhere(supabase, table, apply) {
  const builder = supabase.from(table).select("id", { count: "exact" });
  const { count } = await apply(builder).limit(1);
  return Number.isSafeInteger(count) ? count : 0;
}

async function loadDashboardActor(supabase, request) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "dashboard.read");
  return actor;
}

// —— AN6 GET /app/admin/stats ——
export async function adminStats(supabase, request) {
  await loadDashboardActor(supabase, request);
  const nowMs = Date.now();
  const since = (days) => new Date(nowMs - days * DAY_MS).toISOString();

  // GMV 按确认时刻（reviewed_at）落窗；缺 reviewed_at 的历史行退回 created_at
  const { data: confirmed, error } = await supabase.from("payments")
    .select("id,target_id,amount_base,amount_currency,currency_code,reviewed_at,created_at")
    .eq("status", "CONFIRMED").eq("target_type", "order")
    .gte("created_at", since(CONFIRM_LOOKBACK_DAYS))
    .order("created_at", { ascending: false }).limit(CONFIRM_SCAN_MAX);
  if (error) throw new AppError(500, "internal_error");
  const rows = confirmed ?? [];
  const at = (r) => Date.parse(r.reviewed_at ?? r.created_at ?? "");
  const sumSince = (days) => rows.reduce((acc, r) => {
    const t = at(r);
    return Number.isSafeInteger(t) && t >= nowMs - days * DAY_MS ? acc + Number(r.amount_base ?? 0) : acc;
  }, 0);
  const currency = {};
  for (const r of rows) {
    const t = at(r);
    if (!Number.isSafeInteger(t) || t < nowMs - 30 * DAY_MS) continue;
    const code = r.currency_code ?? "BASE";
    currency[code] = (currency[code] ?? 0) + Number(r.amount_currency ?? 0);
  }

  const funnel = [];
  for (const status of ORDER_STATUS) {
    funnel.push({ status, count: await countWhere(supabase, "orders", (q) => q.eq("status_order", status)) });
  }

  // review_status 存小写（payments.mjs 统一写 pending/approved/rejected）
  const proofs = await countWhere(supabase, "payment_proofs", (q) => q.eq("review_status", "pending"));
  const refundsOpen = await countWhere(supabase, "refunds", (q) => q.in("status", ["PENDING", "APPROVED", "PROCESSING"]));
  const chatWaiting = await countWhere(supabase, "chat_sessions", (q) => q.eq("status", "waiting"));
  const chatActive = await countWhere(supabase, "chat_sessions", (q) => q.eq("status", "active"));
  const invitePending = await countWhere(supabase, "invite_rewards", (q) => q.eq("status", "PENDING"));

  const { data: lowSkus } = await supabase.from("product_skus")
    .select("id,product_id,sku_code,spec_name,available_stock")
    .eq("status", "on").is("deleted_at", null).lte("available_stock", LOW_STOCK_THRESHOLD)
    .order("available_stock", { ascending: true }).limit(STOCK_SCAN_MAX);
  const productIds = [...new Set((lowSkus ?? []).map((s) => s.product_id))];
  const { data: titles } = productIds.length
    ? await supabase.from("products").select("id,title").in("id", productIds)
    : { data: [] };
  const titleOf = new Map((titles ?? []).map((p) => [p.id, p.title]));

  return {
    server_time: new Date(nowMs).toISOString(),
    gmv: {
      basis: "payments.status=CONFIRMED ∧ target_type=order",
      window_days: CONFIRM_LOOKBACK_DAYS,
      today_base: sumSince(1),
      d7_base: sumSince(7),
      d30_base: sumSince(30),
      total_base: rows.reduce((acc, r) => acc + Number(r.amount_base ?? 0), 0),
      confirmed_count: rows.length,
      truncated: rows.length >= CONFIRM_SCAN_MAX,
    },
    currency_totals_30d: Object.entries(currency).map(([currency_code, amount_currency]) => ({
      currency_code, amount_currency,
    })),
    order_funnel: funnel,
    pending: {
      proofs, refunds_open: refundsOpen, chat_waiting: chatWaiting,
      chat_active: chatActive, invite_rewards: invitePending,
    },
    stock_alert: {
      threshold: LOW_STOCK_THRESHOLD,
      items: (lowSkus ?? []).map((s) => ({
        sku_id: s.id, product_id: s.product_id, product_title: titleOf.get(s.product_id) ?? null,
        sku_code: s.sku_code, spec_name: s.spec_name, available_stock: s.available_stock,
      })),
    },
    totals: {
      users: await countWhere(supabase, "users", (q) => q.is("deleted_at", null)),
      products_on_sale: await countWhere(supabase, "products", (q) => q.eq("status", "on").is("deleted_at", null)),
      coupons_unused: await countWhere(supabase, "user_coupons", (q) => q.eq("status", "UNUSED")),
      orders_all: await countWhere(supabase, "orders", (q) => q),
    },
  };
}

// —— HB1 心跳落账（tasks.mjs 每批次调用；site_config 是 jsonb blob，无需迁移） ——
export async function recordTaskHealth(supabase, summary) {
  const now = new Date().toISOString();
  const { data: existing } = await supabase.from("site_config")
    .select("id").eq("config_key", TASK_HEALTH_KEY).maybeSingle();
  if (existing) {
    await supabase.from("site_config").update({ config_value: summary, updated_at: now })
      .eq("id", existing.id);
    return;
  }
  await supabase.from("site_config").insert({
    id: crypto.randomUUID(), config_key: TASK_HEALTH_KEY, config_value: summary,
    updated_by: summary.actor_id ?? SYSTEM_ID, created_at: now, updated_at: now,
  });
}

// —— AN7 GET /app/admin/tasks/health ——
export async function tasksHealth(supabase, request) {
  await loadDashboardActor(supabase, request);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  const { data: stored } = await supabase.from("site_config")
    .select("config_value,updated_at").eq("config_key", TASK_HEALTH_KEY).maybeSingle();
  const last = stored?.config_value ?? null;

  const backlog = {
    T1: await countWhere(supabase, "orders", (q) => q.eq("status_order", "PENDING_PAYMENT")
      .neq("status_payment", "PENDING_REVIEW").lte("payment_deadline", now)),
    T2: await countWhere(supabase, "orders", (q) => q.eq("status_order", "SHIPPED")
      .eq("status_shipping", "SHIPPED").lte("shipped_at", new Date(nowMs - AUTO_CONFIRM_DAYS * DAY_MS).toISOString())),
    T4: await countWhere(supabase, "user_coupons", (q) => q.eq("status", "UNUSED").lte("expire_at", now)),
    T5: await countWhere(supabase, "refunds", (q) => q.in("status", ["APPROVED", "PROCESSING"])
      .lte("updated_at", new Date(nowMs - REFUND_RESIDUAL_MS).toISOString())),
    T6: await countWhere(supabase, "user_vips", (q) => q.eq("status", "active").lte("expire_at", now)),
    T7: await countWhere(supabase, "announcements", (q) => q.eq("status", "published").lte("expire_at", now)),
    T8: await countWhere(supabase, "proof_review_slot", (q) => q.is("released_at", null)
      .lte("reserved_at", new Date(nowMs - REVIEW_SLOT_TTL_MS).toISOString())),
    T9: await countWhere(supabase, "invite_rewards", (q) => q.eq("status", "PENDING")),
  };
  // T3 的存量 = 已取消订单仍留有冻结库存
  const frozen = await countWhere(supabase, "product_skus", (q) => q.gt("frozen_stock", 0));
  const pendingPay = await countWhere(supabase, "orders", (q) => q.eq("status_order", "PENDING_PAYMENT"));
  backlog.T3 = pendingPay === 0 ? frozen : 0;

  const refundingOrders = await countWhere(supabase, "orders", (q) => q.eq("status_order", "REFUNDING"));
  const liveRefunds = await countWhere(supabase, "refunds", (q) => q.in("status", ["PENDING", "APPROVED", "PROCESSING"]));

  return {
    server_time: now,
    tick_min_interval_ms: TICK_MIN_INTERVAL_MS,
    last_batch: last,
    tasks: Object.keys(TASK_LABELS).map((code) => ({
      code, label: TASK_LABELS[code],
      backlog: backlog[code] ?? null,
      last_count: Number.isSafeInteger(Number(last?.counts?.[code])) ? Number(last.counts[code]) : null,
      last_error: last?.errors?.[code] ?? null,
    })),
    recon: {
      frozen_sku_rows: frozen,
      pending_payment_orders: pendingPay,
      // 无待付订单却仍有冻结库存 → T3 该吃到行数，属对账差异
      orphan_freeze: pendingPay === 0 && frozen > 0,
      refunding_orders: refundingOrders,
      live_refunds: liveRefunds,
      // 一单一退：REFUNDING 订单数应等于在途退款单数
      refund_state_mismatch: refundingOrders !== liveRefunds,
    },
  };
}
