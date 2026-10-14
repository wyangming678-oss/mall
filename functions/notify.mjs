// 站内消息（文档A §28 notifications / 文档B §9 无状态机、read_at 一次性置位 / 文档C NT1）
// 通知是状态机的副作用：由函数内联发出，调用方无法抑制（文档C §九.5）
import { AppError } from "./errors.mjs";
import { nowIso, pageParams, pageResult, vBool, vUuid, countRows } from "./validate.mjs";

export const MSG_TYPES = [
  "order_paid",
  "order_timeout",
  "order_shipped",
  "order_completed",
  "refund_applied",
  "refund_rejected",
  "refund_completed",
  "invite_reward",
  "recharge_credited",
  "vip_expired", // 整体逻辑 §五：VIP 到期 = EXPIRED + 通知（文档B §9 九类词表的补充项）
  "announcement", // M4 公告接入后复用本表，但不计入未读红点（文档B §9）
  "coin_order_reward", // 文档F §八：收货返币到账
  "coin_redeem_done", // 文档F §八：兑换成功（券/实物发货）
  "coin_redeem_vip", // 文档P §3：权益（会员时长）兑换成功，权益已到账
  "invoice_applied", // A9：发票申请已提交
  "invoice_issued", // A9：后台开具发票
  "invoice_voided", // A9：后台作废发票申请
  "withdraw_applied", // 文档O：提现申请已受理（待人工打款）
  "withdraw_completed", // 文档O：后台标记线下已打款
  "withdraw_rejected", // 文档O：提现驳回/自助撤销，余额已退回
  "installment_started", // 文档N D1：分期首付确认，订单生效进入 INSTALLMENT_ACTIVE
  "installment_settled", // 文档N：分期逐期缴清或提前结清，status_payment 翻 PAID
];

const COLS = "id,msg_type,title,content,ref_type,ref_id,read_at,created_at";
const DOT_EXCLUDED = ["announcement"];

// 写入一条消息。失败只回报不抛错：通知不得反过来中断状态机主流程与其补偿链。
export async function emit(supabase, { userId, msgType, title, content, refType = null, refId = null }) {
  if (!userId || !MSG_TYPES.includes(msgType)) return { emitted: false, reason: "invalid" };
  const { error } = await supabase.from("notifications").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    msg_type: msgType,
    title: String(title).slice(0, 60),
    content: String(content).slice(0, 200),
    ref_type: refType,
    ref_id: refId ?? null,
    read_at: null,
    created_at: nowIso(),
  });
  return error ? { emitted: false, reason: "insert_failed" } : { emitted: true, msg_type: msgType };
}

// 红点口径：公告类已读/未读都不占位（文档B §9）
export async function unreadCount(supabase, userId) {
  return countRows(supabase.from("notifications").select("id", { count: "exact" })
    .eq("user_id", userId).is("read_at", null).neq("msg_type", DOT_EXCLUDED[0]));
}

// —— NT1 GET /app/notify/list（未读优先展示由前端按 unread 字段分区）——
export async function notifyList(supabase, principal, query) {
  const { offset, limit } = pageParams(query);
  const unreadOnly = query?.unread === "1" || query?.unread === "true";
  let q = supabase.from("notifications").select(COLS)
    .eq("user_id", principal.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit);
  if (unreadOnly) q = q.is("read_at", null);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = (data ?? []).map((r) => ({ ...r, unread: r.read_at === null }));
  return { ...pageResult(rows, offset, limit), unread_count: await unreadCount(supabase, principal.id) };
}

// —— NT1 POST /app/notify/read [I]：id 单条 / all 批量，read_at 一次性置位 ——
export async function notifyRead(supabase, principal, body) {
  const now = nowIso();
  if (vBool(body.all ?? false, "all")) {
    const { data } = await supabase.from("notifications").update({ read_at: now })
      .eq("user_id", principal.id).is("read_at", null).select("id");
    const ids = (data ?? []).map((r) => r.id);
    return { scope: "all", read_ids: ids, marked: ids.length };
  }
  const id = vUuid(body.id, "id");
  const { data: flipped } = await supabase.from("notifications").update({ read_at: now })
    .eq("id", id).eq("user_id", principal.id).is("read_at", null).select("id");
  if (flipped?.length) return { scope: "one", read_ids: flipped.map((r) => r.id), marked: 1, already_read: false };
  // 0 行：要么不是本人的消息（404），要么早已读过（幂等回放）
  const { data: mine } = await supabase.from("notifications").select("id")
    .eq("id", id).eq("user_id", principal.id).maybeSingle();
  if (!mine) throw new AppError(404, "not_found", "消息不存在");
  return { scope: "one", read_ids: [], marked: 0, already_read: true };
}
