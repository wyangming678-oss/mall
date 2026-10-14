// 余额原子序 + 钱包账本（文档B §3.4、文档A §16）：读 balance → CAS(=before 且 >=|Δ|) → 写 wallet_txns
import { AppError, isUniqueViolation } from "./errors.mjs";
import { vInt, nowIso } from "./validate.mjs";

// withdraw=提现扣款（负向，文档O W1）；提现退回复用 refund_in（正向），不新增退回类型
const TXN_TYPES = ["recharge", "consume", "refund_in", "invite_reward", "admin_adjust", "vip_purchase", "unfreeze_back", "withdraw"];
const TXN_AMT_MAX = 999999999999;

export function vAmount(v, field, { min = 1, max = TXN_AMT_MAX } = {}) {
  return vInt(v, field, { min, max });
}

// amount 带符号入账；返回 { ok, txn_id, before, after } | { ok:false, reason }
export async function changeBalance(supabase, {
  userId, amount, txnType, refType, refId = null, idemKey = null, remark = null, reversalOf = null,
}) {
  if (!TXN_TYPES.includes(txnType)) return { ok: false, reason: "bad_type" };
  if (!Number.isSafeInteger(amount) || amount === 0) return { ok: false, reason: "bad_amount" };
  const { data: user } = await supabase.from("users")
    .select("id,balance").eq("id", userId).is("deleted_at", null).eq("status", "active").maybeSingle();
  if (!user) return { ok: false, reason: "not_found" };
  const before = Number(user.balance);
  const after = before + amount;
  if (after < 0) return { ok: false, reason: "insufficient" };
  const now = nowIso();
  const { data: cas } = await supabase.from("users")
    .update({ balance: after, updated_at: now })
    .eq("id", userId).eq("balance", before).gte("balance", amount < 0 ? -amount : 0)
    .select("id");
  if (!cas?.length) return { ok: false, reason: "conflict" };
  const txnId = crypto.randomUUID();
  const { error } = await supabase.from("wallet_txns").insert({
    id: txnId,
    user_id: userId,
    txn_type: txnType,
    amount,
    balance_before: before,
    balance_after: after,
    ref_type: refType,
    ref_id: refId,
    reversal_of: reversalOf ?? null,
    idem_key: idemKey,
    remark,
    created_at: now,
  });
  if (error) {
    // 回滚 CAS：账本不可缺行（原则 4）；idem_key 撞车说明该笔已入账，同样撤销本次增量
    await supabase.from("users")
      .update({ balance: before, updated_at: nowIso() })
      .eq("id", userId).eq("balance", after);
    return { ok: false, reason: isUniqueViolation(error) ? "duplicated" : "log_failed" };
  }
  return { ok: true, txn_id: txnId, before, after };
}

// —— W1 钱包总览（余额 + 账本分页）——
export async function walletOverview(supabase, principal, query) {
  const offset = vInt(query.offset ?? 0, "offset", { min: 0, max: 100000 });
  const limit = 20;
  const { data: user } = await supabase.from("users")
    .select("id,balance,currency_code").eq("id", principal.id).is("deleted_at", null).maybeSingle();
  if (!user) throw new AppError(404, "not_found");
  const { data, error } = await supabase.from("wallet_txns")
    .select("id,txn_type,amount,balance_before,balance_after,ref_type,ref_id,remark,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  return {
    balance: Number(user.balance),
    currency_code: user.currency_code,
    offset,
    limit,
    has_more: rows.length > limit,
    next_offset: rows.length > limit ? offset + limit : null,
    items: rows.slice(0, limit),
  };
}
